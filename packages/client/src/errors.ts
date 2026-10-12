import { TeamspeakError } from "@honeybbq/teamspeak-core";

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
