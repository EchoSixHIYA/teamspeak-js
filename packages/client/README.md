<div align="center">

# @honeybbq/teamspeak-client

**A clean-room TeamSpeak client protocol library written in pure TypeScript.**

Compatible with TeamSpeak 3, 5 & 6. No proprietary SDK. No copy-pasted code.

[![CI](https://github.com/honeybbq/teamspeak-js/actions/workflows/ci.yml/badge.svg)](https://github.com/honeybbq/teamspeak-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@honeybbq/teamspeak-client)](https://www.npmjs.com/package/@honeybbq/teamspeak-client)
[![Node Version](https://img.shields.io/node/v/@honeybbq/teamspeak-client)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

## Features

- **Full protocol handshake** — ECDH key exchange, RSA puzzle, EAX-encrypted transport
- **Command & notification system** — Send commands, receive server events
- **Event-driven API** — Register handlers for text messages, client enter/leave, channel moves, kicks, etc.
- **Voice data** — Send Opus voice packets (codec 4 & 5)
- **File transfers** — Upload, download, and delete files on the server
- **Address resolution** — SRV records, TSDNS, and direct address support
- **Middleware** — Pluggable command and event middleware chains
- **Built-in rate limiter** — Token-bucket throttling to prevent server-side flood kicks
- **Identity management** — Generate, import/export, and upgrade security level of identities
- **Full command set** — 115 typed functions covering every command the voice protocol answers
- **Reconnection** — Opt-in retry with backoff, tuned for TeamSpeak's antiflood ban
- **Server capabilities** — Reports the server version and the uid hash it uses (SHA-1 on TS3, SHA-256 on TS6)
- **Custom transports** — Supply your own socket, for proxies, tunnels or tests
- **ESM with types** — Ships ES modules with full TypeScript declarations
- **Zero native deps** — Pure TypeScript, no native addons required

## Installation

```bash
npm install @honeybbq/teamspeak-client
# or
pnpm add @honeybbq/teamspeak-client
```

Requires **Node.js 20.19** or later.

## Quick Start

```typescript
import { Client, generateIdentity } from "@honeybbq/teamspeak-client";

// Generate a new identity (or load an existing one)
const identity = await generateIdentity(8);

// Create the client
const client = new Client(identity, "localhost", "TSBot", {
  serverPassword: process.env.TEAMSPEAK_SERVER_PASSWORD,
  defaultChannel: "Lobby",
  defaultChannelPassword: process.env.TEAMSPEAK_DEFAULT_CHANNEL_PASSWORD,
});

// Register event handlers
client.on("connected", () => {
  console.log("Connected to server!");
});

client.on("textMessage", (msg) => {
  console.log(`[${msg.invokerName}]: ${msg.message}`);
});

client.on("disconnected", (err) => {
  console.log("Disconnected:", err?.message ?? "clean");
});

// Connect; resolves once the handshake completes.
await client.connect({ signal: AbortSignal.timeout(15_000) });

// Stay connected until interrupted
process.on("SIGINT", async () => {
  await client.disconnect();
});
```

## API Overview

### Client Lifecycle

| Method                                        | Description                                    |
| --------------------------------------------- | ---------------------------------------------- |
| `new Client(identity, addr, nickname, opts?)` | Create a new client                            |
| `connect({ signal? })`                        | Connect; resolves once the handshake completes |
| `disconnect({ signal? })`                     | Leave the server and close the connection      |
| `clientID()`                                  | Our clid, assigned by the server               |
| `channelID()`                                 | The channel we are in                          |
| `serverCapabilities()`                        | Server version, family and uid hash            |
| `uniqueIdentifier()`                          | Our own uid, hashed as the server does         |

### Events

| Method                        | Description                        |
| ----------------------------- | ---------------------------------- |
| `on("connected", handler)`    | Fires when fully connected         |
| `on("disconnected", handler)` | Fires on disconnect                |
| `on("textMessage", handler)`  | Fires on text messages             |
| `on("clientEnter", handler)`  | Fires when a client joins          |
| `on("clientLeave", handler)`  | Fires when a client leaves         |
| `on("clientMoved", handler)`  | Fires when a client moves channels |
| `on("kicked", handler)`       | Fires when the bot is kicked       |
| `on("poked", handler)`        | Fires when poked by a client       |
| `on("voiceData", handler)`    | Fires on incoming voice data       |

`on()` and `once()` return a function that removes the listener, which is also
a `Disposable` (`using listener = client.on(...)`). Listeners run one at a
time, in the order their events arrived, so a listener may call the client and
await an answer. `disconnected` delivers `undefined` after `disconnect()`, and
the cause otherwise — a `TimedOutError`, or a `RemovedError` for a kick, a ban
or a server stopping. `await using client = new Client(...)` disconnects when
the scope ends.

`events(name, { signal })` is the same as an async iterator, buffering events
that arrive while the loop body runs:

```typescript
for await (const msg of client.events("textMessage", { signal })) {
  await reply(msg);
}
```

`notification` delivers every notification as it arrived, for the ones the SDK
does not model.

### Commands

Every command the voice protocol answers is a typed function, grouped by area.
Each is addressed by branded ids, so a `ChannelID` cannot be passed where a
`ClientID` is meant, and each takes a last, optional `{ signal?, timeout? }`
to abandon it or bound how long it waits.

```typescript
import {
  listChannels,
  createChannel,
  moveClient,
  kickClient,
  sendChannelMessage,
  addServerGroupPermission,
  iterateClientDatabase,
  permissionByName,
  asClientID,
  Codec,
  Reason,
} from "@honeybbq/teamspeak-client";

const channels = await listChannels(client, { signal: AbortSignal.timeout(5_000) });

const cid = await createChannel(client, {
  name: "Lounge",
  topic: "the quiet one",
  codec: Codec.OpusVoice,
  isPermanent: true,
});

await moveClient(client, asClientID(client.clientID()), cid, "channel-password");
await sendChannelMessage(client, "hello");
await kickClient(client, someone, Reason.KickChannel, "take a break");

await addServerGroupPermission(client, sgid, {
  permission: permissionByName("i_client_talk_power"),
  value: 50,
});

for await (const entry of iterateClientDatabase(client)) {
  console.log(entry.nickname, entry.lastConnectedAt);
}
```

Options objects use camelCase names (`maxClients` for `channel_maxclients`),
and only the fields you set are sent: an unset field leaves the setting alone,
while `""` sends it empty — `editChannel(client, cid, { password: "" })` clears
a password. A key an options type does not name is never sent. The exceptions
are `editServer` and `editInstance`, which take the raw `virtualserver_*` and
`serverinstance_*` properties as `getServerInfo` reports them.

Results are camelCase too. Timestamps are `Date`s (`undefined` where the server
sends 0 for "never"), durations are milliseconds with an `Ms` suffix
(`idleTimeMs`, `durationMs`), and a permission is a `Permission`, built with
`permissionByID` or `permissionByName`. Small enumerations — `GroupType`,
`Codec`, `TokenType`, `LogLevel` and the rest — are objects of named values with
a type of the same name.

| Module       | Covers                                                         |
| ------------ | -------------------------------------------------------------- |
| `channels`   | Create, edit, move, delete, subscribe, channel permissions     |
| `clients`    | List, move, kick, poke, edit, the client database, permissions |
| `server`     | Server and instance settings, groups, temp passwords, bindings |
| `groups`     | Channel groups, the permission catalogue, tokens               |
| `moderation` | Bans, complaints, offline messages, text messages, the log     |
| `files`      | List, delete, rename, create directories, transfer negotiation |

Many of these commands are answered over the voice protocol with a
notification rather than data rows — `servergrouplist` with
`notifyservergrouplist`, `ftinitupload` with `notifystartupload` after the
command has already succeeded. The client pairs each answer with its command,
so this is invisible to callers; [docs/voice-protocol-responses.md](https://github.com/HoneyBBQ/teamspeak-js/blob/main/docs/voice-protocol-responses.md)
has the measured table. A refusal is always thrown, never returned as an empty
result.

For anything outside the typed set, `client.exec(line, { signal?, timeout? })`
sends a raw command line and resolves to the rows that answer it.

### File Transfers

Negotiate with the `files` module, then move the bytes over TCP:

```typescript
import { Readable } from "node:stream";
import { initFileUpload } from "@honeybbq/teamspeak-client";

const info = await initFileUpload(client, cid, "/notes.txt", BigInt(data.length));
await client.uploadFileData(host, info, Readable.from([data]));
```

| Function                                                | Description                       |
| ------------------------------------------------------- | --------------------------------- |
| `initFileUpload(client, ...)`                           | Negotiate an upload               |
| `initFileDownload(client, ...)`                         | Negotiate a download              |
| `client.uploadFileData(host, info, data, { signal? })`  | Transfer file data to the server  |
| `client.downloadFileData(host, info, out, { signal? })` | Receive file data from the server |

### Identity

```typescript
import { generateIdentity, parseIdentity } from "@honeybbq/teamspeak-client";

// Generate a new identity with security level 8
const identity = await generateIdentity(8);

// Export to string for persistent storage
const exported = identity.export();

// Import from a previously exported string
const restored = parseIdentity(exported);

// Upgrade security level (CPU-intensive)
await identity.upgradeToLevel(10);
```

### Options

```typescript
const client = new Client(identity, "ts.example.com", "Bot", {
  logger: consoleLogger, // silent unless set
  resolver: customResolver,
  commandMiddleware: [loggingMiddleware],
  eventMiddleware: [filterMiddleware],
  serverPassword: process.env.TEAMSPEAK_SERVER_PASSWORD,
  defaultChannel: "Lobby",
  defaultChannelPassword: process.env.TEAMSPEAK_DEFAULT_CHANNEL_PASSWORD,
});
```

Connection auth options:

- `serverPassword`: plain-text server password; sent as the TeamSpeak protocol hash during `clientinit`
- `defaultChannel`: default channel name requested during `clientinit`
- `defaultChannelPassword`: plain-text password for `defaultChannel`; sent as the TeamSpeak protocol hash

### Diagnostics

The client logs nothing unless given a `logger`. For tracing, it publishes on
two [`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
channels, which cost nothing without a subscriber:

- `honeybbq:teamspeak:command` (`commandChannel`), a tracing channel: `start`
  when a command is sent, `asyncEnd` when its answer arrives, `error` when it
  fails.
- `honeybbq:teamspeak:packet` (`packetChannel`): every command the server sends.

Both carry the command's name, never its parameters, which hold password hashes
and privilege keys.

### Reconnection

Off by default: a silent reconnect makes an outage look like a healthy session.
An explicit `disconnect()` never reconnects, whatever the policy says.

```typescript
const client = new Client(identity, "ts.example.com", "Bot", {
  reconnect: {
    enabled: true,
    backoff: { initialDelayMs: 1_000, maxDelayMs: 60_000, factor: 2, jitter: 0.2 },
    // Optional: decide for yourself which failures are worth retrying.
    shouldRetry: (err, attempt) => attempt < 10,
  },
});
```

The defaults are conservative because TeamSpeak **bans an IP after roughly
three rapid connects** — a retry loop without a delay bans itself, and the ban
outlasts the outage it was recovering from. Recovery is also not instant even
when it succeeds: the server holds the dropped session for a while and refuses a
reconnect with `521 too many clones already connected` until it reaps it, so the
loop keeps trying rather than giving up on the first refusal.

### Custom transports

`fileTransferSocketFactory` and `socketFactory` are the only seams into the
network layer. Without them the SDK always creates its own sockets, so an
application running behind a proxy has no way through. `socketFactory` returns
a `DatagramSocket` — a `node:dgram` socket, or anything with the few methods
it names — and `fileTransferSocketFactory` any `Duplex` stream, such as the
socket a SOCKS library returns.

```typescript
const client = new Client(identity, "ts.example.com", "Bot", {
  // UDP, for the voice and command channel.
  socketFactory: (family) => createSocket(family === 6 ? "udp6" : "udp4"),
  // TCP, dialled separately by each file transfer.
  fileTransferSocketFactory: (host, port) => createConnection({ host, port }),
});
```

### Server capabilities

```typescript
const caps = client.serverCapabilities();
// { version: "6.0.0-beta13.1", major: 6, family: "ts6", uidAlgorithm: "sha256" }
```

Read from `initserver` during the handshake, so it costs no extra round trip.
The uid hash matters because TS3 hashes a client's public key with SHA-1 and TS6
with SHA-256 — a client that assumes either one computes an identifier the other
server never sends.

## Packages

This package is the voice client. It depends on
[`@honeybbq/teamspeak-core`](https://github.com/HoneyBBQ/teamspeak-js/tree/main/packages/core) — the command language, ids, errors and
typed commands it shares with the ServerQuery client — and re-exports all of
it, so this is the only package to install.

The protocol internals (crypto, handshake, transport) are not exported. They
change with the protocol, and exporting them would have made every change a
breaking one.

## Architecture

```
packages/client/
├── src/
│   ├── client.ts          # Client lifecycle, connection management
│   ├── commands.ts        # Command sending and response tracking
│   ├── api/voice.ts       # Commands only the voice protocol has
│   ├── capabilities.ts    # Server version and uid hash detection
│   ├── reconnect.ts       # Backoff policy and permanent-failure detection
│   ├── events.ts          # Event handler registration and middleware
│   ├── notifications.ts   # Server notification parsing and dispatch
│   ├── handshake.ts       # Protocol handshake orchestration
│   ├── transfer.ts        # File transfer data connections
│   ├── throttle.ts        # Token-bucket rate limiter
│   ├── crypto/            # ECDH, EAX encryption, identity management
│   ├── handshake/         # Crypto handshake and license verification
│   ├── transport/         # UDP packet framing, ACK, compression
│   └── discovery/         # SRV / TSDNS / direct address resolution
└── examples/
    └── connect.ts         # Minimal connection example
```

## Related

- **[teamspeak-go](https://github.com/honeybbq/teamspeak-go)** — The original Go implementation this library is ported from

## Acknowledgments

Protocol knowledge was primarily informed by the [TSLib](https://github.com/Splamy/TS3AudioBot) implementation in [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) by Splamy. Huge thanks to the TS3AudioBot project and its contributors.

## Disclaimer

TeamSpeak is a registered trademark of [TeamSpeak Systems GmbH](https://teamspeak.com/). This project is not affiliated with, endorsed by, or associated with TeamSpeak Systems GmbH in any way.

This library is a **clean-room implementation** developed from publicly available documentation, protocol analysis of network traffic, and independent research. No proprietary TeamSpeak SDK code, headers, or libraries were used in its creation.

## License

[MIT](LICENSE)
