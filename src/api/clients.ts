/**
 * Client commands.
 *
 * A "client" is someone connected right now, identified by `clid`; a "client
 * database entry" is the persistent record, identified by `cldbid`. Both exist
 * and both appear below, so the two are named apart in the types rather than
 * relying on the reader to tell `ClientID` from `ClientDBID`.
 */

import { exec, query, str, big, num, bool } from "./command.js";
import type { ParamValue } from "./command.js";
import type { Client } from "../client.js";
import type {
  ChannelGroupID,
  ChannelID,
  ClientDBID,
  ClientID,
  PermissionID,
  UID,
} from "../command/ids.js";
import { asChannelID, asChannelGroupID, asClientDBID, asClientID, asUID } from "../command/ids.js";

/** A connected client, as `clientlist` reports one. */
export interface ClientEntry {
  id: ClientID;
  nickname: string;
  uid: UID;
  channelID: ChannelID;
  /** 0 for a normal client, 1 for a ServerQuery client. */
  type: number;
  serverGroups: ServerGroupRef[];
  isAway: boolean;
  isRecording: boolean;
  isTalker: boolean;
  channelGroupID: ChannelGroupID;
}

/** A group a client belongs to, as returned by the list commands. */
export interface ServerGroupRef {
  id: bigint;
  name: string;
}

function parseServerGroups(raw: string): ServerGroupRef[] {
  if (raw === "") return [];
  return raw.split(",").map((id) => ({ id: BigInt(id === "" ? "0" : id), name: "" }));
}

function parseClient(row: Record<string, string>): ClientEntry {
  return {
    id: asClientID(num(row, "clid")),
    nickname: str(row, "client_nickname"),
    uid: asUID(str(row, "client_unique_identifier")),
    channelID: asChannelID(big(row, "cid")),
    type: num(row, "client_type"),
    serverGroups: parseServerGroups(row["client_servergroups"] ?? ""),
    isAway: bool(row, "client_away"),
    isRecording: bool(row, "client_is_recording"),
    isTalker: bool(row, "client_is_talker"),
    channelGroupID: asChannelGroupID(big(row, "client_channel_group_id")),
  };
}

/**
 * Every client currently connected.
 *
 * The uid, away, voice and groups flags ask the server to include those fields.
 * Turn them off for a narrower response when watching a busy server.
 */
export async function listClients(
  client: Client,
  options: {
    uid?: boolean;
    away?: boolean;
    voice?: boolean;
    groups?: boolean;
    times?: boolean;
    info?: boolean;
    country?: boolean;
    ip?: boolean;
    badges?: boolean;
  } = {},
): Promise<ClientEntry[]> {
  const params: Array<readonly [string, ParamValue]> = [];
  if (options.uid !== false) params.push(["-uid", true]);
  if (options.away) params.push(["-away", true]);
  if (options.voice) params.push(["-voice", true]);
  if (options.groups) params.push(["-groups", true]);
  if (options.times) params.push(["-times", true]);
  if (options.info) params.push(["-info", true]);
  if (options.country) params.push(["-country", true]);
  if (options.ip) params.push(["-ip", true]);
  if (options.badges) params.push(["-badges", true]);

  return (await query(client, "clientlist", params)).map(parseClient);
}

/** One connected client's full detail. */
export async function getClientInfo(
  client: Client,
  clid: ClientID,
): Promise<Record<string, string>> {
  const rows = await query(client, "clientinfo", [["clid", clid]]);
  const row = rows[0];
  if (!row) throw new Error(`no data returned for client ${clid}`);
  return row;
}

/** Move a client to another channel. */
export async function moveClient(
  client: Client,
  clid: ClientID,
  channelID: ChannelID,
  password?: string,
): Promise<void> {
  await exec(
    client,
    "clientmove",
    [
      ["clid", clid],
      ["cid", channelID],
      ["cpw", password],
    ],
    ["cpw"],
  );
}

/** Disconnect a client from the server. */
export async function kickClient(
  client: Client,
  clid: ClientID,
  reasonID: number,
  reasonMessage?: string,
): Promise<void> {
  await exec(client, "clientkick", [
    ["clid", clid],
    ["reasonid", reasonID],
    ["reasonmsg", reasonMessage],
  ]);
}

/** Send a poke to a client. */
export async function pokeClient(client: Client, clid: ClientID, message: string): Promise<void> {
  await exec(client, "clientpoke", [
    ["clid", clid],
    ["msg", message],
  ]);
}

/** Change our own client state. Only the fields you set are sent. */
export interface ClientUpdateOptions {
  client_nickname?: string;
  client_input_muted?: boolean;
  client_output_muted?: boolean;
  client_away?: boolean;
  client_away_message?: string;
  client_input_hardware?: boolean;
  client_output_hardware?: boolean;
  client_is_channel_commander?: boolean;
  client_flag_avatar?: string;
  client_nickname_phonetic?: string;
  client_talk_request?: number;
  client_talk_request_msg?: string;
  client_is_recording?: boolean;
  client_badges?: string;
}

/**
 * Change our own client state (nickname, mute, away, …).
 *
 * `clientupdate` addresses the calling client implicitly — there is no clid
 * parameter on the wire, which is why this takes no id.
 */
export async function updateClient(client: Client, options: ClientUpdateOptions): Promise<void> {
  await exec(client, "clientupdate", Object.entries(options) as Array<[string, ParamValue]>);
}

/** Change another client's editable attributes. */
export async function editClient(
  client: Client,
  clid: ClientID,
  options: { client_description?: string; client_is_talker?: boolean },
): Promise<void> {
  await exec(client, "clientedit", [
    ["clid", clid],
    ...(Object.entries(options) as Array<[string, ParamValue]>),
  ]);
}

/** Clients whose nickname contains `pattern`. */
export async function findClients(
  client: Client,
  pattern: string,
): Promise<Array<{ id: ClientID; nickname: string }>> {
  const rows = await query(client, "clientfind", [["pattern", pattern]]);
  return rows.map((row) => ({
    id: asClientID(num(row, "clid")),
    nickname: str(row, "client_nickname"),
  }));
}

/** Every clid currently using a given unique identifier. */
export async function getClientIDs(client: Client, uid: UID): Promise<ClientID[]> {
  const rows = await query(client, "clientgetids", [["cluid", uid]]);
  return rows.map((row) => asClientID(num(row, "clid")));
}

/** The uid of a connected client. */
export async function getClientUIDByID(client: Client, clid: ClientID): Promise<UID> {
  const rows = await query(client, "clientgetuidfromclid", [["clid", clid]]);
  return asUID(str(rows[0] ?? {}, "cluid"));
}

/** The persistent database id behind a uid. */
export async function getClientDBIDByUID(client: Client, uid: UID): Promise<ClientDBID> {
  const rows = await query(client, "clientgetdbidfromuid", [["cluid", uid]]);
  return asClientDBID(big(rows[0] ?? {}, "cldbid"));
}

/** The nickname recorded for a database id. */
export async function getClientNameByDBID(client: Client, cldbid: ClientDBID): Promise<string> {
  const rows = await query(client, "clientgetnamefromdbid", [["cldbid", cldbid]]);
  return str(rows[0] ?? {}, "name");
}

/** The database id and nickname recorded for a uid. */
export async function getClientNameByUID(
  client: Client,
  uid: UID,
): Promise<{ databaseID: ClientDBID; name: string }> {
  const rows = await query(client, "clientgetnamefromuid", [["cluid", uid]]);
  const row = rows[0] ?? {};
  return { databaseID: asClientDBID(big(row, "cldbid")), name: str(row, "name") };
}

/** Join a channel, optionally with a channel group to hold there. */
export async function setClientChannelGroup(
  client: Client,
  cgid: ChannelGroupID,
  cid: ChannelID,
  cldbid: ClientDBID,
): Promise<void> {
  await exec(client, "setclientchannelgroup", [
    ["cgid", cgid],
    ["cid", cid],
    ["cldbid", cldbid],
  ]);
}

// ---- Client database --------------------------------------------------------

/** A persistent client record, as `clientdblist` reports it. */
export interface ClientDatabaseEntry {
  databaseID: ClientDBID;
  uid: UID;
  nickname: string;
  created: number;
  lastConnected: number;
  totalConnections: number;
  description: string;
  lastIP: string;
}

const parseDatabaseEntry = (row: Record<string, string>): ClientDatabaseEntry => ({
  databaseID: asClientDBID(big(row, "cldbid")),
  uid: asUID(str(row, "client_unique_identifier")),
  nickname: str(row, "client_nickname"),
  created: num(row, "client_created"),
  lastConnected: num(row, "client_lastconnected"),
  totalConnections: num(row, "client_totalconnections"),
  description: str(row, "client_description"),
  lastIP: str(row, "client_lastip"),
});

/**
 * Persistent client records.
 *
 * This walks the whole database, so it is paged: pass `start` and `duration` to
 * take a slice rather than everything at once.
 */
export async function listClientDatabase(
  client: Client,
  options: { start?: number; duration?: number } = {},
): Promise<ClientDatabaseEntry[]> {
  return (
    await query(client, "clientdblist", [
      ["start", options.start],
      ["duration", options.duration],
    ])
  ).map(parseDatabaseEntry);
}

/** Database records whose nickname or uid matches `pattern`. */
export async function findClientDatabase(
  client: Client,
  pattern: string,
): Promise<Array<{ databaseID: ClientDBID; uid: UID; nickname: string }>> {
  const rows = await query(client, "clientdbfind", [["pattern", pattern]]);
  return rows.map((row) => ({
    databaseID: asClientDBID(big(row, "cldbid")),
    uid: asUID(str(row, "client_unique_identifier")),
    nickname: str(row, "client_nickname"),
  }));
}

/** One database record. */
export async function getClientDatabaseInfo(
  client: Client,
  cldbid: ClientDBID,
): Promise<ClientDatabaseEntry> {
  const rows = await query(client, "clientdbinfo", [["cldbid", cldbid]]);
  return parseDatabaseEntry(rows[0] ?? {});
}

/** Change a database record. */
export async function editClientDatabase(
  client: Client,
  cldbid: ClientDBID,
  options: { client_description?: string; client_nickname?: string },
): Promise<void> {
  await exec(client, "clientdbedit", [
    ["cldbid", cldbid],
    ...(Object.entries(options) as Array<[string, ParamValue]>),
  ]);
}

/** Delete a client from the database entirely. */
export async function deleteClientDatabase(client: Client, cldbid: ClientDBID): Promise<void> {
  await exec(client, "clientdbdelete", [["cldbid", cldbid]]);
}

// ---- Client permissions -----------------------------------------------------

/** Permissions granted to a client from the database. */
export async function listClientPermissions(
  client: Client,
  cldbid: ClientDBID,
): Promise<Record<string, string>[]> {
  return query(client, "clientpermlist", [["cldbid", cldbid]]);
}

/**
 * Grant a permission to a client.
 *
 * `permskip` is required by the server here, unlike the channel equivalent.
 */
export async function addClientPermission(
  client: Client,
  cldbid: ClientDBID,
  options: { permvalue: number; permskip: boolean; permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "clientaddperm", [
    ["cldbid", cldbid],
    ["permvalue", options.permvalue],
    ["permskip", options.permskip],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

export async function deleteClientPermission(
  client: Client,
  cldbid: ClientDBID,
  options: { permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "clientdelperm", [
    ["cldbid", cldbid],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}
