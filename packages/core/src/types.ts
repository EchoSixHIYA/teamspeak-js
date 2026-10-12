/** A TS3-escaped string. Obtained only via escape(). */
export type EscapedString = string & { readonly __escaped: unique symbol };

// ---- Middleware types --------------------------------------------------------

/**
 * Wraps the sending of every command line, outermost first: it may observe,
 * alter or drop a command. It sees the line as sent, so it must not log it
 * whole — its parameters can carry password hashes and privilege keys.
 */
export type CommandMiddleware = (
  next: (cmd: string) => Promise<void>,
) => (cmd: string) => Promise<void>;

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
  readonly clientFileTransferID: number;
  /** The server's id for the transfer. */
  readonly serverFileTransferID: number;
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
  readonly clientFileTransferID: number;
  /** The server's id for the transfer. */
  readonly serverFileTransferID: number;
  /** The file transfer port to dial. */
  readonly port: number;
}
