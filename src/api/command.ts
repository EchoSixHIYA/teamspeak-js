/**
 * Typed command layer.
 *
 * Every command the voice protocol accepts is one function here, taking a
 * single options object. The options object — rather than positional
 * parameters — is what lets a command gain an optional parameter later without
 * breaking callers, and several commands have no positional reading at all
 * (`channeledit` takes eight).
 *
 * Functions that only send a command return `Promise<void>`; functions that
 * read return a parsed type. Nothing here re-encodes ids by hand: the branded
 * types in `ids.ts` and the encoder below turn an options object into wire
 * parameters in one place.
 */

import { buildCommandOrdered, unescape } from "../command/command.js";
import { prepareClientPassword } from "../handshake.js";
import type { Client } from "../client.js";
import { asChannelID } from "../command/ids.js";
import type { ChannelID, IconID } from "../command/ids.js";

const DEFAULT_TIMEOUT = 10_000;

// ---- Encoder ----------------------------------------------------------------

/** A parameter value as a caller may supply it. */
export type ParamValue = string | number | bigint | boolean | undefined;

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
 * Build the parameter list for a command, skipping unset optionals.
 *
 * `password` fields are hashed rather than sent as given: the client protocol
 * expects `base64(sha1(password))` for `clientmove`'s `cpw`, unlike raw
 * ServerQuery. Doing it here means no call site can forget.
 */
function encode(
  command: string,
  params: ReadonlyArray<readonly [string, ParamValue]>,
  passwordFields: readonly string[] = [],
): string {
  const out: Array<readonly [string, string]> = [];
  for (const [key, value] of params) {
    if (passwordFields.includes(key) && typeof value === "string" && value !== "") {
      out.push([key, prepareClientPassword(value)]);
      continue;
    }
    const encoded = encodeValue(value);
    if (encoded !== undefined) out.push([key, encoded]);
  }
  return buildCommandOrdered(command, out);
}

// ---- Shared helpers ---------------------------------------------------------

/**
 * Send a command that produces no data and wait for the server's answer.
 *
 * `passwordFields` are the parameter names the server expects as
 * `base64(sha1(value))`; naming them here keeps every call site from having to
 * remember, which is how a raw password used to reach the server and fail 781.
 */
async function exec(
  client: Client,
  command: string,
  params: ReadonlyArray<readonly [string, ParamValue]> = [],
  passwordFields: readonly string[] = [],
): Promise<void> {
  await client.execCommand(encode(command, params, passwordFields), DEFAULT_TIMEOUT);
}

/** Send a command and return its response rows. */
async function query(
  client: Client,
  command: string,
  params: ReadonlyArray<readonly [string, ParamValue]> = [],
  passwordFields: readonly string[] = [],
): Promise<Record<string, string>[]> {
  return client.execCommandWithResponse(encode(command, params, passwordFields), DEFAULT_TIMEOUT);
}

/** Read a base64/escaped string field, tolerating absence. */
const str = (row: Record<string, string>, key: string): string =>
  unescape(row[key] ?? "");

/** Read a bigint field, tolerating absence. */
const big = (row: Record<string, string>, key: string): bigint => {
  const raw = row[key];
  if (raw === undefined || raw === "") return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
};

/** Read a number field, tolerating absence. */
const num = (row: Record<string, string>, key: string): number => {
  const raw = row[key];
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Read a boolean field: the protocol writes 0/1. */
const bool = (row: Record<string, string>, key: string): boolean => num(row, key) !== 0;

export { exec, query, str, big, num, bool, encode };

// ---- Result types -----------------------------------------------------------

/** A channel as returned by `channellist` or `channelinfo`. */
export interface Channel {
  id: ChannelID;
  /**
   * The channel this one sits under.
   *
   * `channellist` names this `cpid` and `channelinfo` names it `pid` — the same
   * value under two keys, which is why both are read here.
   */
  parentID: ChannelID;
  name: string;
  topic: string;
  description: string;
  order: bigint;
  hasPassword: boolean;
  isDefault: boolean;
  isPermanent: boolean;
  codec: number;
  codecQuality: number;
  maxClients: number;
  neededTalkPower: number;
  iconID: IconID;
  uniqueIdentifier: string;
}

function parseChannel(row: Record<string, string>): Channel {
  return {
    id: asChannelID(big(row, "cid")),
    parentID: asChannelID(big(row, "pid") || big(row, "cpid")),
    name: str(row, "channel_name"),
    topic: str(row, "channel_topic"),
    description: str(row, "channel_description"),
    order: big(row, "channel_order"),
    hasPassword: bool(row, "channel_flag_password"),
    isDefault: bool(row, "channel_flag_default"),
    isPermanent: bool(row, "channel_flag_permanent"),
    codec: num(row, "channel_codec"),
    codecQuality: num(row, "channel_codec_quality"),
    maxClients: num(row, "channel_maxclients"),
    neededTalkPower: num(row, "channel_needed_talk_power"),
    iconID: big(row, "channel_icon_id") as IconID,
    uniqueIdentifier: str(row, "channel_unique_identifier"),
  };
}

export { parseChannel };
