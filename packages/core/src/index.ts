/**
 * What the TeamSpeak clients share: the command language, ids, errors, and the
 * typed commands that run on any connection able to execute a command.
 *
 * Install a client rather than this package — `@honeybbq/teamspeak-client` for
 * the voice protocol — which re-exports everything here.
 */

// Escaping, for a raw line sent with a client's `exec`.
export { escape, unescape } from "./command/command.js";

// Requests and the connections that execute them.
export { encodeRequest } from "./command/request.js";
export type {
  CommandExecutor,
  CommandOptions,
  CommandRequest,
  ParamValue,
} from "./command/request.js";

// Branded ids: a ChannelID cannot be passed where a ClientID is meant.
export {
  asBanID,
  asChannelID,
  asClientFileTransferID,
  asMessageID,
  asServerFileTransferID,
  asServerID,
  asChannelGroupID,
  asClientDBID,
  asClientID,
  asIconID,
  asPermissionID,
  asServerGroupID,
  asUID,
} from "./command/ids.js";
export type {
  BanID,
  ClientFileTransferID,
  MessageID,
  ServerFileTransferID,
  ServerID,
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
export { Reason } from "./reason.js";

// Small-integer enumerations, as named values and types.
export {
  ClientType,
  Codec,
  GroupNameMode,
  GroupType,
  LogLevel,
  PermissionTarget,
  TextMessageTarget,
  TokenType,
} from "./enums.js";

// Permissions, by id or by name.
export { permissionByID, permissionByName } from "./permission.js";
export type { Permission } from "./permission.js";

export { noopLogger, consoleLogger } from "./types.js";
export type { CommandMiddleware, FileDownloadInfo, FileUploadInfo, Logger } from "./types.js";

// Typed commands, one module per area of the protocol.
export * from "./api/channels.js";
export * from "./api/clients.js";
export * from "./api/server.js";
export * from "./api/groups.js";
export * from "./api/moderation.js";
export * from "./api/files.js";
export type { Channel, PagingOptions, PermissionEntry } from "./api/command.js";
