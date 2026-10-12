// Main client
export { Client, ClientStatus } from "./client.js";
export type { ClientState } from "./client.js";

// Public types
export type {
  TextMessage,
  ClientMovedEvent,
  ClientLeftViewEvent,
  ClientInfo,
  ChannelInfo,
  PokeEvent,
  VoiceData,
  FileUploadInfo,
  FileDownloadInfo,
  EventMap,
  CommandMiddleware,
  EventMiddleware,
  Logger,
  AddrResolver,
  ClientOptions,
  ResolvedAddr,
  EscapedString,
} from "./types.js";
export { noopLogger, consoleLogger } from "./types.js";

// Errors
export {
  TeamspeakError,
  ServerError,
  CommandTimeoutError,
  AlreadyConnectedError,
  EAXTagMismatchError,
  FakeSignatureMismatchError,
  FileTransferError,
  NotConnectedError,
  CryptoInitError,
  InvalidIdentityError,
} from "./errors.js";

// Typed command layer, one module per area of the protocol.
export * from "./api/channels.js";
export * from "./api/voice.js";
export * from "./api/clients.js";
export * from "./api/server.js";
export * from "./api/groups.js";
export * from "./api/moderation.js";
export * from "./api/files.js";
export type { PermissionEntry } from "./api/command.js";

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

// File transfer utilities
export { dialFileTransfer, uploadFileData, downloadFileData } from "./transfer.js";

// Server capabilities
export { parseServerCapabilities, unknownServerCapabilities } from "./capabilities.js";
export type { ServerCapabilities, ServerFamily } from "./capabilities.js";
export type { SocketFactory, FileTransferSocketFactory } from "./types.js";

// Reconnection policy
export { backoffDelay, isPermanentFailure, defaultBackoffPolicy } from "./reconnect.js";
export type { ReconnectOptions, BackoffPolicy } from "./reconnect.js";

// Crypto (re-exported for identity management)
export {
  Identity,
  identityFromString,
  generateIdentity,
  getUidFromPublicKey,
} from "./crypto/index.js";
