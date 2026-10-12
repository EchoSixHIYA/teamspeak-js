/** A TS3-escaped string. Obtained only via escape(). */
export type EscapedString = string & { readonly __escaped: unique symbol };

// ---- Middleware types --------------------------------------------------------

export type CommandMiddleware = (
  next: (cmd: string) => Promise<void>,
) => (cmd: string) => Promise<void>;

// ---- Logger interface --------------------------------------------------------

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
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
