/**
 * Protocol plumbing for the sibling packages, `@honeybbq/teamspeak-client` and
 * `@honeybbq/teamspeak-serverquery`.
 *
 * Not public API, and not covered by semver: the packages are versioned and
 * released together, each depending on this exact version, so this can change
 * in any release.
 *
 * @internal
 * @packageDocumentation
 */

export { isCommandName } from "./command/parser.js";
export { parseClient } from "./api/parse.js";
export { parseIconID } from "./command/ids.js";
export { responseSpec } from "./command/responses.js";
export type { ResponseSpec } from "./command/responses.js";
export { parseErrorCode, parseServerError } from "./errors.js";
export { splitCommandRows, parseUint64, parseUint16, parseInt10, sleep } from "./helpers.js";
