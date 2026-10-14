/**
 * File transfer data.
 *
 * Negotiating a transfer is a command (`initFileUpload`, `initFileDownload`);
 * the bytes then go over a separate TCP connection to the server's file
 * transfer port, opened with the key the negotiation returned.
 */

import { connect } from "node:net";
import { pipeline } from "node:stream/promises";
import { Transform, type Duplex, type Readable, type Writable } from "node:stream";
import type { FileUploadInfo, FileDownloadInfo } from "@honeybbq/teamspeak-core";
import type { FileTransferSocketFactory } from "./types.js";
import { FileTransferError } from "./errors.js";
import { callHook } from "./hooks.js";
import { joinHostPort } from "./address.js";

/** How long dialing may take before it fails, unless a signal says otherwise. */
const DIAL_TIMEOUT_MS = 10_000;

/** How many bytes move between two calls of the `progress` hook, at least. */
const PROGRESS_STEP_BYTES = 64 * 1024;

/** Where a failed transfer failed. */
export type FileTransferStage = "dial" | "transfer";

/** The file transfer port is about to be dialled. */
export interface FileTransferDialStartInfo {
  /** The `host:port` being dialled. */
  readonly addr: string;
}

/** The connection is open and the transfer key has been sent. */
export interface FileTransferDialDoneInfo {
  /** The `host:port` dialled. */
  readonly addr: string;
  /** The local socket's `host:port`; empty when the socket does not say. */
  readonly localAddr: string;
  /** Milliseconds since `dialStart`. */
  readonly durationMs: number;
}

/** Data has moved. */
export interface FileTransferProgressInfo {
  /** The bytes moved so far. */
  readonly bytes: number;
  /** The size the negotiation gave; 0 when it is not known, as for an upload. */
  readonly total: number;
}

/** The transfer succeeded. */
export interface FileTransferDoneInfo {
  /** The bytes moved. */
  readonly bytes: number;
  /** Milliseconds since `dialStart`. */
  readonly durationMs: number;
}

/** The transfer failed. */
export interface FileTransferFailedInfo {
  /** Why: the error the transfer function rejects with. */
  readonly error: unknown;
  /** The bytes moved before it failed. */
  readonly bytes: number;
  /** Milliseconds since `dialStart`. */
  readonly durationMs: number;
  /** Whether the failure came while dialling or while the data moved. */
  readonly stage: FileTransferStage;
}

/**
 * Hooks that observe one file transfer. Every hook is optional, and none ever
 * sees the transfer key.
 *
 * A hook runs synchronously on the task doing the transfer, and its return
 * value is ignored: a returned promise is not awaited. A hook that throws, or
 * whose promise rejects, is reported the way a throwing event listener is, and
 * the transfer goes on. Keep hooks quick.
 *
 * A call of `uploadFileData` or `downloadFileData` ends with exactly one of
 * `done` and `failed`; `dialFileTransfer` on its own reports `dialStart`, then
 * `dialDone` or `failed` with the stage `"dial"`.
 */
export interface FileTransferTrace {
  /** Before the file transfer port is dialled. */
  readonly dialStart?: (info: FileTransferDialStartInfo) => void;
  /** When the connection is open and the transfer key is sent. */
  readonly dialDone?: (info: FileTransferDialDoneInfo) => void;
  /** While data moves, at most once per 64 KiB, and once more at the end with the final count. */
  readonly progress?: (info: FileTransferProgressInfo) => void;
  /** When the transfer function is about to resolve. */
  readonly done?: (info: FileTransferDoneInfo) => void;
  /** When the transfer function is about to reject, a failed dial included. */
  readonly failed?: (info: FileTransferFailedInfo) => void;
}

/** Options for a file transfer. */
export interface FileTransferOptions {
  /** Abandons the transfer; it then rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Opens the connection instead of a direct TCP dial, to route the transfer
   * through a proxy or tunnel.
   */
  readonly socketFactory?: FileTransferSocketFactory | undefined;
  /**
   * Hooks called at each milestone of this transfer. The object is copied when
   * the call starts. See {@link FileTransferTrace}.
   */
  readonly trace?: FileTransferTrace | undefined;
}

/** What a transfer's hooks share: the trace, when the call began, and what has moved. */
interface TransferTrace {
  readonly trace: FileTransferTrace | undefined;
  readonly startedAt: number;
  bytes: number;
}

function newTransferTrace(options: FileTransferOptions): TransferTrace {
  return {
    trace: options.trace === undefined ? undefined : { ...options.trace },
    startedAt: performance.now(),
    bytes: 0,
  };
}

function reportFailed(t: TransferTrace, error: unknown, stage: FileTransferStage): void {
  callHook(t.trace?.failed, t.trace, () => ({
    error,
    bytes: t.bytes,
    durationMs: performance.now() - t.startedAt,
    stage,
  }));
}

/**
 * Open a connection to the file transfer port and send the transfer key.
 * The caller owns the returned stream and must end or destroy it.
 */
export async function dialFileTransfer(
  host: string,
  port: number,
  key: string,
  options: FileTransferOptions = {},
): Promise<Duplex> {
  const t = newTransferTrace(options);
  try {
    return await dial(host, port, key, options, t);
  } catch (error) {
    reportFailed(t, error, "dial");
    throw error;
  }
}

async function dial(
  host: string,
  port: number,
  key: string,
  options: FileTransferOptions,
  t: TransferTrace,
): Promise<Duplex> {
  const { signal, socketFactory } = options;
  const addr = joinHostPort(host, String(port));
  callHook(t.trace?.dialStart, t.trace, () => ({ addr }));
  signal?.throwIfAborted();
  const socket: Duplex = socketFactory ? socketFactory(host, port) : connect({ host, port });

  // Until the caller takes the stream over, its errors are this function's to
  // report: a stream's unhandled `error` event takes the process down.
  const swallow = (): void => {};
  socket.on("error", swallow);
  try {
    await connected(socket, signal);
    await new Promise<void>((resolve, reject) => {
      socket.write(key, (err) =>
        err
          ? reject(
              new FileTransferError(`failed to send transfer key: ${err.message}`, { cause: err }),
            )
          : resolve(),
      );
    });
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    socket.off("error", swallow);
  }
  callHook(t.trace?.dialDone, t.trace, () => {
    let localAddr = "";
    const local = socket as { localAddress?: unknown; localPort?: unknown };
    if (typeof local.localAddress === "string" && typeof local.localPort === "number") {
      localAddr = joinHostPort(local.localAddress, String(local.localPort));
    }
    return { addr, localAddr, durationMs: performance.now() - t.startedAt };
  });
  return socket;
}

/**
 * A pass-through that counts what moves and reports it to `progress`. It never
 * fails the pipeline: a hook's error is reported, not thrown.
 */
function countingStream(t: TransferTrace, total: number): Transform {
  let reported = 0;
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      t.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (t.bytes - reported >= PROGRESS_STEP_BYTES) {
        reported = t.bytes;
        const bytes = t.bytes;
        callHook(t.trace?.progress, t.trace, () => ({ bytes, total }));
      }
      callback(null, chunk);
    },
  });
}

/** Run a transfer's data phase, and report how the whole call ended. */
async function transfer(
  host: string,
  port: number,
  key: string,
  total: number,
  options: FileTransferOptions,
  move: (
    socket: Duplex,
    counter: Transform,
    pipeOptions: { signal?: AbortSignal },
  ) => Promise<void>,
): Promise<void> {
  const t = newTransferTrace(options);
  let socket: Duplex;
  try {
    socket = await dial(host, port, key, options, t);
  } catch (error) {
    reportFailed(t, error, "dial");
    throw error;
  }
  try {
    await move(socket, countingStream(t, total), options.signal ? { signal: options.signal } : {});
  } catch (error) {
    reportFailed(t, error, "transfer");
    throw error;
  }
  const bytes = t.bytes;
  callHook(t.trace?.progress, t.trace, () => ({ bytes, total }));
  callHook(t.trace?.done, t.trace, () => ({
    bytes,
    durationMs: performance.now() - t.startedAt,
  }));
}

/**
 * Wait for a stream to be connected. A `node:net` socket says so with
 * `connect`; a stream from elsewhere that is already writable is taken as
 * connected.
 */
function connected(socket: Duplex, signal: AbortSignal | undefined): Promise<void> {
  const pending = (socket as { pending?: boolean }).pending;
  if (pending === false || (pending === undefined && socket.writable)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timeout = AbortSignal.timeout(DIAL_TIMEOUT_MS);
    const done = (error?: unknown): void => {
      socket.off("connect", onConnect);
      socket.off("ready", onConnect);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      timeout.removeEventListener("abort", onTimeout);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onConnect = (): void => done();
    const onError = (error: Error): void =>
      done(
        new FileTransferError(`file transfer connection failed: ${error.message}`, {
          cause: error,
        }),
      );
    const onAbort = (): void => done(signal!.reason);
    const onTimeout = (): void => done(new FileTransferError("file transfer connection timed out"));
    socket.once("connect", onConnect);
    socket.once("ready", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout.addEventListener("abort", onTimeout, { once: true });
  });
}

/** Upload `data` over a negotiated transfer. Resolves once every byte is sent. */
export function uploadFileData(
  host: string,
  info: FileUploadInfo,
  data: Readable,
  options: FileTransferOptions = {},
): Promise<void> {
  return transfer(
    host,
    info.port,
    info.fileTransferKey,
    0,
    options,
    (socket, counter, pipeOptions) => pipeline(data, counter, socket, pipeOptions),
  );
}

/** Download a negotiated transfer into `dest`. Resolves once the file is written. */
export function downloadFileData(
  host: string,
  info: FileDownloadInfo,
  dest: Writable,
  options: FileTransferOptions = {},
): Promise<void> {
  return transfer(
    host,
    info.port,
    info.fileTransferKey,
    Number(info.size),
    options,
    (socket, counter, pipeOptions) => pipeline(socket, counter, dest, pipeOptions),
  );
}

export { FileTransferError };
