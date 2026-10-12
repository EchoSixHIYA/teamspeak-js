/**
 * Integration tests against a live TeamSpeak 3 server.
 *
 * Opt-in: these tests only run when TEAMSPEAK_ADDR is set:
 *
 *   docker run -d --name ts3 -e TS3SERVER_LICENSE=accept -p 9987:9987/udp teamspeak:latest
 *   TEAMSPEAK_ADDR=127.0.0.1:9987 pnpm test --reporter=verbose src/integration.test.ts
 *
 * A single shared client is reused across all tests to avoid the TS3
 * anti-flood protection that bans IPs reconnecting too quickly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSocket } from "node:dgram";
import { generateIdentity } from "./crypto/identity.js";
import { Client, ClientStatus } from "./client.js";
import { Readable, Writable } from "node:stream";
import { listChannels, getChannelInfo, createChannel } from "./api/channels.js";
import {
  listClients,
  getClientInfo,
  moveClient,
  getClientUIDByID,
  getClientDBIDByUID,
  getClientNameByUID,
  getClientNameByDBID,
  getClientIDs,
} from "./api/clients.js";
import { deleteFile, initFileDownload, initFileUpload, listFiles } from "./api/files.js";
import { sendTextMessage, TextMessageTarget } from "./api/moderation.js";
import { getServerInfo, listServerGroups } from "./api/server.js";
import { asChannelID, asClientDBID, asClientID, asUID } from "./command/ids.js";
import type { ClientInfo } from "./types.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const DEFAULT_CHANNEL_PASSWORD = process.env["TEAMSPEAK_DEFAULT_CHANNEL_PASSWORD"] ?? "";
const PASSWORD_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const PASSWORD_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";
const SERVER_HAS_PASSWORD = process.env["TEAMSPEAK_SERVER_HAS_PASSWORD"] === "1";
const SKIP = !ADDR;
const USES_CONNECT_AUTH =
  SERVER_PASSWORD !== "" || DEFAULT_CHANNEL !== "" || DEFAULT_CHANNEL_PASSWORD !== "";

// Shared connection — established once for the entire suite
let sharedClient: Client;
let selfClientEnter: Promise<ClientInfo>;

beforeAll(async () => {
  if (SKIP) return;

  const identity = generateIdentity(8);
  const client = new Client(identity, ADDR!, "ts-js-integ", {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
    defaultChannelPassword: DEFAULT_CHANNEL_PASSWORD,
    logger: {
      debug: () => {},
      info: (msg, ...args) => console.log("[INFO]", msg, ...args),
      warn: (msg, ...args) => console.warn("[WARN]", msg, ...args),
      error: (msg, ...args) => console.error("[ERROR]", msg, ...args),
    },
  });
  selfClientEnter = new Promise((resolve) => {
    client.on("clientEnter", (info) => {
      if (info.id === client.clientID()) resolve(info);
    });
  });

  await client.connect();

  await client.waitConnected(AbortSignal.timeout(30_000));

  sharedClient = client;
}, 40_000);

afterAll(async () => {
  for (const peer of peers.values()) await peer.disconnect().catch(() => {});
  if (!sharedClient) return;
  await sharedClient.disconnect();
}, 20_000);

// Extra connections opened by individual tests. With default settings TS3's
// antiflood only tolerates about three rapid connects from one IP before it
// silently drops new handshakes, so tests share these instead of each opening
// their own. Together with the shared client this keeps the suite at three.
const peers = new Map<string, Client>();

async function connectPeer(nickname: string, setup?: (client: Client) => void): Promise<Client> {
  const peer = new Client(generateIdentity(8), ADDR!, nickname, {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
    defaultChannelPassword: DEFAULT_CHANNEL_PASSWORD,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  setup?.(peer);
  peers.set(nickname, peer);
  await peer.connect();
  await peer.waitConnected(AbortSignal.timeout(30_000));
  return peer;
}

describe.skipIf(SKIP)("Integration — live TeamSpeak server", () => {
  it("connects with optional handshake auth configuration", () => {
    if (USES_CONNECT_AUTH) {
      console.log(
        `connect auth enabled: serverPassword=${SERVER_PASSWORD !== ""} defaultChannel=${DEFAULT_CHANNEL !== ""} defaultChannelPassword=${DEFAULT_CHANNEL_PASSWORD !== ""}`,
      );
    }
    expect(sharedClient.clientID()).toBeGreaterThan(0);
  });

  it("reports the handshake failure and disconnects when the password is rejected", async () => {
    // Opt-in: needs a server that actually has a password set. The rejected
    // handshake still counts toward TS3's antiflood budget (about three rapid
    // connects per IP), so with it enabled the suite needs four: raise
    // virtualserver_antiflood_points_needed_ip_block on the test server or
    // later tests are banned with id=3329.
    if (!SERVER_HAS_PASSWORD) return;

    const rejected = new Client(generateIdentity(8), ADDR!, "ts-js-bad-password", {
      serverPassword: "definitely-not-the-password",
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const disconnected = new Promise<Error | undefined>((resolve) =>
      rejected.on("disconnected", (err) => resolve(err)),
    );

    await rejected.connect();
    // The cause must be the server's rejection, not the caller's own timeout.
    await expect(rejected.waitConnected(AbortSignal.timeout(8_000))).rejects.toThrow(
      /invalid server password/,
    );
    expect(rejected.status).toBe(ClientStatus.Disconnected);
    await expect(disconnected).resolves.toBeInstanceOf(Error);
  }, 20_000);

  it("receives a non-zero server-assigned client ID", () => {
    const clid = sharedClient.clientID();
    console.log(`connected: clid=${clid}`);
    expect(clid).toBeGreaterThan(0);
  });

  it("clientEnter reports the server-assigned channel ID", async () => {
    const info = await Promise.race([
      selfClientEnter,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("clientEnter timeout")), 8_000),
      ),
    ]);

    console.log(`clientEnter: clid=${info.id} cid=${info.channelID}`);
    expect(info.channelID).toBeGreaterThan(0n);
  }, 10_000);

  it("reports the server's version and uid hash", async () => {
    // Capabilities come from initserver, so they are available as soon as the
    // handshake completes and need no extra round trip.
    const caps = sharedClient.serverCapabilities();
    console.log(
      `capabilities: version="${caps.version}" family=${caps.family} uid=${caps.uidAlgorithm}`,
    );
    expect(caps.version).not.toBe("");
    expect(["ts3", "ts6"]).toContain(caps.family);
    expect(caps.uidAlgorithm).toBe(caps.family === "ts6" ? "sha256" : "sha1");

    // The reported hash must be the one the server applies, not just a claim:
    // uniqueIdentifier() hashes with it, and the server agrees with the result.
    const mine = sharedClient.uniqueIdentifier();
    const clients = await listClients(sharedClient);
    const self = clients.find((c) => c.id === sharedClient.clientID());
    expect(self?.uid).toBe(mine);
  }, 15_000);

  it("uniqueIdentifier matches what the server reports for us", async () => {
    // TS3 hashes the public key with SHA-1 and TS6 with SHA-256. Hard-coding
    // either one silently never matches on the other server, which is exactly
    // how a UID-based self-identification passed on TS3 and failed on TS6.
    const mine = sharedClient.uniqueIdentifier();
    // The algorithm comes from the server's version, so it must be stable
    // within one connection.
    expect(sharedClient.uniqueIdentifier()).toBe(mine);

    const clients = await listClients(sharedClient);

    const self = clients.find((c) => c.id === sharedClient.clientID());
    console.log(`uid: ours=${mine} server=${self?.uid}`);
    expect(self?.uid).toBe(mine);
  }, 15_000);

  it("listClients — finds ourselves in the list", async () => {
    const clients = await listClients(sharedClient);

    expect(clients.length).toBeGreaterThan(0);

    const ownID = sharedClient.clientID();
    const self = clients.find((c) => c.id === ownID);
    console.log(`self: clid=${ownID} nick="${self?.nickname}" cid=${self?.channelID}`);
    expect(self).toBeDefined();
  }, 15_000);

  it("a command issued immediately after connecting is not contaminated", async () => {
    // The server pushes its own channellist as part of the welcome sequence,
    // unprompted. Asking for channellist before that sequence ends used to fold
    // the server's own rows into the response: duplicate cids plus a phantom
    // cid=0, every time, while the same call a second later was correct.
    const identity = generateIdentity(8);
    const fresh = new Client(identity, ADDR!, "ts-js-welcome", {
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    await fresh.connect();
    await fresh.waitConnected(AbortSignal.timeout(30_000));

    const immediate = await listChannels(fresh);
    const ids = immediate.map((c) => c.id);
    console.log(`immediate listChannels: ${immediate.length} rows cids=${ids.join(",")}`);

    expect(ids).not.toContain(0n);
    expect(new Set(ids.map(String)).size).toBe(ids.length);

    await fresh.disconnect();
  }, 45_000);

  it("listChannels — at least one channel exists", async () => {
    const channels = await listChannels(sharedClient);

    expect(channels.length).toBeGreaterThan(0);
    console.log(`channels: ${channels.length} found, first="${channels[0]?.name}"`);
  }, 15_000);

  it("joins the configured default channel when provided", async () => {
    if (DEFAULT_CHANNEL === "") return;

    const [channels, clients] = await Promise.all([
      listChannels(sharedClient),
      listClients(sharedClient),
    ]);

    const self = clients.find((client) => client.id === sharedClient.clientID());
    const currentChannel = channels.find((channel) => channel.id === self?.channelID);

    expect(self).toBeDefined();
    expect(currentChannel?.name).toBe(DEFAULT_CHANNEL);
  }, 15_000);

  it("getChannelInfo returns the channel that was asked for", async () => {
    // channelinfo answers with pid and the settings but no cid — the channel is
    // whatever was asked for. Reading cid from the row gave 0, so a caller
    // could not tell one channel's info from another's.
    const channels = await listChannels(sharedClient);
    const first = channels[0]!;
    const info = await getChannelInfo(sharedClient, asChannelID(first.id));

    console.log(`channelinfo: id=${info.id} name="${info.name}" parent=${info.parentID}`);
    expect(info.id).toBe(first.id);
    expect(info.name).toBe(first.name);
    // channellist reports cpid and channelinfo reports pid; both must land in
    // parentID or one of the two paths silently reads 0.
    expect(info.parentID).toBe(first.parentID);
  }, 15_000);

  it("listChannels — exposes channel_order", async () => {
    const channels = await listChannels(sharedClient);

    // Every row must carry an order, and a server with more than one channel
    // must not report the same order for all of them — that was the symptom
    // when channel_order was parsed and discarded.
    expect(channels.every((c) => typeof c.order === "bigint")).toBe(true);
    if (channels.length > 1) {
      expect(new Set(channels.map((c) => String(c.order))).size).toBeGreaterThan(1);
    }
  }, 15_000);

  it("clientEnter — batched rows inherit fields omitted by the server", async () => {
    // TeamSpeak compresses pipe-separated notifycliententerview batches by
    // dropping fields that repeat the previous row, so a second client in the
    // same channel arrives with no ctid at all. The shared client plus one peer
    // in the same channel reliably produce that batch for a joining observer.
    const observed = new Map<string, bigint>();
    await connectPeer("ts-js-peer");
    await connectPeer("ts-js-observer", (observer) =>
      observer.on("clientEnter", (info) => observed.set(info.nickname, info.channelID)),
    );
    await new Promise((r) => setTimeout(r, 1_000));

    const shared = observed.get("ts-js-integ");
    const peer = observed.get("ts-js-peer");
    console.log(`batched enter: shared cid=${shared} peer cid=${peer}`);
    expect(shared).toBeDefined();
    expect(peer).toBeDefined();
    expect(shared).not.toBe(0n);
    expect(peer).toBe(shared);
  }, 70_000);

  // These answer with a notification rather than data rows. The SDK used to
  // collect only data rows, report an empty success for every one of them, and
  // pin that as server behaviour in this very test.
  it("client lookups answer with their data", async () => {
    const ownID = asClientID(sharedClient.clientID());
    const me = await getClientInfo(sharedClient, ownID);
    const uid = asUID(me["client_unique_identifier"]!);
    const dbid = asClientDBID(BigInt(me["client_database_id"]!));
    const nickname = me["client_nickname"]!;

    expect(await getClientUIDByID(sharedClient, ownID)).toBe(uid);
    expect(await getClientDBIDByUID(sharedClient, uid)).toBe(dbid);
    expect(await getClientNameByUID(sharedClient, uid)).toEqual({
      databaseID: dbid,
      name: nickname,
    });
    expect(await getClientNameByDBID(sharedClient, dbid)).toBe(nickname);
    expect(await getClientIDs(sharedClient, uid)).toContain(ownID);
  }, 20_000);

  it("listServerGroups — includes the server's default group", async () => {
    const [groups, server] = await Promise.all([
      listServerGroups(sharedClient),
      getServerInfo(sharedClient),
    ]);
    const defaultGroup = BigInt(server["virtualserver_default_server_group"]!);

    expect(groups.length).toBeGreaterThan(1);
    expect(groups.map((g) => g.id)).toContain(defaultGroup);
  }, 15_000);

  // The voice protocol answers channelcreate with notifychannelcreated, not a
  // cid row, so the id came back as 0.
  it("createChannel — returns the new channel's id", async () => {
    const before = sharedClient.channelID();
    const name = `ts-js-${Date.now().toString(36)}`;
    const cid = await createChannel(sharedClient, { channel_name: name });
    try {
      expect(cid).not.toBe(0n);
      expect((await getChannelInfo(sharedClient, cid)).name).toBe(name);
    } finally {
      // Creating a channel over the voice protocol moves the creator into it,
      // and the server deletes a temporary channel once its last client
      // leaves — so moving back is the cleanup.
      await moveClient(sharedClient, asClientID(sharedClient.clientID()), asChannelID(before));
    }
  }, 20_000);

  // The key arrives in a notification after the command has already returned;
  // without it there is nothing to dial.
  it("file transfer — uploads and downloads the same bytes", async () => {
    const cid = asChannelID(sharedClient.channelID());
    const path = `/ts-js-${Date.now().toString(36)}.bin`;
    const payload = Buffer.from("hello over file transfer");
    const host = ADDR!.slice(0, ADDR!.lastIndexOf(":"));

    const upload = await initFileUpload(sharedClient, cid, path, BigInt(payload.length));
    expect(upload.fileTransferKey).not.toBe("");
    await sharedClient.uploadFileData(host, upload, Readable.from([payload]));

    try {
      const files = await listFiles(sharedClient, cid);
      expect(files.map((f) => `/${f.name}`)).toContain(path);

      const download = await initFileDownload(sharedClient, cid, path);
      expect(download.size).toBe(BigInt(payload.length));
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      });
      await sharedClient.downloadFileData(host, download, sink);
      expect(Buffer.concat(chunks).equals(payload)).toBe(true);
    } finally {
      await deleteFile(sharedClient, cid, [path]);
    }
  }, 30_000);

  it("getClientInfo — returns our own nickname", async () => {
    const info = await getClientInfo(sharedClient, asClientID(sharedClient.clientID()));

    expect(Object.keys(info).length).toBeGreaterThan(0);
    console.log("clientinfo keys:", Object.keys(info).sort().join(", "));
    expect(info["client_nickname"]).toBeDefined();
  }, 15_000);

  it("clientMove — joins a password-protected channel", async () => {
    // Opt-in: needs a channel whose password the bot does not have permission
    // to bypass. Without the base64(sha1(pw)) encoding the server answers 781.
    if (PASSWORD_CHANNEL === "" || PASSWORD_CHANNEL_PASSWORD === "") return;

    const channels = await listChannels(sharedClient);

    const target = channels.find((c) => c.name === PASSWORD_CHANNEL);
    expect(target).toBeDefined();

    await moveClient(
      sharedClient,
      asClientID(sharedClient.clientID()),
      target!.id,
      PASSWORD_CHANNEL_PASSWORD,
    );
  }, 20_000);

  it("reconnects after a dropped connection", async () => {
    // The socket is dropped underneath the client, which is what a network
    // failure looks like. A bot that cannot recover is not usable unattended.
    //
    // Recovery is not immediate: the server still holds the old session and
    // refuses a reconnect from the same identity with 521 "too many clones
    // already connected" until it reaps the zombie, so the loop has to keep
    // trying rather than give up on the first refusal.
    let socket: import("node:dgram").Socket | undefined;
    const recovering = new Client(generateIdentity(8), ADDR!, "ts-js-reconnect", {
      defaultChannel: DEFAULT_CHANNEL,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      reconnect: { enabled: true, backoff: { initialDelayMs: 500, maxDelayMs: 4_000 } },
      socketFactory: (family) => {
        socket = createSocket(family === 6 ? "udp6" : "udp4");
        return socket;
      },
    });

    await recovering.connect();
    await recovering.waitConnected(AbortSignal.timeout(30_000));
    const firstID = recovering.clientID();
    expect(firstID).toBeGreaterThan(0);

    socket!.close();

    const recovered = await new Promise<boolean>((resolve) => {
      const poll = setInterval(() => {
        if (recovering.status === ClientStatus.Connected && recovering.clientID() !== firstID) {
          clearInterval(poll);
          resolve(true);
        }
      }, 250);
      setTimeout(() => {
        clearInterval(poll);
        resolve(false);
      }, 60_000);
    });

    console.log(`reconnect: ${firstID} -> ${recovering.clientID()}`);
    expect(recovered).toBe(true);

    // A reconnect is a fresh session, so it must be usable, not merely
    // connected.
    const channels = await listChannels(recovering);
    expect(channels.length).toBeGreaterThan(0);

    await recovering.disconnect();
  }, 110_000);

  it("does not reconnect after an explicit disconnect", async () => {
    // A deliberate disconnect means the caller is done. Retrying would keep a
    // process alive that asked to stop.
    const client = new Client(generateIdentity(8), ADDR!, "ts-js-noreconnect", {
      defaultChannel: DEFAULT_CHANNEL,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      reconnect: { enabled: true, backoff: { initialDelayMs: 200 } },
    });

    await client.connect();
    await client.waitConnected(AbortSignal.timeout(30_000));
    await client.disconnect();

    await new Promise((r) => setTimeout(r, 2_500));
    expect(client.status).toBe(ClientStatus.Disconnected);
  }, 45_000);

  it("sendWhisper — delivers a VoiceWhisper frame to the target", async () => {
    // Reuses the observer from the batch test to stay within the antiflood
    // budget. Needs i_client_whisper_power on the bot's server group.
    const listener = peers.get("ts-js-observer") ?? (await connectPeer("ts-js-observer"));

    const received = new Promise<boolean>((resolve) => {
      listener.on("voiceData", () => resolve(true));
      setTimeout(() => resolve(false), 5_000);
    });

    const frame = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    for (let i = 0; i < 12; i++) {
      sharedClient.sendWhisper(frame, [listener.clientID()], 5);
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(await received).toBe(true);
  }, 45_000);

  it("onTextMessage — receives message sent to self", async () => {
    const received = new Promise<string>((resolve) => {
      sharedClient.on("textMessage", (msg) => {
        resolve(msg.message);
      });
    });

    const ownID = sharedClient.clientID();
    await sendTextMessage(
      sharedClient,
      TextMessageTarget.Client,
      "hello from ts-js-integ",
      asClientID(ownID),
    );

    const msg = await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("text message timeout")), 8_000),
      ),
    ]);

    expect(msg).toBe("hello from ts-js-integ");
  }, 15_000);
});
