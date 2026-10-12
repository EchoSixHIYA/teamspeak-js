import { afterEach, describe, it, expect } from "vitest";
import { createSocket, type Socket } from "node:dgram";
import {
  Client,
  ClientStatus,
  NotConnectedError,
  Reason,
  RemovedError,
  defaultShouldRetry,
  generateIdentitySync,
  type ClientOptions,
  type KickedEvent,
  type CommandTrace,
  commandChannel,
} from "./index.js";
import { PacketType, type Packet } from "./transport/packet.js";

function commandPacket(text: string): Packet {
  return {
    typeFlagged: PacketType.Command,
    id: 1,
    clientID: 0,
    generationID: 0,
    data: new TextEncoder().encode(text),
    receivedAt: Date.now(),
  };
}

/** A client already past the handshake, as initserver would have left it. */
function connectedClient(nickname: string, clid: number): Client {
  const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", nickname);
  client.clid = clid;
  client.handler.setClientID(clid);
  return client;
}

describe("Client self identification on notifycliententerview", () => {
  it("does not adopt another client named <own nick><digits>", () => {
    // The server renames a client whose nickname is taken to "<nick><digits>",
    // so a lookalike is indistinguishable from us by nickname alone. Adopting
    // its clid would poison every outgoing packet header with a foreign id.
    const client = connectedClient("Bot", 5);

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=Bot2"),
    );

    expect(client.clid).toBe(5);
  });

  it("tracks the server-applied rename on its own clientEnter", () => {
    const client = connectedClient("Bot", 5);

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=5 ctid=1 client_nickname=Bot2"),
    );

    expect(client.clid).toBe(5);
    expect(client.nickname).toBe("Bot2");
  });

  it("still learns its clid from the welcome enter when initserver carried no aclid", () => {
    const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", "Bot");

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=7 ctid=1 client_nickname=Bot"),
    );

    expect(client.clid).toBe(7);
    expect(client.nickname).toBe("Bot");
  });

  it("adopts the first suffix match while the clid is still unknown, then locks it in", () => {
    // While initserver has given us no clid, a nickname match is the only
    // signal available, so the first one wins. The clid is then known, which
    // is what stops any later lookalike from taking over.
    const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", "Bot");

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=Bot3"),
    );
    expect(client.clid).toBe(9);

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=7 ctid=1 client_nickname=Bot"),
    );
    expect(client.clid).toBe(9);
  });
});

const silentSockets: Socket[] = [];
afterEach(() => {
  for (const socket of silentSockets.splice(0)) socket.close();
});

/**
 * A client pointed at a UDP socket that never answers, so its handshake never
 * completes. A port with nothing bound would refuse the datagrams instead.
 */
async function silentServerClient(options: ClientOptions = {}): Promise<Client> {
  const silent = createSocket("udp4");
  silentSockets.push(silent);
  await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", resolve));
  const addr = `127.0.0.1:${silent.address().port}`;
  return new Client(generateIdentitySync(0), "silent.example", "Bot", {
    resolver: { resolve: async () => [{ addr, source: "test", expiry: new Date() }] },
    ...options,
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}

/** Wait for every queued delivery to run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("connect()", () => {
  it("rejects with the server error instead of timing out", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => client.handler.isOpen);

    // A handshake the server rejects before the welcome sequence completes.
    client.handler.onPacket?.(commandPacket("error id=1028 msg=invalid\\sserver\\spassword"));

    await expect(connecting).rejects.toThrow(/invalid server password/);
    expect(client.status).toBe(ClientStatus.Disconnected);
  });

  it("abandons the attempt when the signal aborts, and can try again", async () => {
    const client = await silentServerClient();
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await until(() => client.handler.isOpen);

    const reason = new Error("caller went away");
    controller.abort(reason);

    await expect(connecting).rejects.toBe(reason);
    expect(client.status).toBe(ClientStatus.Disconnected);

    const again = client.connect({ signal: AbortSignal.timeout(20) });
    await expect(again).rejects.not.toThrow(/already/);
  });

  it("rejects at once on a signal that has already aborted", async () => {
    const client = await silentServerClient();
    const reason = new Error("too late");

    await expect(client.connect({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(client.status).toBe(ClientStatus.Disconnected);
  });

  // Without a signal, a connect() that disconnect() interrupted used to wait
  // forever.
  it("rejects when disconnect() is called during the handshake", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => client.handler.isOpen);

    await client.disconnect();

    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("resolves once the handshake completes", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => client.handler.isOpen);

    client._markConnected();

    await expect(connecting).resolves.toBeUndefined();
    expect(client.status).toBe(ClientStatus.Connected);
    await client.disconnect();
  });
});

describe("events", () => {
  it("delivers events in the order they arrived", async () => {
    const client = connectedClient("Bot", 5);
    const seen: number[] = [];
    client.on("clientEnter", (info) => seen.push(info.id));

    for (let id = 10; id < 60; id++) {
      client.handler.onPacket?.(
        commandPacket(`notifycliententerview clid=${id} ctid=1 client_nickname=C${id}`),
      );
    }
    await settle();

    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 10));
  });

  it("stops delivering once unsubscribed, including events already queued", async () => {
    const client = connectedClient("Bot", 5);
    const seen: string[] = [];
    const unsubscribe = client.on("poked", (e) => seen.push(e.message));

    client.handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=queued"));
    unsubscribe();
    unsubscribe(); // a second call is harmless
    await settle();

    expect(seen).toEqual([]);
  });

  it("is a Disposable, so a listener can live for a scope", async () => {
    const client = connectedClient("Bot", 5);
    const seen: string[] = [];
    {
      using _listener = client.on("poked", (e) => seen.push(e.message));
    }
    client.handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=after"));
    await settle();

    expect(seen).toEqual([]);
  });

  it("once() hears only the next occurrence", async () => {
    const client = connectedClient("Bot", 5);
    const seen: string[] = [];
    client.once("poked", (e) => seen.push(e.message));

    client.handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=first"));
    client.handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=second"));
    await settle();

    expect(seen).toEqual(["first"]);
  });

  // The middleware used to guess which event it had by the payload's shape.
  it("names the event for middleware, which can drop it", async () => {
    const names: string[] = [];
    const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", "Bot", {
      eventMiddleware: [
        (next) => (event) => {
          names.push(event.name);
          if (event.name !== "poked") next(event);
        },
      ],
    });
    client.clid = 5;
    const poked: string[] = [];
    client.on("poked", (e) => poked.push(e.message));

    client.handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=dropped"));
    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=X"),
    );
    await settle();

    expect(names).toEqual(["poked", "notification", "clientEnter", "notification"]);
    expect(poked).toEqual([]);
  });
});

describe("being removed by the server", () => {
  async function connected(): Promise<Client> {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => client.handler.isOpen);
    client.clid = 5;
    client._markConnected();
    await connecting;
    return client;
  }

  it("reports a server kick and ends the session at once, with the cause", async () => {
    const client = await connected();
    const kicked: KickedEvent[] = [];
    const disconnected: Array<Error | undefined> = [];
    client.on("kicked", (e) => kicked.push(e));
    client.on("disconnected", (err) => disconnected.push(err));

    client.handler.onPacket?.(
      commandPacket(
        "notifyclientleftview clid=5 reasonid=5 reasonmsg=behave invokerid=1 invokername=Admin",
      ),
    );
    await settle();

    expect(kicked).toEqual([
      expect.objectContaining({
        reason: Reason.KickServer,
        reasonMessage: "behave",
        invokerName: "Admin",
      }),
    ]);
    expect(disconnected[0]).toBeInstanceOf(RemovedError);
    expect(client.status).toBe(ClientStatus.Disconnected);
    expect(defaultShouldRetry(disconnected[0])).toBe(false);
  });

  it("retries a server that stopped, which is not a kick", async () => {
    const client = await connected();
    const kicked: KickedEvent[] = [];
    const disconnected: Array<Error | undefined> = [];
    client.on("kicked", (e) => kicked.push(e));
    client.on("disconnected", (err) => disconnected.push(err));

    client.handler.onPacket?.(
      commandPacket("notifyclientleftview clid=5 reasonid=11 reasonmsg=restart"),
    );
    await settle();

    expect(kicked).toEqual([]);
    expect(defaultShouldRetry(disconnected[0])).toBe(true);
  });

  // A channel kick arrives as a move, which is not where it used to be looked for.
  it("reports a channel kick, which leaves the session up", async () => {
    const client = await connected();
    const kicked: KickedEvent[] = [];
    client.on("kicked", (e) => kicked.push(e));

    client.handler.onPacket?.(
      commandPacket("notifyclientmoved clid=5 ctid=1 reasonid=4 reasonmsg=out invokername=Admin"),
    );
    await settle();

    expect(kicked).toEqual([
      expect.objectContaining({ reason: Reason.KickChannel, reasonMessage: "out" }),
    ]);
    expect(client.status).toBe(ClientStatus.Connected);
    await client.disconnect();
  });

  it("hears a deliberate disconnect as undefined", async () => {
    const client = await connected();
    const disconnected: Array<Error | undefined> = [];
    client.on("disconnected", (err) => disconnected.push(err));

    await client.disconnect({ signal: AbortSignal.timeout(50) });
    await settle();

    expect(disconnected).toEqual([undefined]);
  });
});

describe("diagnostics channels", () => {
  it("traces a command by name, never with its parameters", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => client.handler.isOpen);
    client.clid = 5;
    client._markConnected();
    await connecting;

    const traced: Array<{ event: string; command: string }> = [];
    const handlers = {
      start: (m: CommandTrace) => traced.push({ event: "start", command: m.command }),
      asyncEnd: (m: CommandTrace) => traced.push({ event: "end", command: m.command }),
      error: (m: CommandTrace) => traced.push({ event: "error", command: m.command }),
    };
    commandChannel.subscribe(handlers);
    try {
      const answered = client.exec("clientmove clid=5 cid=1 cpw=secret", { timeout: 1_000 });
      await new Promise((r) => setImmediate(r));
      client.handler.onPacket?.(commandPacket("error id=0 msg=ok return_code=1"));
      await answered;
    } finally {
      commandChannel.unsubscribe(handlers);
    }

    expect(traced).toEqual([
      { event: "start", command: "clientmove" },
      { event: "end", command: "clientmove" },
    ]);
    expect(JSON.stringify(traced)).not.toContain("secret");
    await client.disconnect({ signal: AbortSignal.timeout(50) });
  });
});

// After EchoSixHIYA/teamspeak-js (4b82c32, by illusia).
describe("notification", () => {
  it("delivers every notification as it arrived, after the event it produces", async () => {
    const client = connectedClient("Bot", 5);
    const order: string[] = [];
    client.on("poked", () => order.push("poked"));
    client.on("notification", (n) => order.push(`${n.name} ${n.params["msg"] ?? ""}`.trim()));

    client.handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=hi"));
    client.handler.onPacket?.(commandPacket("notifyserveredited virtualserver_name=X"));
    await settle();

    expect(order).toEqual(["poked", "notifyclientpoke hi", "notifyserveredited"]);
  });
});

describe("events()", () => {
  it("iterates events in order, buffering those that arrive mid-loop", async () => {
    const client = connectedClient("Bot", 5);
    const controller = new AbortController();
    const seen: string[] = [];

    const loop = (async () => {
      for await (const poke of client.events("poked", { signal: controller.signal })) {
        seen.push(poke.message);
        await new Promise((r) => setTimeout(r, 5));
        if (seen.length === 3) controller.abort();
      }
    })();
    for (const msg of ["a", "b", "c", "d"]) {
      client.handler.onPacket?.(commandPacket(`notifyclientpoke invokerid=1 msg=${msg}`));
    }
    await loop;

    expect(seen.slice(0, 3)).toEqual(["a", "b", "c"]);
  });

  it("stops listening when the loop exits early", async () => {
    const client = connectedClient("Bot", 5);
    const loop = (async () => {
      for await (const _poke of client.events("poked")) break;
    })();
    client.handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=x"));
    await loop;

    // Nothing is left listening: a later event has nowhere to go.
    client.handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=y"));
    await settle();
  });

  it("ends when the client disconnects", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => client.handler.isOpen);
    client.clid = 5;
    client._markConnected();
    await connecting;

    const loop = (async () => {
      const seen: string[] = [];
      for await (const poke of client.events("poked")) seen.push(poke.message);
      return seen;
    })();
    await settle();
    await client.disconnect({ signal: AbortSignal.timeout(50) });

    await expect(loop).resolves.toEqual([]);
  });
});
