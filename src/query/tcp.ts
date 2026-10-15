import { connect } from "node:net";
import { StreamTransport } from "./stream.js";

/** Where a raw ServerQuery listens. */
export interface TcpOptions {
  /** The server's host. */
  readonly host: string;
  /** The raw query port; 10011 by default. */
  readonly port?: number | undefined;
  /** Abandons the connection attempt. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Open a raw ServerQuery connection (`node:net`, 10011 by default).
 *
 * Resolves once the socket is connected; the server's banner is read and
 * dropped by the transport.
 */
export function connectTcp(options: TcpOptions): Promise<StreamTransport> {
  const { host, port = 10011, signal } = options;
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, signal });
    // Whole lines are sent, and a query's answers are small: no waiting to coalesce.
    socket.setNoDelay(true);
    const failed = (error: Error): void => reject(error);
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      resolve(new StreamTransport(socket));
    });
  });
}
