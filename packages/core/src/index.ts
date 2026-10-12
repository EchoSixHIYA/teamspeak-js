/**
 * What the TeamSpeak clients share: the command language, ids, errors, and the
 * typed commands that run on any connection able to execute a command.
 *
 * Install a client rather than this package — `@honeybbq/teamspeak-client` for
 * the voice protocol — which re-exports everything here.
 */

// The command language: escaping, parsing, building.
export { escape, unescape, buildCommand, buildCommandOrdered } from "./command/command.js";
export type { Command } from "./command/command.js";
export { parseCommand } from "./command/parser.js";

// Requests and the connections that execute them.
export { encodeRequest } from "./command/request.js";
export type { CommandExecutor, CommandRequest, ParamValue } from "./command/request.js";

// Branded ids: a ChannelID cannot be passed where a ClientID is meant.
export {
  asChannelID,
  asChannelGroupID,
  asClientDBID,
  asClientID,
  asIconID,
  asPermissionID,
  asServerGroupID,
  asUID,
} from "./command/ids.js";
export type {
  ChannelGroupID,
  ChannelID,
  ClientDBID,
  ClientID,
  IconID,
  PermissionID,
  ServerGroupID,
  UID,
} from "./command/ids.js";

export { TeamspeakError, ServerError, CommandTimeoutError, NotConnectedError } from "./errors.js";
export { ErrorCode } from "./errorcode.js";

export { noopLogger, consoleLogger } from "./types.js";
export type {
  CommandMiddleware,
  EscapedString,
  FileDownloadInfo,
  FileUploadInfo,
  Logger,
} from "./types.js";

// Typed commands, one module per area of the protocol.
export * from "./api/channels.js";
export * from "./api/clients.js";
export * from "./api/server.js";
export * from "./api/groups.js";
export * from "./api/moderation.js";
export * from "./api/files.js";
export type { PermissionEntry } from "./api/command.js";
