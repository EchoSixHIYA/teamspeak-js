/**
 * A TeamSpeak ServerQuery client.
 *
 * Everything in `@honeybbq/teamspeak-core` — the typed commands, ids, errors —
 * is re-exported here, so this is the only package a ServerQuery client needs.
 *
 * Not yet published: a skeleton until it is implemented, before 1.0.0.
 *
 * @packageDocumentation
 */

export * from "@honeybbq/teamspeak-core";

export { QueryClient } from "./client.js";
export type { QueryTransport } from "./transport.js";
