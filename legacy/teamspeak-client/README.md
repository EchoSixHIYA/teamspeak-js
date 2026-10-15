# @honeybbq/teamspeak-client

This package was renamed to [`@honeybbq/teamspeak`](https://www.npmjs.com/package/@honeybbq/teamspeak).
It still installs and re-exports everything from both entries of the new
package, so existing imports keep working through 1.x, but new code should
import from the new name:

| Before                                                      | Now                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `import { Client } from "@honeybbq/teamspeak-client"`       | `import { Client } from "@honeybbq/teamspeak/client"` |
| `import { listChannels } from "@honeybbq/teamspeak-client"` | `import { listChannels } from "@honeybbq/teamspeak"`  |
| `import { listChannels } from "@honeybbq/teamspeak-core"`   | `import { listChannels } from "@honeybbq/teamspeak"`  |

Documentation: https://github.com/HoneyBBQ/teamspeak-js
