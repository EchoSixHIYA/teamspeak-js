/**
 * A command as the typed layer describes it, before a transport encodes it.
 *
 * The typed commands run on any connection that can execute a command — the
 * voice client today, ServerQuery later — and the two disagree about how some
 * values go on the wire. A channel password is the case that matters: the
 * voice protocol expects `base64(sha1(password))`, while ServerQuery takes the
 * password itself and hashes it server-side. So a request says *which*
 * parameters are passwords and leaves their encoding to the transport.
 */

import { buildCommandOrdered } from "./command.js";

/** A parameter value as a caller may supply it. */
export type ParamValue = string | number | bigint | boolean | undefined;

/** A command and its parameters, in the order they are sent. */
export interface CommandRequest {
  /** The command's name, such as `clientlist`. */
  readonly command: string;
  /**
   * Its parameters, as wire name and value pairs, in the order they are sent;
   * an undefined value is omitted.
   */
  readonly params?: ReadonlyArray<readonly [string, ParamValue]>;
  /** Names of the parameters that carry a channel password. */
  readonly passwords?: readonly string[];
}

/** How long a command may take, and how to abandon it. */
export interface CommandOptions {
  /** Abandons the command; it then rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds to wait for the answer before failing with a CommandTimeoutError. */
  readonly timeout?: number | undefined;
}

/** A connection the typed commands can run on. */
export interface CommandExecutor {
  /** Send a command and return the rows that answer it. */
  send(request: CommandRequest, options?: CommandOptions): Promise<Record<string, string>[]>;
}

/**
 * Turn a value into its wire form.
 *
 * Returns undefined for values that should be omitted entirely — an unset
 * optional field — because sending `foo=` is not the same as not sending it:
 * for `channel_password` the first clears the password and the second leaves it
 * alone. Callers distinguish "unset" from "empty string" by passing undefined
 * versus "".
 */
function encodeValue(value: ParamValue): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

/**
 * Render a request as a command line.
 *
 * `encodePassword` is the transport's rule for password parameters. An empty
 * password is sent as is: it means "no password", in every encoding.
 */
export function encodeRequest(
  request: CommandRequest,
  encodePassword: (password: string) => string,
): string {
  const passwords = request.passwords ?? [];
  const out: Array<readonly [string, string]> = [];
  for (const [key, value] of request.params ?? []) {
    // Flags (`-uid`) are switches: present when true, absent otherwise.
    if (key.startsWith("-")) {
      if (value === true) out.push([key, ""]);
      continue;
    }
    if (passwords.includes(key) && typeof value === "string" && value !== "") {
      out.push([key, encodePassword(value)]);
      continue;
    }
    const encoded = encodeValue(value);
    if (encoded !== undefined) out.push([key, encoded]);
  }
  return buildCommandOrdered(request.command, out);
}
