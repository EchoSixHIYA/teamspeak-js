/**
 * A TeamSpeak ServerQuery client.
 *
 * ServerQuery is the administrative interface to a TeamSpeak server: the voice
 * protocol's commands, plus the ones only an administrator can run. This entry
 * runs the same typed commands as `@honeybbq/teamspeak`,
 * over raw TCP (10011), SSH (10022) or TeamSpeak 6's HTTP WebQuery (10080).
 *
 * Only what belongs to ServerQuery is exported here. The typed commands, ids
 * and errors every client shares come from `@honeybbq/teamspeak`.
 *
 * @experimental This entry point is new and may change in a minor release: the
 * `QueryClient` API, its options and its event map are all still settling.
 * Pin a version and read the changelog if you depend on it.
 *
 * @packageDocumentation
 */

export { QueryClient } from "./client.js";
export type {
  QueryClientOptions,
  QueryEventCategory,
  QueryEventMap,
  QueryEventsOption,
  QueryTransportOptions,
} from "./client.js";

export type { QueryTransport } from "./transport.js";

// Reconnection: the client's default retry decision, and the shared options.
export { defaultShouldRetry } from "./reconnect.js";

// Errors unique to ServerQuery.
export { MissingDependencyError, QueryAuthError } from "./errors.js";

// The transports each `transport` kind builds on, for a caller that wants one
// directly or that is writing its own `custom` opener.
export { StreamTransport } from "./stream.js";
export type { QueryStream } from "./stream.js";
export { connectTcp } from "./tcp.js";
export type { TcpOptions } from "./tcp.js";
export { connectSsh } from "./ssh.js";
export type { SshOptions } from "./ssh.js";
export { WebQueryHttpError, WebQueryTransport } from "./web.js";
export type { WebQueryOptions } from "./web.js";
