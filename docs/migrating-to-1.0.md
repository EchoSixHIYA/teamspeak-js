# Migrating to 1.0

From `@honeybbq/teamspeak-client` 0.x to 1.0. The per-release details are in
each package's CHANGELOG; this guide is the path through them.

## Packages

| 0.x                          | 1.0                                                                       |
| ---------------------------- | ------------------------------------------------------------------------- |
| `@honeybbq/teamspeak-client` | `@honeybbq/teamspeak-client`, which re-exports `@honeybbq/teamspeak-core` |

Install only `@honeybbq/teamspeak-client`; the core comes with it and every
import below is from the client package. Both are ESM-only, as 0.x was; on
Node 20.19 and later `require()` loads them too.

## Identities

```ts
// 0.x
const id = generateIdentity(8);
const saved = id.toString(); // the private key, also in every log line
const restored = identityFromString(saved);

// 1.0
const id = await generateIdentity(8, { signal });
const saved = id.export(); // toString() no longer reveals the key
const restored = parseIdentity(saved);
```

`generateIdentitySync(level)` keeps the blocking form.

An `Identity` is immutable and opaque. `upgradeToLevel(level, { signal })`
returns a new identity instead of changing this one, and refuses a level above
160; `offset` is read-only, and the private key is no longer a property —
`export()` is the one way to the secret. `new Identity(...)` is gone: make one
with `generateIdentity` or `parseIdentity`, which throws only an
`InvalidIdentityError`.

```ts
// 0.x
await id.upgradeToLevel(10);
const uid = getUidFromPublicKey(id.publicKeyBase64());

// 1.0
const stronger = await id.upgradeToLevel(10);
const uid = id.uid("sha1"); // or uidFromPublicKey(publicKey, "sha1"); TS6 uses "sha256"
```

## Connecting

```ts
// 0.x
await client.connect();
await client.waitConnected(AbortSignal.timeout(15_000));

// 1.0
await client.connect({ signal: AbortSignal.timeout(15_000) });
```

`connect()` resolves once the handshake completes and rejects with its
failure, such as the server's `ServerError` for a wrong password.
`disconnect({ signal })` bounds the goodbye. `await using client = new
Client(...)` disconnects at the end of the scope.

The default logger is silent: pass `logger: console` to see what 0.x printed.
`TEAMSPEAK_TRACE_RAW` is gone; subscribe to the `honeybbq:teamspeak:command`
and `honeybbq:teamspeak:packet` diagnostics channels instead.

## Commands

The helpers 0.x had are typed functions taking the client first and branded
ids, with a last, optional `{ signal, timeout }`:

| 0.x                                                        | 1.0                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `listChannels(client)`                                     | `listChannels(client)`                                                                                                   |
| `listClients(client)`                                      | `listClients(client, { uid, away, ... })`                                                                                |
| `clientMove(client, clid, cid, password)`                  | `moveClient(client, clid, cid, password)`                                                                                |
| `poke(client, clid, message)`                              | `pokeClient(client, clid, message)`                                                                                      |
| `sendTextMessage(client, mode, target, message)`           | `sendPrivateMessage(client, clid, message)`, `sendChannelMessage(client, message)`, `sendServerMessage(client, message)` |
| `fileTransferDeleteFile(client, cid, paths)`               | `deleteFile(client, cid, paths)`                                                                                         |
| `client.fileTransferInitUpload(cid, path, password, size)` | `initFileUpload(client, cid, path, size, { password })`                                                                  |
| `client.fileTransferInitDownload(cid, path, password)`     | `initFileDownload(client, cid, path, { password })`                                                                      |
| `client.execCommandWithResponse(line, ms)`                 | `client.exec(line, { timeout: ms })`                                                                                     |
| `client.execCommand(line, ms)`                             | `client.exec(line, { timeout: ms })`                                                                                     |
| `client.sendCommandNoWait(line)`                           | `client.execNoWait(line)`                                                                                                |

About a hundred more commands are new: channels, groups, permissions, bans,
files, tokens and the server. An id comes from a result, an event, or a
constructor: `asChannelID(5)`, `asClientID(3)`.

Many queries were answered with nothing in 0.x, because the server sends their
data in a notification. They now return the data.

## Errors

```ts
// 0.x
if (err instanceof ServerError && err.id === "2568") { … }

// 1.0
if (err instanceof ServerError && err.code === ErrorCode.PermissionsClientInsufficient) { … }
```

`code` is a number; `ErrorCode` names every code. A wrong server or channel
password is no longer retried by the reconnect loop.

## Events

```ts
// 0.x
client.on("kicked", (reason) => …);
client.on("clientLeave", (e) => e.reasonID);

// 1.0
const stop = client.on("kicked", (e) => e.reasonMessage); // and e.reason, e.invokerName
client.on("clientLeave", (e) => e.reason);
stop();

for await (const message of client.events("textMessage", { signal })) { … }
```

`on()` returns a function that removes the listener, and `once()` is new.
Listeners run one at a time, in arrival order. `disconnected` is `undefined`
only after `disconnect()`; otherwise it is the cause, such as a `RemovedError`
for a kick or a `TimedOutError`. Channel kicks now reach `kicked`. Ids in
events are branded, `VoiceData.clientId` is `clientID`, and `clientEnter`
delivers the same `ClientEntry` that `listClients` returns.

Middleware is set with the `commandMiddleware` and `eventMiddleware` options;
`useCommandMiddleware()` and `useEventMiddleware()` are gone. Event middleware
receives `{ name, payload }`.

## Transports

`socketFactory` returns a `DatagramSocket` — a `node:dgram` socket still is
one — and `fileTransferSocketFactory` any `Duplex`. File transfers take
`{ signal }` as their last argument:

```ts
await client.uploadFileData(host, info, Readable.from([data]), { signal });
```

## Reconnecting

`isPermanentFailure(err)` is `defaultShouldRetry(err)`, with the opposite
meaning. `backoffDelay(policy, attempt)` takes no random source, and
`defaultBackoffPolicy` is frozen.

## Status

The client's state is read through getters: `client.status`,
`client.clientID`, `client.channelID`, `client.uid` (was
`uniqueIdentifier()`) and `client.serverCapabilities` — no parentheses, and
the ids are already branded.

`ClientStatus` is a string union (`"disconnected"`, `"connecting"`,
`"connected"`) rather than a `const enum`; compare against
`ClientStatus.Connected` as before.
