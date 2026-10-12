import { clientInternals } from "./client.js";
import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import {
  CommandTimeoutError,
  Codec,
  NotConnectedError,
  type Logger,
} from "@honeybbq/teamspeak-core";
import { CommandThrottle } from "./throttle.js";
import { PacketType, type Packet } from "./transport/packet.js";
import { FakeSocket } from "./testing/fake-server.js";
import type { ClientOptions } from "./types.js";

const identity = generateIdentitySync(0);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(condition()).toBe(true);
}

/** A socket whose connect() completes only when the test says so. */
class SlowSocket extends FakeSocket {
  #connected: (() => void) | undefined;
  override connect(_port: number, _address: string, callback: () => void): void {
    this.#connected = callback;
  }
  finishConnecting(): void {
    this.#connected?.();
  }
}

function clientOn(socket: () => FakeSocket, options: ClientOptions = {}): Client {
  return new Client(identity, "127.0.0.1:9987", "Bot", { socketFactory: socket, ...options });
}

function packet(type: PacketType, data: Uint8Array): Packet {
  return { typeFlagged: type, id: 1, clientID: 0, generationID: 0, data, receivedAt: Date.now() };
}

/** A client that has completed a handshake against a socket that answers nothing. */
async function connected(
  options: ClientOptions = {},
): Promise<{ client: Client; socket: FakeSocket }> {
  let socket: FakeSocket | undefined;
  const client = clientOn(() => (socket = new FakeSocket()), options);
  const connecting = client.connect();
  await until(() => clientInternals(client).handler.isOpen);
  clientInternals(client).clid = 5;
  clientInternals(client).markConnected();
  await connecting;
  return { client, socket: socket! };
}

describe("connect() interrupted", () => {
  it("never starts a socket that finishes connecting after disconnect()", async () => {
    let socket: SlowSocket | undefined;
    const client = clientOn(() => (socket = new SlowSocket()));
    const connected: unknown[] = [];
    client.on("connected", () => connected.push(true));

    const connecting = client.connect();
    connecting.catch(() => {}); // asserted below, after the socket finishes
    await until(() => socket !== undefined);
    await client.disconnect();
    socket!.finishConnecting();
    await settle();

    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    expect(socket!.closed).toBe(true);
    // No Init1 went out: the handshake never began.
    expect(socket!.sent).toEqual([]);
    expect(clientInternals(client).handler.isOpen).toBe(false);
    expect(connected).toEqual([]);
  });

  it("abandons a resolver that ignores the signal", async () => {
    const client = clientOn(() => new FakeSocket(), {
      resolver: { resolve: () => new Promise(() => {}) },
    });
    const connecting = client.connect();
    await settle();
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("stops at the signal while the socket is still connecting", async () => {
    let socket: SlowSocket | undefined;
    const client = clientOn(() => (socket = new SlowSocket()));
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await until(() => socket !== undefined);
    const reason = new Error("gave up");
    controller.abort(reason);

    await expect(connecting).rejects.toBe(reason);
    expect(socket!.closed).toBe(true);
    socket!.finishConnecting();
    expect(socket!.sent).toEqual([]);
  });

  it("does not announce a handshake that completes after disconnect()", async () => {
    const { client } = await connected();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    clientInternals(client).markConnected();
    await settle();
    expect(events).toEqual([]);
    expect(client.status).toBe("disconnected");
  });
});

describe("sending without a connection", () => {
  it("throws a NotConnectedError for voice, whispers and execNoWait", async () => {
    const client = clientOn(() => new FakeSocket());
    expect(() => client.sendVoice(new Uint8Array(4), Codec.OpusVoice)).toThrow(NotConnectedError);
    expect(() => client.sendWhisper(new Uint8Array(4), [], Codec.OpusVoice)).toThrow(
      NotConnectedError,
    );
    await expect(client.execNoWait("clientupdate")).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("throws after a disconnect too", async () => {
    const { client } = await connected();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    expect(() => client.sendVoice(new Uint8Array(4), Codec.OpusVoice)).toThrow(NotConnectedError);
    await expect(client.exec("whoami")).rejects.toBeInstanceOf(NotConnectedError);
  });
});

describe("the command throttle", () => {
  it("removes its abort listener when the wait ends normally", async () => {
    const throttle = new CommandThrottle();
    const controller = new AbortController();
    for (let i = 0; i < 7; i++) await throttle.wait(controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("is bounded by a command's timeout and signal", async () => {
    const { client } = await connected();
    // Spend the tokens, so the next command waits for its turn.
    for (let i = 0; i < 8; i++) await client.execNoWait("clientupdate");

    const started = Date.now();
    await expect(client.exec("whoami", { timeout: 30 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(200);

    const reason = new Error("stop");
    await expect(
      client.execNoWait("clientupdate", { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("events()", () => {
  it("stops listening and drops the buffer as soon as the signal aborts", async () => {
    const { client } = await connected();
    const controller = new AbortController();
    const iterator = client.events("poked", { signal: controller.signal });
    const poke = new TextEncoder().encode("notifyclientpoke invokerid=1 msg=x");
    clientInternals(client).handler.onPacket?.(packet(PacketType.Command, poke));
    clientInternals(client).handler.onPacket?.(packet(PacketType.Command, poke));
    await settle();

    controller.abort();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("voice delivery", () => {
  it("drops voice past 256 pending deliveries, and warns about it once", async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (msg) => warnings.push(msg),
      error() {},
    };
    const { client } = await connected({ logger });
    let heard = 0;
    client.on("voiceData", () => heard++);

    const frame = Uint8Array.of(0, 1, 0, 9, Codec.OpusVoice, 1, 2, 3);
    for (let i = 0; i < 1000; i++)
      clientInternals(client).handler.onPacket?.(packet(PacketType.Voice, frame));
    await settle();

    expect(heard).toBeGreaterThan(0);
    expect(heard).toBeLessThanOrEqual(257);
    expect(warnings.filter((w) => w.startsWith("voice dropped"))).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("reconnecting", () => {
  it("ends the loop with an error log when shouldRetry throws", async () => {
    const errors: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (msg) => errors.push(msg),
    };
    const { client } = await connected({
      logger,
      reconnect: {
        shouldRetry: () => {
          throw new Error("buggy policy");
        },
      },
    });
    const leave = new TextEncoder().encode("notifyclientleftview clid=5 reasonid=11");
    clientInternals(client).handler.onPacket?.(packet(PacketType.Command, leave));
    await until(() => errors.length > 0);
    expect(errors[0]).toMatch(/shouldRetry/);
  });
});

describe("command middleware", () => {
  it("sees typed requests, can answer them itself, and never sees raw lines", async () => {
    const seen: string[] = [];
    const { client } = await connected({
      commandMiddleware: [
        (next) => async (request, options) => {
          seen.push(request.command);
          if (request.command === "whoami") return [{ client_id: "42" }];
          return next(request, options);
        },
      ],
    });
    const { whoAmI } = await import("@honeybbq/teamspeak-core");

    await expect(whoAmI(client)).resolves.toMatchObject({ clientID: 42 });
    await client.execNoWait("clientupdate");
    expect(seen).toEqual(["whoami"]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});
