/**
 * A clean-room TeamSpeak client: it connects over the voice protocol, the way
 * the TeamSpeak application does.
 *
 * Everything in `@honeybbq/teamspeak-core` — the typed commands, ids, errors —
 * is re-exported here, so this is the only package a voice client needs.
 */

export * from "@honeybbq/teamspeak-core";

// The client
export { Client, ClientStatus } from "./client.js";

export type {
  TextMessage,
  ClientMovedEvent,
  ClientLeftViewEvent,
  KickedEvent,
  ClientInfo,
  PokeEvent,
  VoiceData,
  EventMap,
  EventMiddleware,
  Listener,
  ServerEvent,
  ServerEventName,
  Unsubscribe,
  AddrResolver,
  ClientOptions,
  ResolvedAddr,
  SocketFactory,
  FileTransferSocketFactory,
} from "./types.js";

export {
  AlreadyConnectedError,
  EAXTagMismatchError,
  FakeSignatureMismatchError,
  FileTransferError,
  CryptoInitError,
  InvalidIdentityError,
  RemovedError,
  TimedOutError,
} from "./errors.js";

// Commands only the voice protocol has.
export * from "./api/voice.js";

// File transfer data
export { dialFileTransfer, uploadFileData, downloadFileData } from "./transfer.js";

// Server capabilities, read from the handshake
export { parseServerCapabilities, unknownServerCapabilities } from "./capabilities.js";
export type { ServerCapabilities, ServerFamily } from "./capabilities.js";

// Reconnection policy
export { backoffDelay, defaultShouldRetry, defaultBackoffPolicy } from "./reconnect.js";
export type { ReconnectOptions, BackoffPolicy } from "./reconnect.js";

// Identity
export {
  Identity,
  identityFromString,
  generateIdentity,
  getUidFromPublicKey,
} from "./crypto/index.js";
