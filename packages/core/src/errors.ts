import { ErrorCode } from "./errorcode.js";
import { asPermissionID, type PermissionID } from "./command/ids.js";

/**
 * The base of every error the SDK throws, so `instanceof TeamspeakError` tells
 * the SDK's failures from anything else.
 */
export class TeamspeakError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeamspeakError";
  }
}

/**
 * A refusal from the server: the `error` line that answered a command carried a
 * non-zero code.
 *
 * Compare {@link ServerError.code} with {@link ErrorCode} to tell refusals apart.
 */
export class ServerError extends TeamspeakError {
  /** The server's error code. A server may report one {@link ErrorCode} does not name. */
  readonly code: number;
  /** The server's own text, such as "invalid channel password". */
  readonly serverMessage: string;
  /** Detail the server adds to some refusals (`extra_msg`). */
  readonly extraMessage: string | undefined;
  /** The permission a refused permission check failed on, when the server names one (`failed_permid`). */
  readonly failedPermissionID: PermissionID | undefined;

  constructor(
    code: number,
    serverMessage: string,
    details: {
      extraMessage?: string | undefined;
      failedPermissionID?: PermissionID | undefined;
    } = {},
  ) {
    const extra = details.extraMessage ? ` (${details.extraMessage})` : "";
    super(`TeamSpeak server error: ${serverMessage}${extra} (code ${code})`);
    this.name = "ServerError";
    this.code = code;
    this.serverMessage = serverMessage;
    this.extraMessage = details.extraMessage;
    this.failedPermissionID = details.failedPermissionID;
  }
}

/**
 * A command's answer did not arrive within its timeout. The command may still
 * have taken effect on the server.
 */
export class CommandTimeoutError extends TeamspeakError {
  /** The name of the command that timed out; never its parameters. */
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
 * Read an error id. One that is missing or unreadable is reported as
 * {@link ErrorCode.Undefined}: an error line that does not say what went wrong
 * has still not said that nothing did.
 */
export function parseErrorCode(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return ErrorCode.Undefined;
  return Number(raw);
}

/**
 * Parse and handle an `error` command from the server.
 * Returns the error (or null on success) and the resolved return_code.
 */
export function parseServerError(params: Record<string, string>): {
  err: ServerError | null;
  rc: number | null;
} {
  const code = parseErrorCode(params["id"]);
  const rcStr = params["return_code"];

  let err: ServerError | null = null;
  if (code !== ErrorCode.OK) {
    const failedPermid = params["failed_permid"];
    err = new ServerError(code, params["msg"] ?? "", {
      extraMessage: params["extra_msg"] || undefined,
      failedPermissionID:
        failedPermid !== undefined && /^\d+$/.test(failedPermid)
          ? asPermissionID(Number(failedPermid))
          : undefined,
    });
  }

  let rc: number | null = null;
  if (rcStr !== undefined && rcStr !== "") {
    const parsed = parseInt(rcStr, 10);
    if (!isNaN(parsed)) rc = parsed;
  }

  return { err, rc };
}
