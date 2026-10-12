import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { dialFileTransfer } from "./transfer.js";

/** A stand-in for the file transfer socket that records what was written. */
function fakeSocket(): { socket: Socket; written: string[] } {
  const written: string[] = [];
  const emitter = new EventEmitter() as unknown as Socket;
  emitter.write = ((chunk: string | Uint8Array, cb?: () => void) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    cb?.();
    return true;
  }) as unknown as Socket["write"];
  emitter.setTimeout = (() => emitter) as unknown as Socket["setTimeout"];
  emitter.destroy = (() => emitter) as unknown as Socket["destroy"];
  return { socket: emitter, written };
}

describe("dialFileTransfer", () => {
  it("uses a supplied socket factory instead of dialling", async () => {
    const { socket, written } = fakeSocket();
    const calls: Array<[string, number]> = [];

    const result = await dialFileTransfer("transfer.example", 30033, "the-key", (host, port) => {
      calls.push([host, port]);
      return socket;
    });

    // Without the seam the SDK always dials its own connection, so an
    // application could not route file transfers through a proxy.
    expect(calls).toEqual([["transfer.example", 30033]]);
    expect(result).toBe(socket);
    // The ftkey handshake still runs over the supplied socket.
    expect(written).toEqual(["the-key"]);
  });

  it("surfaces a write failure as a file transfer error", async () => {
    const emitter = new EventEmitter() as unknown as Socket;
    emitter.write = ((_c: unknown, cb?: (err?: Error) => void) => {
      cb?.(new Error("broken pipe"));
      return false;
    }) as unknown as Socket["write"];
    emitter.setTimeout = (() => emitter) as unknown as Socket["setTimeout"];
    emitter.destroy = (() => emitter) as unknown as Socket["destroy"];

    await expect(dialFileTransfer("h", 1, "k", () => emitter)).rejects.toThrow(
      /failed to send transfer key/,
    );
  });
});
