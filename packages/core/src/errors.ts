export class TeamspeakError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeamspeakError";
  }
}

export class ServerError extends TeamspeakError {
  readonly id: string;
  readonly serverMessage: string;

  constructor(id: string, serverMessage: string) {
    super(`TeamSpeak server error: ${serverMessage} (id=${id})`);
    this.name = "ServerError";
    this.id = id;
    this.serverMessage = serverMessage;
  }
}

export class CommandTimeoutError extends TeamspeakError {
  readonly command: string;

  constructor(command: string) {
    super(`command timeout: ${command}`);
    this.name = "CommandTimeoutError";
    this.command = command;
  }
}

/**
 * A command was sent with no connection to send it on, or the connection was
 * lost while it waited for its answer.
 *
 * Without it such a command would wait out its full timeout and fail as if the
 * server were slow.
 */
export class NotConnectedError extends TeamspeakError {
  constructor(options?: ErrorOptions) {
    super("not connected", options);
    this.name = "NotConnectedError";
  }
}

/**
 * Parse and handle an `error` command from the server.
 * Returns the error (or null on success) and the resolved return_code.
 */
export function parseServerError(params: Record<string, string>): {
  err: Error | null;
  rc: number | null;
} {
  const id = params["id"] ?? "0";
  const msg = params["msg"] ?? "";
  const rcStr = params["return_code"];

  let err: Error | null = null;
  if (id !== "0") {
    err = new ServerError(id, msg);
  }

  let rc: number | null = null;
  if (rcStr !== undefined && rcStr !== "") {
    const parsed = parseInt(rcStr, 10);
    if (!isNaN(parsed)) rc = parsed;
  }

  return { err, rc };
}
