import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import type { FileDownloadInfo, FileUploadInfo } from "@honeybbq/teamspeak-core";
import { dialFileTransfer, downloadFileData, uploadFileData } from "./transfer.js";

/** A connected stream that records what was written to it. */
function recordingStream(fail?: Error): { stream: Duplex; written: string[] } {
  const written: string[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (fail) return callback(fail);
      written.push(chunk.toString());
      callback();
    },
  });
  return { stream, written };
}

/** A local TCP server; `handle` gets each connection. */
async function listen(handle: (socket: import("node:net").Socket) => void): Promise<Server> {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const port = (server: Server): number => (server.address() as { port: number }).port;

describe("dialFileTransfer", () => {
  it("uses a supplied socket factory instead of dialling", async () => {
    const { stream, written } = recordingStream();
    const calls: Array<[string, number]> = [];

    const result = await dialFileTransfer("transfer.example", 30033, "the-key", {
      socketFactory: (host, p) => {
        calls.push([host, p]);
        return stream;
      },
    });

    // Without the seam the SDK always dials its own connection, so an
    // application could not route file transfers through a proxy.
    expect(calls).toEqual([["transfer.example", 30033]]);
    expect(result).toBe(stream);
    // The ftkey handshake still runs over the supplied stream.
    expect(written).toEqual(["the-key"]);
  });

  it("surfaces a write failure as a file transfer error", async () => {
    const { stream } = recordingStream(new Error("broken pipe"));

    await expect(dialFileTransfer("h", 1, "k", { socketFactory: () => stream })).rejects.toThrow(
      /failed to send transfer key/,
    );
  });

  it("rejects with the signal's reason when aborted", async () => {
    const reason = new Error("stop");
    await expect(
      dialFileTransfer("127.0.0.1", 1, "k", { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });
});

describe("upload and download", () => {
  const info = {
    port: 0,
    fileTransferKey: "key",
    clientFileTransferID: 1,
    serverFileTransferID: 1,
  };

  it("sends the key, then the data", async () => {
    let received = "";
    let ended!: () => void;
    const done = new Promise<void>((resolve) => (ended = resolve));
    const server = await listen((socket) => {
      socket.on("data", (chunk) => (received += chunk.toString()));
      // As the server does once it has the whole file.
      socket.on("end", () => {
        socket.end();
        ended();
      });
    });
    const upload: FileUploadInfo = { ...info, port: port(server), seekPosition: 0n };

    await uploadFileData("127.0.0.1", upload, Readable.from(["hello"]));
    await done;
    server.close();

    expect(received).toBe("keyhello");
  });

  it("stops a download in progress when its signal aborts", async () => {
    const server = await listen((socket) => {
      socket.write("partial");
      // …and never finishes.
    });
    const download: FileDownloadInfo = { ...info, port: port(server), size: 100n };
    const controller = new AbortController();
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _e, callback) {
        chunks.push(chunk.toString());
        controller.abort(new Error("enough"));
        callback();
      },
    });

    await expect(
      downloadFileData("127.0.0.1", download, dest, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(chunks.join("")).toBe("partial");
    server.close();
  });

  it("accepts a stream that is already connected", async () => {
    const stream = new PassThrough();
    await expect(dialFileTransfer("h", 1, "k", { socketFactory: () => stream })).resolves.toBe(
      stream,
    );
  });
});
