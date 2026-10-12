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
  TextMessageEvent,
  ClientMovedEvent,
  ClientLeaveEvent,
  KickedEvent,
  NotificationEvent,
  ClientEnterEvent,
  PokeEvent,
  VoiceDataEvent,
  EventMap,
  EventMiddleware,
  Listener,
  ServerEvent,
  ServerEventName,
  Unsubscribe,
  AddrResolver,
  ClientOptions,
  ResolvedAddr,
  DatagramSocket,
  SocketFactory,
  FileTransferSocketFactory,
} from "./types.js";

export {
  AlreadyConnectedError,
  FileTransferError,
  CryptoInitError,
  InvalidAddressError,
  InvalidIdentityError,
  RemovedError,
  ConnectionTimeoutError,
} from "./errors.js";

// Commands only the voice protocol has.
export * from "./api/voice.js";

// File transfer data
export { dialFileTransfer, uploadFileData, downloadFileData } from "./transfer.js";
export type { FileTransferOptions } from "./transfer.js";

// Server capabilities, read from the handshake
export { unknownServerCapabilities } from "./capabilities.js";
export type { ServerCapabilities, ServerFamily } from "./capabilities.js";

// Tracing points for diagnostics_channel subscribers
export { commandChannel, packetChannel } from "./diagnostics.js";
export type { CommandTrace, PacketTrace } from "./diagnostics.js";

// Reconnection policy
export { backoffDelay, defaultShouldRetry, defaultBackoffPolicy } from "./reconnect.js";
export type { ReconnectOptions, BackoffPolicy } from "./reconnect.js";

// Identity
export {
  Identity,
  parseIdentity,
  generateIdentity,
  generateIdentitySync,
  uidFromPublicKey,
} from "./crypto/index.js";
export type { UIDAlgorithm } from "./crypto/index.js";
