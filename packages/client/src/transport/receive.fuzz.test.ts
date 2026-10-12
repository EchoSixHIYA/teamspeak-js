import { clientInternals } from "../client.js";
/**
 * A deterministic randomized test of everything a datagram from the server
 * reaches: header parsing, decryption, reassembly, decompression, the Init1
 * steps, the handshake commands and notification handling. Whatever arrives,
 * nothing may throw out of the socket callback, where it would be an uncaught
 * exception that ends the process.
 */

import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Client } from "../client.js";
import { CryptoInitError } from "../errors.js";
import { generateIdentitySync } from "../crypto/identity.js";
import { MAX_DECOMPRESSED_SIZE, Qlz, QuickLZError } from "./quicklz.js";
import { Crypt } from "../crypto/crypt.js";
import {
  FakeSocket,
  datagram,
  dummyPacket,
  init1Packet,
  plainPacket,
  prng,
  s2cHeader,
  sessionPacket,
} from "../testing/fake-server.js";

const identity = generateIdentitySync(0);
const serverKey = generateIdentitySync(0).publicKeyBase64();
const CASES = 3000;

/** Fails the test if anything escapes to the process. */
const escaped: unknown[] = [];
const onEscape = (error: unknown): void => {
  escaped.push(error);
};
process.on("uncaughtException", onEscape);
process.on("unhandledRejection", onEscape);
afterAll(() => {
  process.off("uncaughtException", onEscape);
  process.off("unhandledRejection", onEscape);
});

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class Gen {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = prng(seed);
  }
  int(max: number): number {
    return Math.floor(this.next() * max);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  bytes(max: number): Uint8Array {
    const out = new Uint8Array(this.int(max + 1));
    for (let i = 0; i < out.length; i++) out[i] = this.int(256);
    return out;
  }
  b64(max: number): string {
    return Buffer.from(this.bytes(max)).toString("base64");
  }
  value(): string {
    switch (this.int(8)) {
      case 0:
        return "";
      case 1:
        return String(this.int(70000));
      case 2:
        return "-" + String(this.int(1e9));
      case 3:
        return "9".repeat(1 + this.int(40));
      case 4:
        return this.b64(80);
      case 5:
        return serverKey;
      case 6:
        return "\\s\\p\\/\\\\x\\";
      default:
        return Buffer.from(this.bytes(30)).toString("latin1");
    }
  }
  command(): string {
    const name = this.pick([
      "clientinitiv",
      "initivexpand2",
      "initserver",
      "error",
      "channellistfinished",
      "notifycliententerview",
      "notifyclientleftview",
      "notifyclientmoved",
      "notifytextmessage",
      "notifyclientpoke",
      "notifystartupload",
      "notifyunknown",
      "",
      "-1",
    ]);
    const keys = [
      "alpha",
      "beta",
      "omega",
      "l",
      "proof",
      "ot",
      "aclid",
      "clid",
      "ctid",
      "cid",
      "id",
      "msg",
      "return_code",
      "reasonid",
      "targetmode",
      "target",
      "invokerid",
      "client_nickname",
      "client_servergroups",
      "client_created",
      "virtualserver_version",
      "virtualserver_icon_id",
      "status",
      "clientftfid",
      "failed_permid",
    ];
    const rows: string[] = [];
    for (let r = 0, n = 1 + this.int(3); r < n; r++) {
      const params: string[] = [];
      for (let i = 0, m = this.int(8); i < m; i++) {
        const key = this.pick(keys);
        params.push(this.int(6) === 0 ? key : `${key}=${this.value().replaceAll(" ", "\\s")}`);
      }
      rows.push(params.join(" "));
    }
    const body = rows.join("|");
    return name === "" ? body : `${name} ${body}`;
  }
  /** A payload for a command packet: text, garbage, or a QuickLZ-looking block. */
  commandPayload(): { payload: Uint8Array; flags: number } {
    const flags = (this.int(3) === 0 ? 0x10 : 0) | (this.int(2) === 0 ? 0x20 : 0);
    switch (this.int(4)) {
      case 0:
        return { payload: this.bytes(600), flags };
      case 1:
        return { payload: qlzLike(this), flags: flags | 0x40 };
      default:
        return { payload: new TextEncoder().encode(this.command()), flags };
    }
  }
}

function qlzLike(g: Gen): Uint8Array {
  const long = g.int(2) === 0;
  const compressed = g.int(4) !== 0;
  const flags = 0x04 | (long ? 0x02 : 0) | (compressed ? 0x01 : 0) | (g.int(8) === 0 ? 0x08 : 0);
  const header = new Uint8Array(long ? 9 : 3);
  header[0] = flags;
  const declared = g.pick([0, 1, 5, 64, 300, 0xffff, MAX_DECOMPRESSED_SIZE + 1, 0xffffffff]);
  if (long) {
    new DataView(header.buffer).setUint32(1, g.int(0xffffffff), true);
    new DataView(header.buffer).setUint32(5, declared >>> 0, true);
  } else {
    header[1] = g.int(256);
    header[2] = declared & 0xff;
  }
  const body = g.bytes(400);
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

/** An Init1 step, mostly well-formed in length, with hostile contents. */
function init1(g: Gen): Uint8Array {
  const step = g.pick([0, 1, 2, 3, 3, 3, 0x7f, 9, -1]);
  if (step === -1) return g.bytes(300);
  const length = { 0: 21, 1: 21, 2: 25, 3: 233 }[step as 0 | 1 | 2 | 3] ?? g.int(40);
  const payload = new Uint8Array(g.int(5) === 0 ? g.int(300) : length);
  for (let i = 0; i < payload.length; i++) payload[i] = g.int(256);
  if (payload.length > 0) payload[0] = step;
  if (step === 3 && payload.length >= 133) {
    const level = g.pick([0, 1, 7, 0xffffffff, 100_001, g.int(0xffffffff)]);
    new DataView(payload.buffer).setUint32(129, level >>> 0, false);
    if (g.int(4) === 0) payload.fill(0, 65, 129); // a zero modulus
  }
  return payload;
}

async function startedClient(): Promise<{ client: Client; socket: FakeSocket }> {
  let socket: FakeSocket | undefined;
  const client = new Client(identity, "fuzz.example", "Bot", {
    resolver: {
      resolve: async () => [{ addr: "127.0.0.1:9987", source: "test", expiry: new Date() }],
    },
    socketFactory: () => (socket = new FakeSocket()),
  });
  client.connect().catch(() => {});
  for (let i = 0; i < 100 && socket === undefined; i++) await settle();
  return { client, socket: socket! };
}

describe("the receive path", () => {
  it("survives anything before the handshake completes", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const g = new Gen(seed);
      const { client, socket } = await startedClient();
      const crypt = clientInternals(client).crypt;
      for (let i = 0, n = 1 + g.int(8); i < n; i++) {
        let packet: Uint8Array;
        switch (g.int(5)) {
          case 0:
            packet = g.bytes(600);
            break;
          case 1:
            packet = init1Packet(init1(g));
            break;
          case 2:
            packet = plainPacket(crypt.fakeSignature, g.int(9), 0, g.int(10), g.bytes(80));
            break;
          default: {
            const { payload, flags } = g.commandPayload();
            packet = dummyPacket(crypt, g.pick([2, 3, 6, 7]), flags, g.int(6), payload);
          }
        }
        expect(() => socket.deliver(packet), `seed ${seed}`).not.toThrow();
      }
      await settle();
      await client.disconnect();
    }
    expect(escaped).toEqual([]);
  }, 120_000);

  it("survives anything once connected, and drops what it cannot read", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const g = new Gen(seed);
      const { client, socket } = await connectedClient();
      const crypt = clientInternals(client).crypt;
      for (const name of ["textMessage", "clientEnter", "voiceData", "notification"] as const) {
        client.on(name, () => {});
      }
      let commandID = 1;
      for (let i = 0, n = 1 + g.int(8); i < n; i++) {
        let packet: Uint8Array;
        switch (g.int(6)) {
          case 0:
            packet = g.bytes(600);
            break;
          case 1:
            packet = init1Packet(init1(g));
            break;
          case 2:
            // Every type, so that the ones which must be encrypted are seen
            // arriving without it too.
            packet = plainPacket(crypt.fakeSignature, g.int(9), 0, g.int(10), g.bytes(80));
            break;
          case 3: {
            const { payload, flags } = g.commandPayload();
            packet = dummyPacket(crypt, g.pick([2, 3, 6]), flags, commandID, payload);
            break;
          }
          default: {
            const { payload, flags } = g.commandPayload();
            packet = sessionPacket(crypt, g.pick([2, 2, 3, 6]), flags, commandID++, payload);
          }
        }
        expect(() => socket.deliver(packet), `seed ${seed}`).not.toThrow();
      }
      await settle();
      await client.disconnect({ signal: AbortSignal.timeout(1) });
    }
    expect(escaped).toEqual([]);
  }, 120_000);

  it("fails the connection with a CryptoInitError on an absurd RSA challenge", async () => {
    let socket: FakeSocket | undefined;
    const client = new Client(identity, "127.0.0.1:9987", "Bot", {
      socketFactory: () => (socket = new FakeSocket()),
    });
    const connecting = client.connect();
    for (let i = 0; i < 100 && socket === undefined; i++) await settle();

    const step3 = new Uint8Array(233);
    step3[0] = 3;
    step3[128] = 1; // a non-zero modulus
    new DataView(step3.buffer).setUint32(129, 0xffffffff, false);
    socket!.deliver(init1Packet(step3));

    await expect(connecting).rejects.toBeInstanceOf(CryptoInitError);
    expect(client.status).toBe("disconnected");
  });

  it("ignores Init1 and dummy-keyed commands once connected", async () => {
    const { client, socket } = await connectedClient();
    const messages: string[] = [];
    client.on("textMessage", (m) => messages.push(m.message));
    await settle();
    const before = socket.sent.length;

    socket.deliver(init1Packet(Uint8Array.of(0x7f)));
    const text = (msg: string): Uint8Array =>
      new TextEncoder().encode(`notifytextmessage targetmode=1 msg=${msg} invokerid=2`);
    socket.deliver(dummyPacket(clientInternals(client).crypt, 2, 0x20, 1, text("forged")));
    socket.deliver(sessionPacket(clientInternals(client).crypt, 2, 0x20, 1, text("real")));
    await settle();

    expect(messages).toEqual(["real"]);
    expect(client.status).toBe("connected");
    // The real command is acknowledged; the Init1 and the forgery are not answered.
    expect(socket.sent.length - before).toBe(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("unencrypted packets once connected", () => {
  const text = (msg: string): Uint8Array =>
    new TextEncoder().encode(`notifytextmessage targetmode=1 msg=${msg} invokerid=2`);

  it("drops commands that carry the fake signature instead of a MAC", async () => {
    const { client, socket } = await connectedClient();
    const crypt = clientInternals(client).crypt;
    const messages: string[] = [];
    client.on("textMessage", (m) => messages.push(m.message));

    // The fake signature is no secret: the client's own pong carries it.
    socket.deliver(plainPacket(crypt.fakeSignature, 4, 0, 1, Uint8Array.of(0, 0)));
    const pong = socket.sent.at(-1)!;
    const signature = pong.subarray(0, 8);
    expect(Buffer.from(signature).equals(Buffer.from(crypt.fakeSignature))).toBe(true);

    const before = socket.sent.length;
    socket.deliver(plainPacket(signature, 2, 0x20, 1, text("injected")));
    socket.deliver(plainPacket(signature, 3, 0x20, 0, text("injected-low")));
    socket.deliver(
      plainPacket(
        signature,
        2,
        0x20,
        2,
        new TextEncoder().encode("notifyclientleftview clid=7 reasonid=5"),
      ),
    );
    await settle();
    expect(messages).toEqual([]);
    expect(client.status).toBe("connected");
    // Not even acknowledged.
    expect(socket.sent.length).toBe(before);

    socket.deliver(sessionPacket(crypt, 2, 0x20, 1, text("real")));
    await settle();
    expect(messages).toEqual(["real"]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("still takes plaintext acknowledgements, as TS3 and TS6 send them", async () => {
    const { client, socket } = await connectedClient();
    const crypt = clientInternals(client).crypt;
    const answer = client.exec("whoami", { timeout: 2_000 });
    await settle();
    const sent = socket.sent.at(-1)!;
    const id = (sent[8]! << 8) | sent[9]!;
    socket.deliver(plainPacket(crypt.fakeSignature, 6, 0, 1, Uint8Array.of(id >> 8, id & 0xff)));
    socket.deliver(
      sessionPacket(crypt, 2, 0x20, 1, new TextEncoder().encode("error id=0 msg=ok return_code=1")),
    );
    await expect(answer).resolves.toEqual([]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("garbage before the handshake", () => {
  it("leaves no key behind for the session to use", async () => {
    const { client, socket } = await startedClient();
    for (const [type, id] of [
      [2, 5],
      [3, 5],
      [6, 5],
      [7, 5],
      [2, 65535],
      [6, 65535],
    ] as const) {
      socket.deliver(datagram(randomBytes(8), s2cHeader(id, type), randomBytes(20)));
    }
    const alpha = randomBytes(10);
    const beta = randomBytes(54);
    const secret = randomBytes(20);
    const crypt = clientInternals(client).crypt;
    crypt.setSharedSecret(alpha, beta, secret);

    // The keys are those of the session's IV, as a crypt that never saw the
    // garbage derives them.
    const reference = new Crypt(identity);
    reference.setSharedSecret(alpha, beta, secret);
    for (const type of [2, 3, 6, 7]) {
      for (const gen of [0, 1]) {
        expect(crypt.getKeyNonce(true, 9, gen, type, false)).toEqual(
          reference.getKeyNonce(true, 9, gen, type, false),
        );
      }
    }
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

/** A client past the handshake, on a session key the test knows. */
async function connectedClient(): Promise<{ client: Client; socket: FakeSocket }> {
  const { client, socket } = await startedClient();
  clientInternals(client).crypt.setSharedSecret(randomBytes(10), randomBytes(54), randomBytes(20));
  socket.deliver(
    sessionPacket(
      clientInternals(client).crypt,
      2,
      0x20,
      0,
      new TextEncoder().encode("initserver aclid=7 virtualserver_version=3.13.7"),
    ),
  );
  await settle();
  expect(client.status).toBe("connected");
  return { client, socket };
}

describe("QuickLZ", () => {
  it("throws only its own error, and never produces more than the cap", () => {
    for (let seed = 1; seed <= CASES * 2; seed++) {
      const g = new Gen(seed);
      const input = g.int(3) === 0 ? g.bytes(64) : qlzLike(g);
      try {
        const out = new Qlz().decompress(input);
        expect(out.length).toBeLessThanOrEqual(MAX_DECOMPRESSED_SIZE);
      } catch (error) {
        expect(error, `seed ${seed}`).toBeInstanceOf(QuickLZError);
      }
    }
  });

  it("refuses a declared size over the cap before allocating", () => {
    const header = Uint8Array.of(0x07, 9, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0);
    expect(() => new Qlz().decompress(header)).toThrow(/exceeds/);
  });
});
