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

export interface FileUploadInfo {
  fileTransferKey: string;
  seekPosition: bigint;
  clientFileTransferID: number;
  serverFileTransferID: number;
  port: number;
}

export interface FileDownloadInfo {
  fileTransferKey: string;
  size: bigint;
  clientFileTransferID: number;
  serverFileTransferID: number;
  port: number;
}
