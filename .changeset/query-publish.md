---
"@honeybbq/teamspeak": minor
---

The ServerQuery client is published, as `@honeybbq/teamspeak/query`.

It runs the same typed commands the core already exports — `listChannels`,
`createChannel`, `moveClient` and the rest — over a ServerQuery connection
instead of a voice one, plus the commands only an administrator has. The
transport is one of three: raw TCP (`{ kind: "tcp", host }`, the default port
10011, TeamSpeak 3 only), SSH (`{ kind: "ssh", host, username, password }`), or
TeamSpeak 6's WebQuery (`{ kind: "web", url, apiKey }`). `custom` takes an
opener of your own.

```typescript
import { QueryClient } from "@honeybbq/teamspeak/query";
import { listChannels } from "@honeybbq/teamspeak";

const client = new QueryClient({
  transport: { kind: "tcp", host: "ts.example.com" },
  login: { name: "serveradmin", password: process.env.QUERY_PASSWORD! },
  server: { id: 1 },
});
await client.connect();
console.log(await listChannels(client));
await client.disconnect();
```

The server's notifications arrive as the core's typed events — `textMessage`,
`clientEnter`, `clientLeave`, `clientMoved`, `kicked` and `notification` —
over raw TCP and SSH. WebQuery has no session for the server to push one down
and refuses to register for them, so the client does not try, and a listener
for a server event on that transport throws a `TypeError` rather than staying
silent. `connected` and `disconnected` work on every transport.

A channel password is taken as it is written: ServerQuery hashes it
server-side, where the voice protocol wants `base64(sha1(password))`. The
client does that conversion for you, so a password moves between the two
unchanged.

`ssh2` is an optional peer dependency. Raw TCP and WebQuery need nothing but
Node, so it is only installed if you use the SSH transport; without it that
transport throws a `MissingDependencyError` naming the package, and the other
two keep working.

Reconnecting is opt-in, as for the voice client, and shares the same
`ReconnectOptions`. Its default retries everything except what cannot change:
a `login` or `use` the server refused, and an SSH account it will not
authenticate.

This entry is marked `@experimental`. It is new, and its API may change in a
minor release: the options, the transport union and the event map are all
still settling. Pin a version and read the changelog if you depend on it.
