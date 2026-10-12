# @honeybbq/teamspeak-core

What the TeamSpeak clients in [teamspeak-js](https://github.com/HoneyBBQ/teamspeak-js)
share: the command language (escaping, parsing, building), branded ids, errors,
and the typed commands, which run on any `CommandExecutor`.

You do not normally install this directly. Install a client —
[`@honeybbq/teamspeak-client`](https://www.npmjs.com/package/@honeybbq/teamspeak-client)
for the voice protocol — which re-exports everything here.

`@honeybbq/teamspeak-core/internal` is protocol plumbing for those sibling
packages. It is not public API and carries no semver promise; the packages are
released together, each depending on this exact version.

## Compatibility

The open sets — `ErrorCode`, `Reason` and the enumeration tables (`Codec`,
`GroupType`, `TextMessageTarget`, …) — may gain members in a minor release, so
a `switch` over one needs a default case. Parsed results carry such values as a
plain `number`.

## License

MIT
