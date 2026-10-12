/**
 * File transfer data.
 *
 * Negotiating a transfer is a command (`initFileUpload`, `initFileDownload`);
 * the bytes then go over a separate TCP connection to the server's file
 * transfer port, opened with the key the negotiation returned.
 */

import { connect } from "node:net";
import { pipeline } from "node:stream/promises";
import type { Duplex, Readable, Writable } from "node:stream";
import type { FileUploadInfo, FileDownloadInfo } from "@honeybbq/teamspeak-core";
import type { FileTransferSocketFactory } from "./types.js";
import { FileTransferError } from "./errors.js";

/** How long dialing may take before it fails, unless a signal says otherwise. */
const DIAL_TIMEOUT_MS = 10_000;

/** Options for a file transfer. */
export interface FileTransferOptions {
  /** Abandons the transfer; it then rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Opens the connection instead of a direct TCP dial, to route the transfer
   * through a proxy or tunnel.
   */
  readonly socketFactory?: FileTransferSocketFactory | undefined;
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
  const { signal, socketFactory } = options;
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
  return socket;
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
export async function uploadFileData(
  host: string,
  info: FileUploadInfo,
  data: Readable,
  options: FileTransferOptions = {},
): Promise<void> {
  const socket = await dialFileTransfer(host, info.port, info.fileTransferKey, options);
  await pipeline(data, socket, options.signal ? { signal: options.signal } : {});
}

/** Download a negotiated transfer into `dest`. Resolves once the file is written. */
export async function downloadFileData(
  host: string,
  info: FileDownloadInfo,
  dest: Writable,
  options: FileTransferOptions = {},
): Promise<void> {
  const socket = await dialFileTransfer(host, info.port, info.fileTransferKey, options);
  await pipeline(socket, dest, options.signal ? { signal: options.signal } : {});
}

export { FileTransferError };
