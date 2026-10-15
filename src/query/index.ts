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
export { StreamTransport } from "./stream.js";
export type { QueryStream } from "./stream.js";
export { connectTcp } from "./tcp.js";
export type { TcpOptions } from "./tcp.js";
export { connectSsh } from "./ssh.js";
export type { SshOptions } from "./ssh.js";
export { WebQueryHttpError, WebQueryTransport } from "./web.js";
export type { WebQueryOptions } from "./web.js";
