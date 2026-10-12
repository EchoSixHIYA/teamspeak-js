import type { ClientFileTransferID, ServerFileTransferID } from "./command/ids.js";
import type { CommandExecutor } from "./command/request.js";

// ---- Middleware types --------------------------------------------------------

/**
 * Wraps the typed command layer, outermost first: it sees each request — the
 * command's name and its parameters, passwords still in plain text — with its
 * options, and returns the rows that answer it, or throws. So it can observe,
 * time, retry, or answer a command itself without sending it.
 *
 * Only the typed commands, which reach the client through `send`, pass
 * through it. Raw lines sent with `exec` or `execNoWait` and the client's own
 * handshake-time commands do not. A request's parameters can hold passwords
 * and privilege keys, so a middleware must not log them whole.
 */
export type CommandMiddleware = (next: CommandExecutor["send"]) => CommandExecutor["send"];

// ---- Logger interface --------------------------------------------------------

/**
 * Where the SDK logs. `console` is one; so is a pino or winston logger. The
 * first argument is the message, the rest structured details.
 */
export interface Logger {
  /** Detail for debugging the protocol; never the content of a command. */
  debug(msg: string, ...args: unknown[]): void;
  /** Connection lifecycle: connecting, connected, reconnecting. */
  info(msg: string, ...args: unknown[]): void;
  /** Something went wrong and was recovered from, or will be retried. */
  warn(msg: string, ...args: unknown[]): void;
  /** Something went wrong that the SDK could not report as an error to a caller. */
  error(msg: string, ...args: unknown[]): void;
}

/** A no-op logger that discards all messages. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** A console-backed logger. */
export const consoleLogger: Logger = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/** A negotiated upload, as `initFileUpload` returns it: what to dial and send. */
export interface FileUploadInfo {
  /** The key that identifies the transfer on the file transfer connection. */
  readonly fileTransferKey: string;
  /** Where to resume from, in bytes; 0 for a fresh upload. */
  readonly seekPosition: bigint;
  /** The client's id for the transfer. */
  readonly clientFileTransferID: ClientFileTransferID;
  /** The server's id for the transfer. */
  readonly serverFileTransferID: ServerFileTransferID;
  /** The file transfer port to dial. */
  readonly port: number;
}

/** A negotiated download, as `initFileDownload` returns it: what to dial and receive. */
export interface FileDownloadInfo {
  /** The key that identifies the transfer on the file transfer connection. */
  readonly fileTransferKey: string;
  /** How many bytes the server will send. */
  readonly size: bigint;
  /** The client's id for the transfer. */
  readonly clientFileTransferID: ClientFileTransferID;
  /** The server's id for the transfer. */
  readonly serverFileTransferID: ServerFileTransferID;
  /** The file transfer port to dial. */
  readonly port: number;
}
