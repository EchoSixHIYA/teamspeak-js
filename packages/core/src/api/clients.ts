/**
 * Client commands.
 *
 * A "client" is someone connected right now, identified by `clid`; a "client
 * database entry" is the persistent record, identified by `cldbid`. Both exist
 * and both appear below, so the two are named apart in the types rather than
 * relying on the reader to tell `ClientID` from `ClientDBID`.
 */

import {
  exec,
  query,
  list,
  pages,
  encodeFields,
  nonEmpty,
  parsePermission,
  permissionParam,
  str,
  big,
  num,
  bool,
  date,
  durationMs,
  MILLISECOND,
} from "./command.js";
import type { PageOptions, PermissionEntry, WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type {
  ChannelGroupID,
  ChannelID,
  ClientDBID,
  ClientID,
  ServerGroupID,
  UID,
} from "../command/ids.js";
import {
  asChannelID,
  asChannelGroupID,
  asClientDBID,
  asClientID,
  asServerGroupID,
  asUID,
} from "../command/ids.js";
import type { Permission } from "../permission.js";
import { Reason } from "../reason.js";

/** A connected client, as `clientlist` reports one. */
export interface ClientEntry {
  /** The client's id for this connection. It changes every time the client connects. */
  readonly id: ClientID;
  /** The client's nickname. */
  readonly nickname: string;
  /** The client's unique identifier, stable across connections. Empty if `uid` was turned off. */
  readonly uid: UID;
  /** The channel the client is in. */
  readonly channelID: ChannelID;
  /** What kind of connection this is, one of {@link ClientType}. */
  readonly type: number;
  /**
   * The server groups the client holds, with `groups`. Ids rather than names:
   * the server sends ids, and resolving them costs a separate call.
   */
  readonly serverGroups: readonly ServerGroupID[];
  /** Whether the client is away, with `away`. */
  readonly isAway: boolean;
  /** Whether the client is recording, with `voice`. */
  readonly isRecording: boolean;
  /** Whether the client may talk despite the channel's needed talk power, with `voice`. */
  readonly isTalker: boolean;
  /** The channel group the client holds in its channel, with `groups`. */
  readonly channelGroupID: ChannelGroupID;
  /** When the client first connected to this server, with `times`. */
  readonly createdAt: Date | undefined;
  /** When the client last connected before this session, with `times`. */
  readonly lastConnectedAt: Date | undefined;
  /**
   * How long since the client last did anything, in milliseconds
   * (`client_idle_time`), with `times`; undefined without it.
   */
  readonly idleTimeMs: number | undefined;
}

function parseServerGroups(raw: string): ServerGroupID[] {
  if (raw === "") return [];
  return raw.split(",").flatMap((id) => (/^\d+$/.test(id) ? [asServerGroupID(BigInt(id))] : []));
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
    createdAt: date(row, "client_created"),
    lastConnectedAt: date(row, "client_lastconnected"),
    idleTimeMs:
      row["client_idle_time"] === undefined
        ? undefined
        : durationMs(row, "client_idle_time", MILLISECOND),
  };
}

/**
 * Which optional fields `clientlist` should include. Each asks the server for
 * more per client; turn them off for a narrower response when watching a busy
 * server.
 */
export interface ClientListOptions {
  /** The unique identifier (`-uid`). On unless set to false: almost every caller needs it. */
  readonly uid?: boolean | undefined;
  /** Away state and message (`-away`). */
  readonly away?: boolean | undefined;
  /** Voice state: muted, talking, recording, talker (`-voice`). */
  readonly voice?: boolean | undefined;
  /** Server and channel groups (`-groups`). */
  readonly groups?: boolean | undefined;
  /** Creation, last connection and idle times (`-times`). */
  readonly times?: boolean | undefined;
  /** Client version and platform (`-info`). */
  readonly info?: boolean | undefined;
  /** The client's country (`-country`). */
  readonly country?: boolean | undefined;
  /** The client's address (`-ip`). */
  readonly ip?: boolean | undefined;
  /** The client's badges (`-badges`). */
  readonly badges?: boolean | undefined;
}

const listFlags: WireNames<ClientListOptions> = {
  uid: "-uid",
  away: "-away",
  voice: "-voice",
  groups: "-groups",
  times: "-times",
  info: "-info",
  country: "-country",
  ip: "-ip",
  badges: "-badges",
};

/** Every client currently connected. */
export async function listClients(
  client: CommandExecutor,
  include: ClientListOptions = {},
  options?: CommandOptions,
): Promise<ClientEntry[]> {
  const flags = encodeFields({ ...include, uid: include.uid !== false }, listFlags);
  return (await query(client, "clientlist", flags, options)).map(parseClient);
}

/**
 * One connected client's full detail, as the server sent it.
 *
 * Raw rather than parsed: `clientinfo` carries some eighty fields, which ones
 * appear depends on the server version and on the caller's permissions, and a
 * typed subset would drop the rest. Durations here are in the server's units —
 * `client_idle_time` and `connection_connected_time` in milliseconds.
 */
export async function getClientInfo(
  client: CommandExecutor,
  clid: ClientID,
  options?: CommandOptions,
): Promise<Readonly<Record<string, string>>> {
  const rows = await query(client, "clientinfo", [["clid", clid]], options);
  const row = rows[0];
  if (!row) throw new Error(`no data returned for client ${clid}`);
  return row;
}

/**
 * Move a client to another channel.
 *
 * `password` is the channel's, in cleartext; the voice client hashes it on the
 * wire. Unset sends none.
 */
export async function moveClient(
  client: CommandExecutor,
  clid: ClientID,
  channelID: ChannelID,
  password?: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "clientmove",
    [
      ["clid", clid],
      ["cid", channelID],
      ["cpw", password],
    ],
    options,
    ["cpw"],
  );
}

/** The reasons a client can be kicked for. */
export type KickReason = typeof Reason.KickChannel | typeof Reason.KickServer;

/**
 * Kick a client from its channel (`Reason.KickChannel`), which moves it to the
 * default channel, or from the server (`Reason.KickServer`), which disconnects
 * it. Any other reason is refused before anything is sent.
 *
 * `reasonMessage` is shown to the client; unset or `""` sends none.
 */
export async function kickClient(
  client: CommandExecutor,
  clid: ClientID,
  reason: KickReason,
  reasonMessage?: string,
  options?: CommandOptions,
): Promise<void> {
  if (reason !== Reason.KickChannel && reason !== Reason.KickServer) {
    throw new RangeError(
      `a kick's reason is Reason.KickChannel or Reason.KickServer, not ${String(reason)}`,
    );
  }
  await exec(
    client,
    "clientkick",
    [
      ["clid", clid],
      ["reasonid", reason],
      ["reasonmsg", nonEmpty(reasonMessage ?? "")],
    ],
    options,
  );
}

/** Send a poke to a client. */
export async function pokeClient(
  client: CommandExecutor,
  clid: ClientID,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "clientpoke",
    [
      ["clid", clid],
      ["msg", message],
    ],
    options,
  );
}

/**
 * Our own client state, as `clientupdate` takes it.
 *
 * Only the fields you set are sent. An unset (undefined) field is omitted and
 * leaves the setting alone; any other value is sent, so `""` sends an empty
 * value — `awayMessage: ""` clears the away message.
 */
export interface ClientUpdateOptions {
  /** Our nickname (`client_nickname`). */
  readonly nickname?: string | undefined;
  /** How the nickname is pronounced, for text-to-speech (`client_nickname_phonetic`). */
  readonly nicknamePhonetic?: string | undefined;
  /** Whether our microphone is muted (`client_input_muted`). */
  readonly isInputMuted?: boolean | undefined;
  /** Whether our speakers are muted (`client_output_muted`). */
  readonly isOutputMuted?: boolean | undefined;
  /** Whether we have a working microphone (`client_input_hardware`). */
  readonly hasInputHardware?: boolean | undefined;
  /** Whether we have working speakers (`client_output_hardware`). */
  readonly hasOutputHardware?: boolean | undefined;
  /** Whether we are away (`client_away`). */
  readonly isAway?: boolean | undefined;
  /** The away message (`client_away_message`). */
  readonly awayMessage?: string | undefined;
  /** Whether we speak as channel commander (`client_is_channel_commander`). */
  readonly isChannelCommander?: boolean | undefined;
  /** Whether we are recording (`client_is_recording`). */
  readonly isRecording?: boolean | undefined;
  /** Whether we are requesting to talk (`client_talk_request`). */
  readonly isRequestingTalk?: boolean | undefined;
  /** The message sent with a talk request (`client_talk_request_msg`). */
  readonly talkRequestMessage?: string | undefined;
  /** Our avatar's MD5, as uploaded to the file area; "" removes it (`client_flag_avatar`). */
  readonly avatar?: string | undefined;
  /** Our badges, in the client's own format (`client_badges`). */
  readonly badges?: string | undefined;
}

const updateNames: WireNames<ClientUpdateOptions> = {
  nickname: "client_nickname",
  nicknamePhonetic: "client_nickname_phonetic",
  isInputMuted: "client_input_muted",
  isOutputMuted: "client_output_muted",
  hasInputHardware: "client_input_hardware",
  hasOutputHardware: "client_output_hardware",
  isAway: "client_away",
  awayMessage: "client_away_message",
  isChannelCommander: "client_is_channel_commander",
  isRecording: "client_is_recording",
  isRequestingTalk: "client_talk_request",
  talkRequestMessage: "client_talk_request_msg",
  avatar: "client_flag_avatar",
  badges: "client_badges",
};

/**
 * Change our own client state (nickname, mute, away, …). Only the fields you
 * set are sent.
 *
 * `clientupdate` addresses the calling client implicitly — there is no clid
 * parameter on the wire, which is why this takes no id.
 */
export async function updateClient(
  client: CommandExecutor,
  update: ClientUpdateOptions,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientupdate", encodeFields(update, updateNames), options);
}

/**
 * Another client's editable attributes, as `clientedit` takes them. Unset
 * fields are omitted; `""` is sent empty.
 */
export interface ClientEditOptions {
  /** The client's description (`client_description`). */
  readonly description?: string | undefined;
  /** Whether the client may talk despite a channel's needed talk power (`client_is_talker`). */
  readonly isTalker?: boolean | undefined;
}

const editNames: WireNames<ClientEditOptions> = {
  description: "client_description",
  isTalker: "client_is_talker",
};

/** Change another client's editable attributes. Only the fields you set are sent. */
export async function editClient(
  client: CommandExecutor,
  clid: ClientID,
  edit: ClientEditOptions,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientedit", [["clid", clid], ...encodeFields(edit, editNames)], options);
}

/** A connected client whose nickname matched a search. */
export interface ClientMatch {
  /** The client's id. */
  readonly id: ClientID;
  /** The client's nickname. */
  readonly nickname: string;
}

/**
 * Clients whose nickname contains `pattern`. A pattern matching no one is
 * refused by the server with error 512 (invalid clientID), not answered empty.
 */
export async function findClients(
  client: CommandExecutor,
  pattern: string,
  options?: CommandOptions,
): Promise<ClientMatch[]> {
  const rows = await query(client, "clientfind", [["pattern", pattern]], options);
  return rows.map((row) => ({
    id: asClientID(num(row, "clid")),
    nickname: str(row, "client_nickname"),
  }));
}

/** Every clid currently using a given unique identifier. */
export async function getClientIDs(
  client: CommandExecutor,
  uid: UID,
  options?: CommandOptions,
): Promise<ClientID[]> {
  const rows = await query(client, "clientgetids", [["cluid", uid]], options);
  return rows.map((row) => asClientID(num(row, "clid")));
}

/** The uid of a connected client. */
export async function getClientUIDByID(
  client: CommandExecutor,
  clid: ClientID,
  options?: CommandOptions,
): Promise<UID> {
  const rows = await query(client, "clientgetuidfromclid", [["clid", clid]], options);
  return asUID(str(rows[0] ?? {}, "cluid"));
}

/** The persistent database id behind a uid. */
export async function getClientDBIDByUID(
  client: CommandExecutor,
  uid: UID,
  options?: CommandOptions,
): Promise<ClientDBID> {
  const rows = await query(client, "clientgetdbidfromuid", [["cluid", uid]], options);
  return asClientDBID(big(rows[0] ?? {}, "cldbid"));
}

/** The nickname recorded for a database id. */
export async function getClientNameByDBID(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<string> {
  const rows = await query(client, "clientgetnamefromdbid", [["cldbid", cldbid]], options);
  return str(rows[0] ?? {}, "name");
}

/** The database record a uid names, as `clientgetnamefromuid` reports it. */
export interface ClientDatabaseName {
  /** The client's database id. */
  readonly databaseID: ClientDBID;
  /** The nickname the client last used. */
  readonly name: string;
}

/** The database id and nickname recorded for a uid. */
export async function getClientNameByUID(
  client: CommandExecutor,
  uid: UID,
  options?: CommandOptions,
): Promise<ClientDatabaseName> {
  const rows = await query(client, "clientgetnamefromuid", [["cluid", uid]], options);
  const row = rows[0] ?? {};
  return { databaseID: asClientDBID(big(row, "cldbid")), name: str(row, "name") };
}

/** Give a client a channel group in one channel. */
export async function setClientChannelGroup(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  cid: ChannelID,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "setclientchannelgroup",
    [
      ["cgid", cgid],
      ["cid", cid],
      ["cldbid", cldbid],
    ],
    options,
  );
}

// ---- Client database --------------------------------------------------------

/** A persistent client record, as `clientdblist` and `clientdbinfo` report it. */
export interface ClientDatabaseEntry {
  /** The record's id. */
  readonly databaseID: ClientDBID;
  /** The client's unique identifier. */
  readonly uid: UID;
  /** The nickname the client last used. */
  readonly nickname: string;
  /** When the client first connected. */
  readonly createdAt: Date | undefined;
  /** When the client last connected. */
  readonly lastConnectedAt: Date | undefined;
  /** How many times the client has connected. */
  readonly totalConnections: number;
  /** The client's description. */
  readonly description: string;
  /** The address the client last connected from. */
  readonly lastIP: string;
}

const parseDatabaseEntry = (row: Record<string, string>): ClientDatabaseEntry => ({
  databaseID: asClientDBID(big(row, "cldbid")),
  uid: asUID(str(row, "client_unique_identifier")),
  nickname: str(row, "client_nickname"),
  createdAt: date(row, "client_created"),
  lastConnectedAt: date(row, "client_lastconnected"),
  totalConnections: num(row, "client_totalconnections"),
  description: str(row, "client_description"),
  lastIP: str(row, "client_lastip"),
});

/** Which slice of the client database {@link listClientDatabase} reads. */
export interface ClientDatabasePage {
  /** The offset of the first record, 0 by default (`start`). */
  readonly start?: number | undefined;
  /** How many records to read at most; the server caps it (`duration`). */
  readonly limit?: number | undefined;
}

const pageNames: WireNames<ClientDatabasePage> = { start: "start", limit: "duration" };

/**
 * One page of persistent client records.
 *
 * The database is paged, and the server caps a page; {@link iterateClientDatabase}
 * walks all of it. A `start` past the last record is an empty page.
 */
export async function listClientDatabase(
  client: CommandExecutor,
  page: ClientDatabasePage = {},
  options?: CommandOptions,
): Promise<ClientDatabaseEntry[]> {
  return (await list(client, "clientdblist", encodeFields(page, pageNames), options)).map(
    parseDatabaseEntry,
  );
}

/**
 * Every persistent client record, fetched a page at a time as the loop asks
 * for more:
 *
 * ```ts
 * for await (const entry of iterateClientDatabase(client, { signal })) { ... }
 * ```
 *
 * The walk ends when the server answers a page past the last record with
 * error 1281, or with a page shorter than an earlier one; any other error is
 * thrown from the loop. Each page is a separate `clientdblist`, given the
 * options' signal and timeout, so records added or removed meanwhile can be
 * skipped or seen twice.
 */
export function iterateClientDatabase(
  client: CommandExecutor,
  options?: PageOptions,
): AsyncIterable<ClientDatabaseEntry> {
  return pages(
    client,
    "clientdblist",
    parseDatabaseEntry,
    (previous, next) => next.databaseID > previous.databaseID,
    options,
  );
}

/**
 * Database ids of the records whose nickname matches `pattern`, which may use
 * `%` as a wildcard. No match is an empty list.
 */
export async function findClientDatabase(
  client: CommandExecutor,
  pattern: string,
  options?: CommandOptions,
): Promise<ClientDBID[]> {
  const rows = await list(client, "clientdbfind", [["pattern", pattern]], options);
  return rows.map((row) => asClientDBID(big(row, "cldbid")));
}

/** One database record. */
export async function getClientDatabaseInfo(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<ClientDatabaseEntry> {
  const rows = await query(client, "clientdbinfo", [["cldbid", cldbid]], options);
  return { ...parseDatabaseEntry(rows[0] ?? {}), databaseID: cldbid };
}

/**
 * A database record's editable attributes, as `clientdbedit` takes them.
 * Unset fields are omitted; `""` is sent empty.
 */
export interface ClientDatabaseEditOptions {
  /** The client's description (`client_description`). */
  readonly description?: string | undefined;
  /** The nickname on record (`client_nickname`). */
  readonly nickname?: string | undefined;
}

const databaseEditNames: WireNames<ClientDatabaseEditOptions> = {
  description: "client_description",
  nickname: "client_nickname",
};

/** Change a database record. Only the fields you set are sent. */
export async function editClientDatabase(
  client: CommandExecutor,
  cldbid: ClientDBID,
  edit: ClientDatabaseEditOptions,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "clientdbedit",
    [["cldbid", cldbid], ...encodeFields(edit, databaseEditNames)],
    options,
  );
}

/** Delete a client from the database entirely. */
export async function deleteClientDatabase(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientdbdelete", [["cldbid", cldbid]], options);
}

// ---- Client permissions -----------------------------------------------------

/** Permissions set on a client, server-wide. */
export async function listClientPermissions(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<PermissionEntry[]> {
  return (await list(client, "clientpermlist", [["cldbid", cldbid]], options)).map(parsePermission);
}

/**
 * Set a permission on a client, server-wide.
 *
 * `skip` is required by the server here, unlike the channel equivalent.
 */
export async function addClientPermission(
  client: CommandExecutor,
  cldbid: ClientDBID,
  permission: Permission,
  value: number,
  skip: boolean,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "clientaddperm",
    [["cldbid", cldbid], permissionParam(permission), ["permvalue", value], ["permskip", skip]],
    options,
  );
}

/** Remove a permission from a client. */
export async function deleteClientPermission(
  client: CommandExecutor,
  cldbid: ClientDBID,
  permission: Permission,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientdelperm", [["cldbid", cldbid], permissionParam(permission)], options);
}
