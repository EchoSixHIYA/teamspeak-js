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
- **Full command set** — 113 typed functions covering every command the voice protocol answers
- **Reconnection** — Opt-in retry with backoff, tuned for TeamSpeak's antiflood ban
- **Server capabilities** — Reports the server version and the uid hash it uses (SHA-1 on TS3, SHA-256 on TS6)
- **Custom transports** — Supply your own socket, for proxies, tunnels or tests
- **Dual format** — Ships ESM and CJS with full TypeScript declarations
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
const identity = generateIdentity(8);

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

// Connect
await client.connect();

// Wait until connected (with 15s timeout)
await client.waitConnected(AbortSignal.timeout(15_000));

// Stay connected until interrupted
process.on("SIGINT", async () => {
  await client.disconnect();
});
```

## API Overview

### Client Lifecycle

| Method                                        | Description                            |
| --------------------------------------------- | -------------------------------------- |
| `new Client(identity, addr, nickname, opts?)` | Create a new client                    |
| `connect()`                                   | Initiate connection to the server      |
| `waitConnected(signal?)`                      | Block until the handshake completes    |
| `disconnect()`                                | Gracefully disconnect                  |
| `clientID()`                                  | Our clid, assigned by the server       |
| `channelID()`                                 | The channel we are in                  |
| `serverCapabilities()`                        | Server version, family and uid hash    |
| `uniqueIdentifier()`                          | Our own uid, hashed as the server does |

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
| `on("poke", handler)`         | Fires when poked by a client       |
| `on("voice", handler)`        | Fires on incoming voice data       |

### Commands

Every command the voice protocol answers is a typed function, grouped by area.
Each takes a single options object and is addressed by branded ids, so a
`ChannelID` cannot be passed where a `ClientID` is meant.

```typescript
import {
  listChannels,
  createChannel,
  editChannel,
  deleteChannel,
  listClients,
  moveClient,
  kickClient,
  updateClient,
  getServerInfo,
  listServerGroups,
  addServerGroupPermission,
  listFiles,
  deleteFile,
  addBan,
  sendTextMessage,
  TextMessageTarget,
} from "@honeybbq/teamspeak-client";

const channels = await listChannels(client);

const cid = await createChannel(client, {
  channel_name: "Lounge",
  channel_topic: "the quiet one",
  channel_flag_permanent: true,
});

await moveClient(client, asClientID(client.clientID()), cid, "channel-password");
await sendTextMessage(client, TextMessageTarget.Channel, "hello", cid);
```

| Module       | Covers                                                         |
| ------------ | -------------------------------------------------------------- |
| `channels`   | Create, edit, move, delete, subscribe, channel permissions     |
| `clients`    | List, move, kick, poke, edit, the client database, permissions |
| `server`     | Server and instance settings, groups, temp passwords, bindings |
| `groups`     | Channel groups, the permission catalogue, tokens               |
| `moderation` | Bans, complaints, offline messages, text messages, the log     |
| `files`      | List, delete, rename, create directories, transfer negotiation |

> **Read [docs/voice-protocol-empty-responses.md](docs/voice-protocol-empty-responses.md) before
> using the administrative commands.** The voice protocol answers `ok` with no
> data row for a set of commands that ServerQuery answers normally —
> `servergrouplist`, `permissionlist`, the group permission lists, several
> client lookups, and the file transfer negotiation. Verified with Server Admin,
> so these are server behaviour rather than permissions. A function returning
> `[]` does not mean "nothing there".

For anything outside the typed set, `client.execCommand()` and
`client.execCommandWithResponse()` take a raw command.

### File Transfers

| Function                               | Description                       |
| -------------------------------------- | --------------------------------- |
| `client.fileTransferInitUpload(...)`   | Initialize a file upload          |
| `client.fileTransferInitDownload(...)` | Initialize a file download        |
| `fileTransferDeleteFile(client, ...)`  | Delete files on the server        |
| `uploadFileData(host, info, reader)`   | Transfer file data to the server  |
| `downloadFileData(host, info, writer)` | Receive file data from the server |

### Identity

```typescript
import { generateIdentity, identityFromString } from "@honeybbq/teamspeak-client";

// Generate a new identity with security level 8
const identity = generateIdentity(8);

// Export to string for persistent storage
const exported = identity.exportString();

// Import from a previously exported string
const restored = identityFromString(exported);

// Upgrade security level (CPU-intensive)
identity.upgradeToLevel(10);
```

### Options

```typescript
const client = new Client(identity, "ts.example.com", "Bot", {
  logger: consoleLogger,
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
application running behind a proxy has no way through.

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

## Subpath Exports

The package provides granular subpath exports for advanced use cases:

```typescript
import { Identity } from "@honeybbq/teamspeak-client/crypto";
import { Resolver } from "@honeybbq/teamspeak-client/discovery";
import { PacketHandler } from "@honeybbq/teamspeak-client/transport";
import { buildCommand, parseCommand } from "@honeybbq/teamspeak-client/command";
import { processInit1 } from "@honeybbq/teamspeak-client/handshake";
```

## Architecture

```
teamspeak-js/
├── src/
│   ├── client.ts          # Client lifecycle, connection management
│   ├── api/               # Typed command layer, one module per area
│   │   ├── command.ts     #   Shared encoder and field readers
│   │   ├── channels.ts    #   Channels and channel permissions
│   │   ├── clients.ts     #   Clients, the client database
│   │   ├── server.ts      #   Server and instance settings
│   │   ├── groups.ts      #   Channel groups, permissions, tokens
│   │   ├── moderation.ts  #   Bans, messages, the log
│   │   └── files.ts       #   File transfer commands
│   ├── capabilities.ts    # Server version and uid hash detection
│   ├── reconnect.ts       # Backoff policy and permanent-failure detection
│   ├── ids.ts             # Branded ids (ChannelID, ClientID, …)
│   ├── commands.ts        # Command sending and response tracking
│   ├── events.ts          # Event handler registration and middleware
│   ├── notifications.ts   # Server notification parsing and dispatch
│   ├── handshake.ts       # Protocol handshake orchestration
│   ├── transfer.ts        # File transfer operations
│   ├── throttle.ts        # Token-bucket rate limiter
│   ├── types.ts           # Public type definitions
│   ├── errors.ts          # Error classes
│   ├── crypto/            # ECDH, EAX encryption, identity management
│   ├── handshake/         # Crypto handshake and license verification
│   ├── transport/         # UDP packet framing, ACK, compression
│   ├── command/           # Command builder and parser
│   └── discovery/         # SRV / TSDNS / direct address resolution
├── docs/
│   └── voice-protocol-empty-responses.md   # Which commands answer empty
├── scripts/
│   ├── probe-client-commands.mts           # Which commands the protocol accepts
│   └── survey-voice-empties.mts            # Re-runs the empty-response check
├── examples/
│   └── connect.ts         # Minimal connection example
├── vite.config.ts         # Build configuration (Vite library mode)
└── tsconfig.json
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
