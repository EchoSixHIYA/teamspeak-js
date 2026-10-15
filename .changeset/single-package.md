---
"@honeybbq/teamspeak": major
"@honeybbq/teamspeak-client": major
---

`@honeybbq/teamspeak-core` and `@honeybbq/teamspeak-client` are now one package, `@honeybbq/teamspeak`, with two entry points. The ServerQuery client will join it as a third in a 1.x release.

Each entry exports only its own symbols, so the client entry no longer re-exports the core:

| You imported                                                                                                       | Import it from now on        |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `Client`, `Identity`, `ClientStatus`, the client's errors, `commandChannel`, ... from `@honeybbq/teamspeak-client` | `@honeybbq/teamspeak/client` |
| `listChannels`, `ErrorCode`, `TeamspeakError`, ids, events, ... from `@honeybbq/teamspeak-client`                  | `@honeybbq/teamspeak`        |
| anything from `@honeybbq/teamspeak-core`                                                                           | `@honeybbq/teamspeak`        |

```ts
// before
import { Client, listChannels, ErrorCode } from "@honeybbq/teamspeak-client";
// after
import { Client } from "@honeybbq/teamspeak/client";
import { listChannels, ErrorCode } from "@honeybbq/teamspeak";
```

Replace `@honeybbq/teamspeak-core` and `@honeybbq/teamspeak-client` with `@honeybbq/teamspeak` in your `package.json`. Nothing else about the API changed.

`@honeybbq/teamspeak-client` stays on npm as a thin package that re-exports both entries, so code that imports everything from it keeps working through 1.x. New code should use `@honeybbq/teamspeak`. `@honeybbq/teamspeak-core` is not published any more, and `@honeybbq/teamspeak-core/internal` is gone.
