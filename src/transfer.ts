import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { FileUploadInfo, FileDownloadInfo, FileTransferSocketFactory } from "./types.js";
import { FileTransferError } from "./errors.js";

/**
 * Creates the TCP socket the file transfer connection runs over.
 *
 * Receives the host and port to dial and returns an unconnected socket; the
 * transfer layer performs the ftkey handshake itself. Supplying one lets an
 * application route file transfers through a proxy or tunnel, which is the
 * counterpart of the `socketFactory` option on the main UDP transport —
 * without it the SDK always dials its own connection.
 *
 * Returned rather than awaited so a caller can hand back a socket that is not a
 * real TCP connection, as the tests do.
 */
/**
 * Open a TCP connection to the TS3 file transfer port and perform the
 * ftkey handshake. The caller is responsible for closing the socket.
 */
export function dialFileTransfer(
  host: string,
  port: number,
  key: string,
  socketFactory?: FileTransferSocketFactory,
): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    let socket: import("node:net").Socket;
    let started = false;

    const onReady = () => {
      // A supplied socket may already be connected, in which case its connect
      // event never fires; send the key as soon as this runs.
      if (started) return;
      started = true;
      socket.write(key, (err) => {
        if (err) {
          socket.destroy();
          reject(new FileTransferError(`failed to send transfer key: ${err.message}`));
        } else {
          resolve(socket);
        }
      });
    };

    if (socketFactory) {
      socket = socketFactory(host, port);
      setImmediate(onReady);
    } else {
      socket = createConnection({ host, port }, onReady);
    }

    socket.setTimeout(10_000);
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new FileTransferError("connection timeout"));
    });
  });
}

/** Upload data via a TS3 file transfer connection. */
export async function uploadFileData(
  host: string,
  info: FileUploadInfo,
  data: Readable,
  socketFactory?: FileTransferSocketFactory,
): Promise<void> {
  const socket = await dialFileTransfer(host, info.port, info.fileTransferKey, socketFactory);
  await new Promise<void>((resolve, reject) => {
    data.pipe(socket);
    socket.on("finish", resolve);
    socket.on("error", reject);
  });
}

/** Download data via a TS3 file transfer connection. */
export async function downloadFileData(
  host: string,
  info: FileDownloadInfo,
  dest: Writable,
  socketFactory?: FileTransferSocketFactory,
): Promise<void> {
  const socket = await dialFileTransfer(host, info.port, info.fileTransferKey, socketFactory);
  await new Promise<void>((resolve, reject) => {
    socket.pipe(dest);
    dest.on("finish", resolve);
    socket.on("error", reject);
    dest.on("error", reject);
  });
}

export { FileTransferError };
