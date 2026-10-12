import { Reason, TeamspeakError } from "@honeybbq/teamspeak-core";

export class AlreadyConnectedError extends TeamspeakError {
  constructor() {
    super("already connecting or connected");
    this.name = "AlreadyConnectedError";
  }
}

export class EAXTagMismatchError extends TeamspeakError {
  constructor() {
    super("EAX tag mismatch");
    this.name = "EAXTagMismatchError";
  }
}

export class FakeSignatureMismatchError extends TeamspeakError {
  constructor() {
    super("fake signature mismatch");
    this.name = "FakeSignatureMismatchError";
  }
}

export class FileTransferError extends TeamspeakError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileTransferError";
  }
}

export class CryptoInitError extends TeamspeakError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CryptoInitError";
  }
}

export class InvalidIdentityError extends TeamspeakError {
  constructor(message = "invalid identity format") {
    super(message);
    this.name = "InvalidIdentityError";
  }
}

/**
 * The server stopped answering: nothing arrived, or a packet went
 * unacknowledged, for a minute.
 */
export class TimedOutError extends TeamspeakError {
  constructor() {
    super("connection timed out: the server stopped answering");
    this.name = "TimedOutError";
  }
}

/**
 * The server ended this client's session: a kick, a ban, or the server
 * stopping. The default reconnect policy retries a server that stopped, but
 * not a kick or a ban.
 */
export class RemovedError extends TeamspeakError {
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
