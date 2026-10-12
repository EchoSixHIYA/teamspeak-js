import { Reason, TeamspeakError } from "@honeybbq/teamspeak-core";

/** `connect()` was called on a client that is connecting or connected. */
export class AlreadyConnectedError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "AlreadyConnectedError";

  constructor() {
    super("already connecting or connected");
    this.name = "AlreadyConnectedError";
  }
}

/**
 * A packet failed authentication: it was corrupted, or not from the server.
 * Internal: the packet is dropped, and this never reaches a caller.
 */
export class EAXTagMismatchError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "EAXTagMismatchError";

  constructor() {
    super("EAX tag mismatch");
    this.name = "EAXTagMismatchError";
  }
}

/**
 * An unencrypted packet failed its integrity check. Internal: the packet is
 * dropped, and this never reaches a caller.
 */
export class FakeSignatureMismatchError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "FakeSignatureMismatchError";

  constructor() {
    super("fake signature mismatch");
    this.name = "FakeSignatureMismatchError";
  }
}

/** A file transfer connection failed: it could not be opened, or broke during the transfer. */
export class FileTransferError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "FileTransferError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileTransferError";
  }
}

/**
 * The handshake failed on what the server sent: a malformed or out-of-range
 * Init1 step, public key, license or proof. `connect()` rejects with it, the
 * underlying failure as its `cause`.
 */
export class CryptoInitError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "CryptoInitError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CryptoInitError";
  }
}

/** An identity string `parseIdentity()` cannot read. */
export class InvalidIdentityError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "InvalidIdentityError";

  constructor(message = "invalid identity format", options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidIdentityError";
  }
}

/**
 * The server stopped answering: nothing arrived, or a packet went
 * unacknowledged, for a minute.
 */
export class ConnectionTimeoutError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "ConnectionTimeoutError";

  constructor() {
    super("connection timed out: the server stopped answering");
    this.name = "ConnectionTimeoutError";
  }
}

/**
 * The server ended this client's session: a kick, a ban, or the server
 * stopping. The default reconnect policy retries a server that stopped, but
 * not a kick or a ban.
 */
export class RemovedError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "RemovedError";

  /** Why: `Reason.KickServer`, `KickServerBan`, `ServerStop` or `ServerShutdown`. */
  readonly reason: number;
  /** The reason the server or the invoker gave, if any. */
  readonly reasonMessage: string;
  /** Who removed the client, for a kick or a ban. */
  readonly invokerName: string;

  constructor(reason: number, reasonMessage: string, invokerName: string) {
    let message = `removed from the server: ${reasonName(reason)}`;
    if (invokerName) message += ` by ${invokerName}`;
    if (reasonMessage) message += `: ${reasonMessage}`;
    super(message);
    this.name = "RemovedError";
    this.reason = reason;
    this.reasonMessage = reasonMessage;
    this.invokerName = invokerName;
  }
}

function reasonName(reason: number): string {
  switch (reason) {
    case Reason.KickServer:
      return "kicked from server";
    case Reason.KickServerBan:
      return "banned from server";
    case Reason.ServerStop:
      return "server stopped";
    case Reason.ServerShutdown:
      return "server shut down";
    default:
      return `reason ${reason}`;
  }
}
