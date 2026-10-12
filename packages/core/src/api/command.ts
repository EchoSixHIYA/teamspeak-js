/**
 * Typed command layer.
 *
 * Every command both the voice protocol and ServerQuery accept is one function
 * here, running on any CommandExecutor. Functions that only send a command
 * return `Promise<void>`; functions that read return a parsed type. Nothing
 * here re-encodes ids by hand: the branded types in `ids.ts` and the request
 * encoder turn parameters into wire form in one place.
 */

import { TeamspeakError } from "../errors.js";
import type { CommandExecutor, ParamValue } from "../command/request.js";
import { asChannelID } from "../command/ids.js";
import type { ChannelID, IconID, PermissionID } from "../command/ids.js";

// ---- Shared helpers ---------------------------------------------------------

/**
 * Send a command that produces no data and wait for the server's answer.
 *
 * `passwords` names the parameters that carry a channel password. Naming them
 * here, rather than encoding them, leaves the encoding to the transport — the
 * voice protocol hashes them, ServerQuery does not — and keeps every call site
 * from having to remember, which is how a raw password once reached the server
 * and failed 781.
 */
async function exec(
  client: CommandExecutor,
  command: string,
  params: ReadonlyArray<readonly [string, ParamValue]> = [],
  passwords: readonly string[] = [],
): Promise<void> {
  await client.send({ command, params, passwords });
}

/** Send a command and return its response rows. */
async function query(
  client: CommandExecutor,
  command: string,
  params: ReadonlyArray<readonly [string, ParamValue]> = [],
  passwords: readonly string[] = [],
): Promise<Record<string, string>[]> {
  return client.send({ command, params, passwords });
}

/**
 * Read a string field, tolerating absence.
 *
 * The parser has already unescaped it. Unescaping again is how a nickname that
 * really contains `\s` used to come back with a space in it.
 */
const str = (row: Record<string, string>, key: string): string => row[key] ?? "";

/**
 * The id of the group a create or copy just made.
 *
 * ServerQuery answers `servergroupadd` with the new id alone. The voice
 * protocol answers with the whole group list instead (`notifyservergrouplist`),
 * so taking the first row returned the first group on the server rather than
 * the new one. The new group is the one with the requested name — the newest,
 * should the name repeat across group types.
 */
export function createdGroupID(
  rows: readonly Record<string, string>[],
  idKey: "sgid" | "cgid",
  name: string,
): bigint {
  const listed = rows.filter((row) => row["name"] !== undefined);
  if (listed.length === 0) return big(rows[0] ?? {}, idKey);

  let id = 0n;
  for (const row of listed) {
    if (row["name"] === name && big(row, idKey) > id) id = big(row, idKey);
  }
  if (id === 0n) {
    throw new TeamspeakError(`the server did not report the new group "${name}"`);
  }
  return id;
}

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

export { exec, query, str, big, num, bool };
export type { ParamValue };

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

/** One entry of a permission list. */
export interface PermissionEntry {
  /** Absent when the server answered by name instead of id. */
  permid: PermissionID | undefined;
  permsid: string;
  value: number;
  negated: boolean;
  skip: boolean;
}

/**
 * Parse one permission row.
 *
 * A permission is addressable by id or by name, and the server answers in
 * whichever form the request used, so exactly one of the two is populated.
 */
export function parsePermission(row: Record<string, string>): PermissionEntry {
  return {
    permid: row["permid"] === undefined ? undefined : (big(row, "permid") as PermissionID),
    permsid: str(row, "permsid"),
    value: num(row, "permvalue"),
    negated: bool(row, "permnegated"),
    skip: bool(row, "permskip"),
  };
}
