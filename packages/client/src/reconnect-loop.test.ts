import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Logger } from "@honeybbq/teamspeak-core";
import { Client, clientInternals } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { FakeSocket, sessionPacket } from "./testing/fake-server.js";

const identity = generateIdentitySync(0);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await sleep(2);
  expect(condition()).toBe(true);
}

/** A reconnecting client on fake sockets, with what it logged. */
function reconnectingClient(): { client: Client; sockets: FakeSocket[]; logs: string[] } {
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const logger: Logger = {
    debug() {},
    info: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
    error: (msg) => logs.push(msg),
  };
  const client = new Client(identity, "127.0.0.1:9987", "Bot", {
    logger,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnect: { backoff: { initialDelayMs: 20, maxDelayMs: 20, jitter: 0 } },
  });
  return { client, sockets, logs };
}

/** Complete the handshake on `socket`, with `extra` lines in the same datagram. */
function finishHandshake(client: Client, socket: FakeSocket, extra = ""): void {
  const crypt = clientInternals(client).crypt;
  crypt.setSharedSecret(randomBytes(10), randomBytes(54), randomBytes(20));
  const lines = `initserver aclid=7 virtualserver_version=3.13.7${extra}`;
  socket.deliver(sessionPacket(crypt, 2, 0x20, 0, new TextEncoder().encode(lines)));
}

async function connectedClient(): Promise<ReturnType<typeof reconnectingClient>> {
  const made = reconnectingClient();
  const connecting = made.client.connect();
  await until(() => made.sockets.length === 1);
  finishHandshake(made.client, made.sockets[0]!);
  await connecting;
  return made;
}

describe("the reconnect loop", () => {
  it("keeps retrying when its own attempt drops before the loop resumes", async () => {
    const { client, sockets, logs } = await connectedClient();
    sockets[0]!.close();
    await until(() => sockets.length === 2);

    // The server finishes the handshake and stops in the same datagram.
    finishHandshake(
      client,
      sockets[1]!,
      "\nnotifyclientleftview clid=7 reasonid=11 reasonmsg=stop",
    );
    await until(() => sockets.length === 3);
    expect(logs).not.toContain("reconnected");

    finishHandshake(client, sockets[2]!);
    await until(() => logs.includes("reconnected"));
    expect(client.status).toBe("connected");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});
