/**
 * Row parsers shared with the client and query modules, kept out of the public index:
 * they read wire rows, which is plumbing, not API. They reach them through
 * `./internal`.
 */

import { str, big, num, uint, U16, bool, date, durationMs, MILLISECOND } from "./command.js";
import type { ServerGroupID } from "../command/ids.js";
import {
  asChannelID,
  asChannelGroupID,
  asClientID,
  asServerGroupID,
  asUID,
} from "../command/ids.js";
import type { ClientEntry } from "./clients.js";

/** A comma-separated list of server group ids; anything that is not one is skipped. */
export function parseServerGroups(raw: string): ServerGroupID[] {
  if (raw === "") return [];
  return raw
    .split(",")
    .flatMap((id) =>
      /^\d{1,20}$/.test(id) && BigInt(id) < 1n << 64n ? [asServerGroupID(BigInt(id))] : [],
    );
}

/**
 * Read a client from a `clientlist` row, or from a `notifycliententerview`,
 * which names its channel `ctid` where the list says `cid`. Reached by the
 * client module through `./internal`.
 */
export function parseClient(row: Record<string, string>): ClientEntry {
  return {
    id: asClientID(uint(row, "clid", U16)),
    nickname: str(row, "client_nickname"),
    uid: asUID(str(row, "client_unique_identifier")),
    channelID: asChannelID(big(row, row["cid"] === undefined ? "ctid" : "cid")),
    type: num(row, "client_type"),
    serverGroups: parseServerGroups(row["client_servergroups"] ?? ""),
    isAway: bool(row, "client_away"),
    isRecording: bool(row, "client_is_recording"),
    isTalker: bool(row, "client_is_talker"),
    channelGroupID: asChannelGroupID(big(row, "client_channel_group_id")),
    createdAt: date(row, "client_created"),
    lastConnectedAt: date(row, "client_lastconnected"),
    idleTimeMs:
      row["client_idle_time"] === undefined
        ? undefined
        : durationMs(row, "client_idle_time", MILLISECOND),
  };
}
