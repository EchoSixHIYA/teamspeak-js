/**
 * A TeamSpeak ServerQuery client.
 *
 * Only what belongs to ServerQuery is exported here. The typed commands, ids
 * and errors every client shares come from `@honeybbq/teamspeak`.
 *
 * Not yet exported or published: a skeleton until it is implemented, in a 1.x
 * release.
 *
 * @packageDocumentation
 */

export { QueryClient } from "./client.js";
export type { QueryTransport } from "./transport.js";
