import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Client, clientInternals } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { ConnectPhase, type ConnectTrace } from "./trace.js";
import { ConnectionTimeoutError, CryptoInitError, InvalidAddressError } from "./errors.js";
import { NotConnectedError } from "@honeybbq/teamspeak-core";
import {
  FakeSocket,
  completeCryptoInit,
  dummyPacket,
  sessionPacket,
} from "./testing/fake-server.js";
import type { ClientOptions } from "./types.js";

const identity = generateIdentitySync(0);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const line = (text: string): Uint8Array => new TextEncoder().encode(text);

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(condition()).toBe(true);
}

/** A socket whose connect() never completes. */
class SlowSocket extends FakeSocket {
  override connect(): void {}
}

interface Recorded {
  readonly name: string;
  readonly info: Record<string, unknown>;
}

/** A trace with every hook set, recording each call in order. */
function recordingTrace(): {
  trace: ConnectTrace;
  calls: Recorded[];
  names: () => string[];
} {
  const calls: Recorded[] = [];
  const record =
    (name: string) =>
    (info: object): void => {
      calls.push({ name, info: info as Record<string, unknown> });
    };
  const trace: ConnectTrace = {
    resolveStart: record("resolveStart"),
    resolveDone: record("resolveDone"),
    connectStart: record("connectStart"),
    handshakeDone: record("handshakeDone"),
    sessionStart: record("sessionStart"),
    welcomeDone: record("welcomeDone"),
    attemptFailed: record("attemptFailed"),
    reconnectScheduled: record("reconnectScheduled"),
  };
  return { trace, calls, names: () => calls.map((c) => c.name) };
}

function makeClient(options: ClientOptions = {}): {
  client: Client;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const client = new Client(identity, "127.0.0.1:9987", "Bot", {
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { client, sockets };
}

/** Each connection numbers its command packets from 0: one counter per socket. */
const packetIds = new WeakMap<FakeSocket, number>();
function nextId(socket: FakeSocket): number {
  const id = packetIds.get(socket) ?? 0;
  packetIds.set(socket, id + 1);
  return id;
}

/** Deliver the server's clientinitiv, which derives the shared secret. */
function deliverInitIV(client: Client, socket: FakeSocket, omega = identity.publicKey()): void {
  const crypt = clientInternals(client).crypt;
  const text = `clientinitiv alpha=${randomBytes(10).toString("base64")} beta=${randomBytes(54).toString("base64")} omega=${omega}`;
  socket.deliver(dummyPacket(crypt, 2, 0x20, nextId(socket), line(text)));
}

/** Deliver lines under the session key, once the handshake has derived it. */
function deliverSession(client: Client, socket: FakeSocket, text: string): void {
  const crypt = clientInternals(client).crypt;
  socket.deliver(sessionPacket(crypt, 2, 0x20, nextId(socket), line(text)));
}

/** Drive a full handshake over the wire, up to and including initserver. */
async function handshake(client: Client, sockets: FakeSocket[], index = 0): Promise<void> {
  await until(() => sockets[index] !== undefined && clientInternals(client).handler.isOpen);
  deliverInitIV(client, sockets[index]!);
  deliverSession(client, sockets[index]!, "initserver aclid=7 virtualserver_version=3.13.7");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a successful attempt", () => {
  it("reports the milestones in order, sessionStart before connect() resolves", async () => {
    const { trace, calls, names } = recordingTrace();
    const { client, sockets } = makeClient({ connectTrace: trace });
    let resolved = false;
    const connecting = client.connect().then(() => {
      resolved = true;
    });
    const connectedEvents: string[] = [];
    client.on("connected", () => connectedEvents.push("connected"));

    await handshake(client, sockets);
    await connecting;
    expect(names()).toEqual([
      "resolveStart",
      "resolveDone",
      "connectStart",
      "handshakeDone",
      "sessionStart",
    ]);
    deliverSession(client, sockets[0]!, "channellistfinished");
    await until(() => names().includes("welcomeDone"));
    expect(names().at(-1)).toBe("welcomeDone");

    const byName = new Map(calls.map((c) => [c.name, c.info]));
    expect(byName.get("resolveStart")).toMatchObject({
      addr: "127.0.0.1:9987",
      attempt: 1,
      reconnect: false,
    });
    expect(byName.get("resolveDone")).toMatchObject({
      addr: "127.0.0.1:9987",
      target: "127.0.0.1:9987",
      attempt: 1,
      reconnect: false,
    });
    expect(byName.get("connectStart")).toMatchObject({
      target: "127.0.0.1:9987",
    });
    for (const name of ["resolveDone", "handshakeDone", "sessionStart", "welcomeDone"]) {
      expect(byName.get(name)!["durationMs"]).toBeGreaterThanOrEqual(0);
    }
    expect(byName.get("sessionStart")).toMatchObject({ clientID: 7 });
    await settle();
    expect(connectedEvents).toEqual(["connected"]);
    expect(resolved).toBe(true);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("calls sessionStart before connect() resolves and before connected, and the hook can read the client", async () => {
    const order: string[] = [];
    let seenStatus: string | undefined;
    let seenID: number | undefined;
    let clientRef: Client | undefined;
    const { client, sockets } = makeClient({
      connectTrace: {
        sessionStart: (info) => {
          order.push("sessionStart");
          seenStatus = clientRef!.status;
          seenID = info.clientID;
          expect(clientRef!.clientID).toBe(info.clientID);
        },
      },
    });
    clientRef = client;
    client.on("connected", () => order.push("connected"));
    const connecting = client.connect().then(() => order.push("resolved"));
    await handshake(client, sockets);
    await connecting;
    await settle();

    expect(order.slice(0, 2)).toEqual(["sessionStart", "resolved"]);
    expect(order).toContain("connected");
    expect(order.indexOf("sessionStart")).toBeLessThan(order.indexOf("connected"));
    expect(seenStatus).toBe("connected");
    expect(seenID).toBe(7);
    expect(client.clientID).toBe(7);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports the resolver's source, and falls back to the address with the error", async () => {
    const sourced = recordingTrace();
    const first = makeClient({
      connectTrace: sourced.trace,
      resolver: {
        resolve: async () => [{ addr: "127.0.0.1:1234", source: "SRV" }],
      },
    });
    const a = first.client.connect();
    a.catch(() => {});
    await until(() => sourced.names().includes("connectStart"));
    expect(sourced.calls.find((c) => c.name === "resolveDone")!.info).toMatchObject({
      target: "127.0.0.1:1234",
      source: "SRV",
      error: undefined,
    });
    await first.client.disconnect();

    const failure = new Error("no such name");
    const fell = recordingTrace();
    const second = makeClient({
      connectTrace: fell.trace,
      resolver: {
        resolve: async () => {
          throw failure;
        },
      },
    });
    const b = second.client.connect();
    b.catch(() => {});
    await until(() => fell.names().includes("connectStart"));
    expect(fell.calls.find((c) => c.name === "resolveDone")!.info).toMatchObject({
      target: "127.0.0.1:9987",
      source: "",
      error: failure,
    });
    await second.client.disconnect();
  });

  it("fires welcomeDone at most once, and never before sessionStart", async () => {
    const { trace, names } = recordingTrace();
    const { client, sockets } = makeClient({ connectTrace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    deliverSession(client, sockets[0]!, "channellistfinished");
    await settle();
    expect(names()).not.toContain("welcomeDone");

    deliverSession(client, sockets[0]!, "initserver aclid=7 virtualserver_version=3.13.7");
    await connecting;
    deliverSession(client, sockets[0]!, "channellistfinished");
    deliverSession(client, sockets[0]!, "channellistfinished");
    await settle();
    expect(names().filter((n) => n === "welcomeDone")).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("a failed attempt", () => {
  /** Exactly one attemptFailed with this phase, and no sessionStart. */
  function expectFailedIn(
    calls: Recorded[],
    phase: ConnectPhase,
    check: (error: unknown) => void,
  ): void {
    expect(calls.filter((c) => c.name === "sessionStart")).toHaveLength(0);
    const failed = calls.filter((c) => c.name === "attemptFailed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.info).toMatchObject({
      phase,
      attempt: 1,
      reconnect: false,
    });
    expect(failed[0]!.info["durationMs"]).toBeGreaterThanOrEqual(0);
    check(failed[0]!.info["error"]);
    expect(calls.at(-1)!.name).toBe("attemptFailed");
  }

  it("in open, when the address is invalid once resolved", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({
      connectTrace: trace,
      resolver: { resolve: async () => [{ addr: "127.0.0.1:99999" }] },
    });
    await expect(client.connect()).rejects.toBeInstanceOf(InvalidAddressError);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBeInstanceOf(InvalidAddressError));
  });

  it("in open, when the signal aborts the address lookup", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({
      connectTrace: trace,
      resolver: { resolve: () => new Promise(() => {}) },
    });
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await settle();
    const reason = new Error("gave up");
    controller.abort(reason);
    await expect(connecting).rejects.toBe(reason);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBe(reason));
    expect(calls.map((c) => c.name)).not.toContain("resolveDone");
  });

  it("in open, when the signal aborts while the socket is opening", async () => {
    const { trace, calls } = recordingTrace();
    let socket: SlowSocket | undefined;
    const client = new Client(identity, "127.0.0.1:9987", "Bot", {
      connectTrace: trace,
      socketFactory: () => (socket = new SlowSocket()),
    });
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await until(() => socket !== undefined);
    const reason = new Error("gave up");
    controller.abort(reason);
    await expect(connecting).rejects.toBe(reason);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBe(reason));
  });

  it("in open, when the socket errors", async () => {
    const { trace, calls } = recordingTrace();
    const boom = new Error("socket boom");
    class FailingSocket extends FakeSocket {
      #onError: Array<(error: Error) => void> = [];
      override connect(): void {
        queueMicrotask(() => {
          for (const listener of this.#onError) listener(boom);
        });
      }
      override once(event: "error", listener: (error: Error) => void): this {
        this.#onError.push(listener);
        return super.once(event, listener);
      }
    }
    const client = new Client(identity, "127.0.0.1:9987", "Bot", {
      connectTrace: trace,
      socketFactory: () => new FailingSocket(),
    });
    await expect(client.connect()).rejects.toBe(boom);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBe(boom));
  });

  it("in handshake, when the socket closes before the shared secret", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ connectTrace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    sockets[0]!.close();
    await expect(connecting).rejects.toBeInstanceOf(Error);
    expectFailedIn(calls, ConnectPhase.Handshake, (e) => expect(e).toBeInstanceOf(Error));
  });

  it("in handshake, on a CryptoInitError", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ connectTrace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!, "bm90IGEga2V5");
    await expect(connecting).rejects.toBeInstanceOf(CryptoInitError);
    expectFailedIn(calls, ConnectPhase.Handshake, (e) => expect(e).toBeInstanceOf(CryptoInitError));
    expect(calls.map((c) => c.name)).not.toContain("handshakeDone");
  });

  it("in handshake, on the idle timeout", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({ connectTrace: trace });
    const connecting = client.connect();
    connecting.catch(() => {});
    await until(() => clientInternals(client).handler.isOpen);
    for (let second = 0; second < 70; second++) vi.advanceTimersByTime(1_000);
    await expect(connecting).rejects.toBeInstanceOf(ConnectionTimeoutError);
    expectFailedIn(calls, ConnectPhase.Handshake, (e) =>
      expect(e).toBeInstanceOf(ConnectionTimeoutError),
    );
  });

  it("in handshake, when disconnect() ends it", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({ connectTrace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    expectFailedIn(calls, ConnectPhase.Handshake, (e) =>
      expect(e).toBeInstanceOf(NotConnectedError),
    );
  });

  it("in open, when disconnect() ends it during the lookup", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({
      connectTrace: trace,
      resolver: { resolve: () => new Promise(() => {}) },
    });
    const connecting = client.connect();
    await settle();
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBeInstanceOf(NotConnectedError));
  });

  it("in join, when the server refuses before initserver", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ connectTrace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    deliverSession(client, sockets[0]!, "error id=520 msg=wrong\\spassword");
    await expect(connecting).rejects.toMatchObject({ code: 520 });
    expectFailedIn(calls, ConnectPhase.Join, (e) => expect(e).toMatchObject({ code: 520 }));
    expect(calls.map((c) => c.name)).toContain("handshakeDone");
  });

  it("with exactly one attemptFailed even when the failure is reported twice", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ connectTrace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    deliverSession(client, sockets[0]!, "error id=520 msg=a");
    deliverSession(client, sockets[0]!, "error id=521 msg=b");
    sockets[0]!.close();
    await expect(connecting).rejects.toMatchObject({ code: 520 });
    await client.disconnect().catch(() => {});
    await settle();
    expect(calls.filter((c) => c.name === "attemptFailed")).toHaveLength(1);
  });
});

describe("reconnecting", () => {
  it("reports reconnectScheduled, and numbers the attempts it makes", async () => {
    const { trace, calls, names } = recordingTrace();
    const { client, sockets } = makeClient({
      connectTrace: trace,
      reconnect: { backoff: { initialDelayMs: 20, maxDelayMs: 20, jitter: 0 } },
    });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;

    sockets[0]!.close();
    await until(() => sockets.length === 2);
    const scheduled = calls.find((c) => c.name === "reconnectScheduled")!;
    expect(scheduled.info).toMatchObject({ attempt: 1, delayMs: 20 });
    expect(scheduled.info["cause"]).toBeInstanceOf(Error);

    await handshake(client, sockets, 1);
    await until(() => client.status === "connected");
    const starts = calls.filter((c) => c.name === "resolveStart");
    expect(starts.map((c) => c.info)).toMatchObject([
      { attempt: 1, reconnect: false },
      { attempt: 1, reconnect: true },
    ]);
    expect(names().filter((n) => n === "sessionStart")).toHaveLength(2);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports a failed reconnection attempt, then schedules the next", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({
      connectTrace: trace,
      reconnect: { backoff: { initialDelayMs: 20, maxDelayMs: 20, jitter: 0 } },
    });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    sockets[0]!.close();
    await until(() => sockets.length === 2);
    await until(() => clientInternals(client).handler.isOpen);
    sockets[1]!.close();
    await until(() => sockets.length === 3);

    const failed = calls.filter((c) => c.name === "attemptFailed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.info).toMatchObject({
      attempt: 1,
      reconnect: true,
      phase: "handshake",
    });
    const scheduled = calls.filter((c) => c.name === "reconnectScheduled");
    expect(scheduled.map((c) => c.info["attempt"])).toEqual([1, 2]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("a hook that fails", () => {
  /** Run `body` with queueMicrotask's rethrows collected rather than thrown. */
  async function collecting(body: () => Promise<void>): Promise<unknown[]> {
    const rethrown: Array<() => void> = [];
    const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      rethrown.push(task);
    });
    try {
      await body();
      await settle();
    } finally {
      spy.mockRestore();
    }
    const errors: unknown[] = [];
    for (const task of rethrown) {
      try {
        task();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  it("is reported, whether it throws or rejects, and the connection completes", async () => {
    const boom = new Error("hook boom");
    const rejection = new Error("hook rejection");
    const trace: ConnectTrace = {
      resolveStart: () => {
        throw boom;
      },
      handshakeDone: async () => {
        throw rejection;
      },
      sessionStart: () => {
        throw boom;
      },
    };
    const { client, sockets } = makeClient({ connectTrace: trace });
    const connected: string[] = [];
    client.on("connected", () => connected.push("connected"));
    const errors = await collecting(async () => {
      const connecting = client.connect();
      await handshake(client, sockets);
      await connecting;
    });
    expect(errors.filter((e) => e === boom)).toHaveLength(2);
    expect(errors.filter((e) => e === rejection)).toHaveLength(1);
    expect(client.status).toBe("connected");
    expect(connected).toEqual(["connected"]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("is reported as an uncaught exception, as a throwing listener's is", async () => {
    const boom = new Error("uncaught hook");
    const seen: unknown[] = [];
    const listener = (error: unknown): void => {
      seen.push(error);
    };
    // vitest installs its own handler; ours only observes.
    process.on("uncaughtException", listener);
    try {
      const { client, sockets } = makeClient({
        connectTrace: {
          sessionStart: () => {
            throw boom;
          },
        },
      });
      const connecting = client.connect();
      await handshake(client, sockets);
      await connecting;
      await settle();
      await settle();
      expect(seen).toContain(boom);
      expect(client.status).toBe("connected");
      await client.disconnect({ signal: AbortSignal.timeout(1) });
    } finally {
      process.off("uncaughtException", listener);
    }
  });

  it("does not turn a failure into another one", async () => {
    const { client } = makeClient({
      connectTrace: {
        attemptFailed: () => {
          throw new Error("hook boom");
        },
      },
      resolver: { resolve: async () => [{ addr: "127.0.0.1:99999" }] },
    });
    const errors = await collecting(async () => {
      await expect(client.connect()).rejects.toBeInstanceOf(InvalidAddressError);
    });
    expect(errors).toHaveLength(1);
  });
});

// Not supported (the documented rule forbids it), but it must not break the
// client either.
describe("disconnect() from a hook", () => {
  it("is safe from sessionStart: the attempt stays a success and the client ends disconnected", async () => {
    const calls: string[] = [];
    let leaving: Promise<void> | undefined;
    const { client, sockets } = makeClient({
      connectTrace: {
        sessionStart: () => {
          calls.push("sessionStart");
          leaving = clientRef!.disconnect({ signal: AbortSignal.timeout(1) });
        },
        attemptFailed: () => calls.push("attemptFailed"),
      },
    });
    const clientRef: Client | undefined = client;
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    client.on("disconnected", () => events.push("disconnected"));
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    await leaving;
    await settle();
    expect(calls).toEqual(["sessionStart"]);
    expect(events).toEqual(["connected", "disconnected"]);
    expect(client.status).toBe("disconnected");
  }, 5_000);

  it("is safe from handshakeDone: the attempt fails once, in join", async () => {
    const calls: Array<[string, unknown]> = [];
    let leaving: Promise<void> | undefined;
    const { client, sockets } = makeClient({
      connectTrace: {
        handshakeDone: () => {
          leaving = client.disconnect({ signal: AbortSignal.timeout(1) });
        },
        sessionStart: () => calls.push(["sessionStart", undefined]),
        attemptFailed: (info) => calls.push(["attemptFailed", info.phase]),
      },
    });
    const connecting = client.connect();
    connecting.catch(() => {});
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    await leaving;
    expect(calls).toEqual([["attemptFailed", "join"]]);
    expect(client.status).toBe("disconnected");
  }, 5_000);
});

describe("disconnect() from other hooks", () => {
  it("is safe from resolveStart: the attempt fails once, in open", async () => {
    const calls: Array<[string, unknown]> = [];
    let leaving: Promise<void> | undefined;
    const { client } = makeClient({
      connectTrace: {
        resolveStart: () => {
          leaving = client.disconnect({ signal: AbortSignal.timeout(1) });
        },
        resolveDone: () => calls.push(["resolveDone", undefined]),
        attemptFailed: (info) => calls.push(["attemptFailed", info.phase]),
      },
    });
    await expect(client.connect()).rejects.toBeInstanceOf(NotConnectedError);
    await leaving;
    expect(calls).toEqual([["attemptFailed", "open"]]);
    expect(client.status).toBe("disconnected");
  }, 5_000);

  it("is safe from attemptFailed", async () => {
    let leaving: Promise<void> | undefined;
    const events: string[] = [];
    const { client } = makeClient({
      connectTrace: {
        attemptFailed: () => {
          leaving = client.disconnect({ signal: AbortSignal.timeout(1) });
        },
      },
      resolver: { resolve: async () => [{ addr: "127.0.0.1:99999" }] },
    });
    client.on("disconnected", () => events.push("disconnected"));
    await expect(client.connect()).rejects.toBeInstanceOf(InvalidAddressError);
    await leaving;
    await settle();
    expect(events).toEqual(["disconnected"]);
    expect(client.status).toBe("disconnected");
  }, 5_000);
});

describe("without a trace", () => {
  it("connects with no connectTrace", async () => {
    const { client, sockets } = makeClient();
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    expect(client.status).toBe("connected");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("connects with a trace that has no hooks, and copies it", async () => {
    const trace: { sessionStart?: () => void } = {};
    const { client, sockets } = makeClient({ connectTrace: trace });
    // Added after construction: the client holds a copy, so this is never called.
    trace.sessionStart = () => {
      throw new Error("must not run");
    };
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    expect(client.status).toBe("connected");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("works through the internals seam used by other tests", async () => {
    const { trace, names } = recordingTrace();
    const { client } = makeClient({ connectTrace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    completeCryptoInit(clientInternals(client).crypt);
    clientInternals(client).markHandshakeDone();
    clientInternals(client).clid = 5;
    clientInternals(client).markConnected();
    await connecting;
    expect(names()).toEqual([
      "resolveStart",
      "resolveDone",
      "connectStart",
      "handshakeDone",
      "sessionStart",
    ]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});
