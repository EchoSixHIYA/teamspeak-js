# teamspeak-js

TeamSpeak SDKs for TypeScript, in one repository and released together.

| Package                                         | What it is                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`@honeybbq/teamspeak-client`](packages/client) | A clean-room client that connects over the voice protocol, the way the TeamSpeak application does |
| [`@honeybbq/teamspeak-core`](packages/core)     | What the clients share: the command language, ids, errors, and the typed commands                 |

Install the client and nothing else; it pulls in the core and re-exports all of
it. 1.0 is in beta, so for now that means `npm install @honeybbq/teamspeak-client@beta`.

A ServerQuery client, [`@honeybbq/teamspeak-serverquery`](packages/serverquery),
is being written and isn't published yet. It will run the same typed commands.
There's a Go version of all this too:
[teamspeak-go](https://github.com/honeybbq/teamspeak-go).

Upgrading from 0.x? [docs/migrating-to-1.0.md](docs/migrating-to-1.0.md) walks
through every change.

## Development

```sh
pnpm install
pnpm check        # typecheck, lint, format
pnpm test         # unit tests for every package
```

The integration suite runs against a live server. `scripts/ts3-fixture.sh`
provisions one — channels, permissions, relaxed antiflood — and writes
`ts3-fixture.env`:

```sh
docker run -d --name ts3 -e TS3SERVER_LICENSE=accept \
  -p 9987:9987/udp -p 10011:10011 -p 30033:30033 teamspeak:latest
TS3_QUERY_HOST=127.0.0.1 ./scripts/ts3-fixture.sh
set -a; . ./ts3-fixture.env; set +a
pnpm test:integration
```

CI runs it against both TS3 and TS6.

`docs/voice-protocol-responses.md` records where the voice protocol puts each
command's answer, measured on both server generations;
`scripts/probe-response-shapes.mts` re-runs that measurement.

## License

MIT
