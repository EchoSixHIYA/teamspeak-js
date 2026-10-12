/**
 * Channel commands.
 *
 * Channel settings are a wide, mostly-optional set, so the options objects here
 * use the names the server uses (`channel_codec`, `channel_topic`) rather than
 * inventing shorter aliases: the wire name is what you find in the server
 * documentation and in `channelinfo` output, and a second vocabulary would be
 * one more thing to translate.
 */

import { exec, query, parseChannel, parsePermission, big, str } from "./command.js";
import type { ParamValue } from "./command.js";
import type { CommandExecutor } from "../command/request.js";
import type { ChannelID, ClientDBID, PermissionID } from "../command/ids.js";
import { asChannelID } from "../command/ids.js";
import type { Channel, PermissionEntry } from "./command.js";

export interface ChannelCreateOptions {
  channel_name: string;
  cpid?: ChannelID;
  channel_topic?: string;
  channel_description?: string;
  /** Cleartext; hashed on the wire. */
  channel_password?: string;
  channel_codec?: number;
  channel_codec_quality?: number;
  channel_maxclients?: number;
  channel_maxfamilyclients?: number;
  channel_order?: bigint;
  channel_flag_password?: boolean;
  channel_codec_is_unencrypted?: boolean;
  channel_delete_delay?: number;
  channel_flag_maxclients_unlimited?: boolean;
  channel_flag_maxfamilyclients_unlimited?: boolean;
  channel_flag_maxfamilyclients_inherited?: boolean;
  channel_name_phonetic?: string;
  channel_flag_permanent?: boolean;
  channel_flag_semi_permanent?: boolean;
  channel_flag_default?: boolean;
}

/** Create a channel and return the id the server assigned. */
export async function createChannel(
  client: CommandExecutor,
  options: ChannelCreateOptions,
): Promise<ChannelID> {
  const rows = await query(
    client,
    "channelcreate",
    Object.entries(options) as Array<[string, ParamValue]>,
    ["channel_password"],
  );
  return asChannelID(big(rows[0] ?? {}, "cid"));
}

export interface ChannelEditOptions {
  channel_order?: bigint;
  channel_name?: string;
  channel_topic?: string;
  channel_flag_default?: boolean;
  channel_flag_password?: boolean;
  /** Cleartext; hashed on the wire. An empty string clears the password. */
  channel_password?: string;
  channel_flag_permanent?: boolean;
  channel_flag_semi_permanent?: boolean;
  channel_codec?: number;
  channel_codec_quality?: number;
  channel_needed_talk_power?: number;
  channel_maxclients?: number;
  channel_maxfamilyclients?: number;
  channel_codec_latency_factor?: number;
  channel_codec_is_unencrypted?: boolean;
  channel_delete_delay?: number;
  channel_flag_maxclients_unlimited?: boolean;
  channel_flag_maxfamilyclients_unlimited?: boolean;
  channel_flag_maxfamilyclients_inherited?: boolean;
  channel_name_phonetic?: string;
  channel_description?: string;
}

/** Change a channel's settings. Only the fields you set are sent. */
export async function editChannel(
  client: CommandExecutor,
  cid: ChannelID,
  options: Omit<ChannelEditOptions, "cid">,
): Promise<void> {
  await exec(
    client,
    "channeledit",
    [["cid", cid], ...(Object.entries(options) as Array<[string, ParamValue]>)],
    ["channel_password"],
  );
}

/**
 * Delete a channel.
 *
 * `force` is required by the server, not just conventional: deleting a channel
 * that still holds clients fails without it.
 */
export async function deleteChannel(
  client: CommandExecutor,
  cid: ChannelID,
  force: boolean,
): Promise<void> {
  await exec(client, "channeldelete", [
    ["cid", cid],
    ["force", force],
  ]);
}

/** All channels on the server, in the server's own sort order. */
export async function listChannels(client: CommandExecutor): Promise<Channel[]> {
  return (await query(client, "channellist")).map(parseChannel);
}

/**
 * One channel's full settings.
 *
 * `channelinfo` answers with `pid` and the settings but no `cid` — the channel
 * is whatever was asked for — so the id is taken from the argument rather than
 * read from the row, where it would come back 0.
 */
export async function getChannelInfo(client: CommandExecutor, cid: ChannelID): Promise<Channel> {
  const rows = await query(client, "channelinfo", [["cid", cid]]);
  return { ...parseChannel(rows[0] ?? {}), id: cid };
}

/** Channels whose name contains `pattern`. */
export async function findChannels(
  client: CommandExecutor,
  pattern: string,
): Promise<Array<{ id: ChannelID; name: string }>> {
  const rows = await query(client, "channelfind", [["pattern", pattern]]);
  return rows.map((row) => ({ id: asChannelID(big(row, "cid")), name: str(row, "channel_name") }));
}

/** Move a channel to a new parent and/or position. */
export async function moveChannel(
  client: CommandExecutor,
  cid: ChannelID,
  cpid: ChannelID,
  order?: bigint,
): Promise<void> {
  await exec(client, "channelmove", [
    ["cid", cid],
    ["cpid", cpid],
    ["order", order],
  ]);
}

// ---- Channel permissions ----------------------------------------------------

/**
 * Grant a channel permission.
 *
 * Identified by `permid` or `permsid`; the server accepts either, and the
 * name form is the readable one.
 */
export async function addChannelPermission(
  client: CommandExecutor,
  cid: ChannelID,
  options: { permvalue: number; permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "channeladdperm", [
    ["cid", cid],
    ["permvalue", options.permvalue],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

export async function deleteChannelPermission(
  client: CommandExecutor,
  cid: ChannelID,
  options: { permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "channeldelperm", [
    ["cid", cid],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

/** Permissions set directly on a channel. */
export async function listChannelPermissions(
  client: CommandExecutor,
  cid: ChannelID,
): Promise<PermissionEntry[]> {
  return (await query(client, "channelpermlist", [["cid", cid]])).map(parsePermission);
}

/** Permissions granted to one client within one channel. */
export async function listChannelClientPermissions(
  client: CommandExecutor,
  cid: ChannelID,
  cldbid: ClientDBID,
): Promise<PermissionEntry[]> {
  return (
    await query(client, "channelclientpermlist", [
      ["cid", cid],
      ["cldbid", cldbid],
    ])
  ).map(parsePermission);
}

export async function addChannelClientPermission(
  client: CommandExecutor,
  cid: ChannelID,
  cldbid: ClientDBID,
  options: { permvalue: number; permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "channelclientaddperm", [
    ["cid", cid],
    ["cldbid", cldbid],
    ["permvalue", options.permvalue],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

export async function deleteChannelClientPermission(
  client: CommandExecutor,
  cid: ChannelID,
  cldbid: ClientDBID,
  options: { permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "channelclientdelperm", [
    ["cid", cid],
    ["cldbid", cldbid],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}
