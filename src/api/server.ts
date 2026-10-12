/**
 * Server and instance commands.
 *
 * "Server" here means the virtual server a client is connected to; "instance"
 * means the process hosting it. The distinction matters because the setting
 * names differ (`virtualserver_*` versus `serverinstance_*`) and the two are
 * easy to mix up.
 */

import { exec, query, parsePermission, createdGroupID, str, big, num, bool } from "./command.js";
import type { ParamValue } from "./command.js";
import type { Client } from "../client.js";
import type { ChannelID, ClientDBID, PermissionID, ServerGroupID } from "../command/ids.js";
import type { PermissionEntry } from "./command.js";
import { asServerGroupID } from "../command/ids.js";

/** A server group as `servergrouplist` reports it. */
export interface ServerGroup {
  id: ServerGroupID;
  name: string;
  /** 0 = regular group, 1 = query group, 2 = query group (template). */
  type: number;
  iconID: bigint;
  savedInDatabase: boolean;
  sortID: bigint;
  nameMode: number;
  modifyPower: number;
  memberAddPower: number;
  memberRemovePower: number;
}

const parseServerGroup = (row: Record<string, string>): ServerGroup => ({
  id: asServerGroupID(big(row, "sgid")),
  name: str(row, "name"),
  type: num(row, "type"),
  iconID: big(row, "iconid"),
  savedInDatabase: bool(row, "savedb"),
  sortID: big(row, "sortid"),
  nameMode: num(row, "namemode"),
  modifyPower: num(row, "n_modifyp"),
  memberAddPower: num(row, "n_member_addp"),
  memberRemovePower: num(row, "n_member_removep"),
});

/** Every server group. */
export async function listServerGroups(client: Client): Promise<ServerGroup[]> {
  return (await query(client, "servergrouplist")).map(parseServerGroup);
}

/** The server's own settings, as `serverinfo` reports them. */
export async function getServerInfo(client: Client): Promise<Record<string, string>> {
  return (await query(client, "serverinfo"))[0] ?? {};
}

/**
 * Change the virtual server's settings. Only the fields you set are sent.
 *
 * Field names are the `virtualserver_*` ones from `serverinfo`, passed through
 * as given rather than enumerated here: there are well over a hundred, they are
 * version-dependent, and a caller reading them back from `getServerInfo` should
 * be able to write them straight back.
 */
export async function editServer(
  client: Client,
  settings: Record<string, ParamValue>,
): Promise<void> {
  await exec(client, "serveredit", Object.entries(settings));
}

/**
 * The host process's settings, as `hostinfo` reports them.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function getHostInfo(client: Client): Promise<Record<string, string>> {
  return (await query(client, "hostinfo"))[0] ?? {};
}

/**
 * The server instance's settings, as `instanceinfo` reports them.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function getInstanceInfo(client: Client): Promise<Record<string, string>> {
  return (await query(client, "instanceinfo"))[0] ?? {};
}

/** Change the server instance's settings. Passed through as given. */
export async function editInstance(
  client: Client,
  settings: Record<string, ParamValue>,
): Promise<void> {
  await exec(client, "instanceedit", Object.entries(settings));
}

/**
 * Active IP bindings, when the instance is multi-homed.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function listBindings(
  client: Client,
  subsystem?: string,
): Promise<Array<{ subsystem: string; ip: string; port: number }>> {
  const rows = await query(client, "bindinglist", [["subsystem", subsystem]]);
  return rows.map((row) => ({
    subsystem: str(row, "subsystem"),
    ip: str(row, "ip"),
    port: num(row, "port"),
  }));
}

/** The server's build version. */
export async function getVersion(
  client: Client,
): Promise<{ version: string; build: number; platform: string }> {
  const row = (await query(client, "version"))[0] ?? {};
  return { version: str(row, "version"), build: num(row, "build"), platform: str(row, "platform") };
}

/** Which server and client this connection is, as the server sees it. */
export async function whoAmI(client: Client): Promise<Record<string, string>> {
  return (await query(client, "whoami"))[0] ?? {};
}

/** Connection statistics for our own session. */
export async function getConnectionInfo(client: Client): Promise<Record<string, string>> {
  return (await query(client, "serverrequestconnectioninfo"))[0] ?? {};
}

/**
 * The numeric id of the virtual server listening on `port`.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function getServerIDByPort(client: Client, port: number): Promise<bigint> {
  const rows = await query(client, "serveridgetbyport", [["virtualserver_port", port]]);
  return big(rows[0] ?? {}, "server_id");
}

// ---- Server groups ----------------------------------------------------------

/** Create a server group. */
export async function createServerGroup(
  client: Client,
  name: string,
  type?: number,
): Promise<ServerGroupID> {
  const rows = await query(client, "servergroupadd", [
    ["name", name],
    ["type", type],
  ]);
  return asServerGroupID(createdGroupID(rows, "sgid", name));
}

export async function deleteServerGroup(
  client: Client,
  sgid: ServerGroupID,
  force: boolean,
): Promise<void> {
  await exec(client, "servergroupdel", [
    ["sgid", sgid],
    ["force", force],
  ]);
}

export async function renameServerGroup(
  client: Client,
  sgid: ServerGroupID,
  name: string,
): Promise<void> {
  await exec(client, "servergrouprename", [
    ["sgid", sgid],
    ["name", name],
  ]);
}

/** Copy a server group; `tsgid` of 0 makes the server allocate a new id. */
export async function copyServerGroup(
  client: Client,
  sourceGroupID: ServerGroupID,
  targetGroupID: ServerGroupID,
  name: string,
  type: number,
): Promise<ServerGroupID> {
  const rows = await query(client, "servergroupcopy", [
    ["ssgid", sourceGroupID],
    ["tsgid", targetGroupID],
    ["name", name],
    ["type", type],
  ]);
  // Copying onto an existing group keeps that group's id.
  if (targetGroupID !== 0n) return targetGroupID;
  return asServerGroupID(createdGroupID(rows, "sgid", name));
}

/** Add a client to a server group. */
export async function addClientToServerGroup(
  client: Client,
  sgid: ServerGroupID,
  cldbid: ClientDBID,
): Promise<void> {
  await exec(client, "servergroupaddclient", [
    ["sgid", sgid],
    ["cldbid", cldbid],
  ]);
}

export async function removeClientFromServerGroup(
  client: Client,
  sgid: ServerGroupID,
  cldbid: ClientDBID,
): Promise<void> {
  await exec(client, "servergroupdelclient", [
    ["sgid", sgid],
    ["cldbid", cldbid],
  ]);
}

/** Members of a server group, optionally with their nicknames and uids. */
export async function listServerGroupClients(
  client: Client,
  sgid: ServerGroupID,
  options: { names?: boolean; uids?: boolean } = {},
): Promise<Array<{ databaseID: ClientDBID; nickname: string; uid: string }>> {
  const params: Array<readonly [string, ParamValue]> = [["sgid", sgid]];
  if (options.names) params.push(["-names", true]);
  if (options.uids) params.push(["-uid", true]);

  const rows = await query(client, "servergroupclientlist", params);
  return rows.map((row) => ({
    databaseID: big(row, "cldbid") as ClientDBID,
    nickname: str(row, "client_nickname"),
    uid: str(row, "client_unique_identifier"),
  }));
}

/** Server groups a client belongs to. */
export async function getServerGroupsByClient(
  client: Client,
  cldbid: ClientDBID,
): Promise<Array<{ id: ServerGroupID; name: string }>> {
  const rows = await query(client, "servergroupsbyclientid", [["cldbid", cldbid]]);
  return rows.map((row) => ({ id: asServerGroupID(big(row, "sgid")), name: str(row, "name") }));
}

/** Permissions set on a server group. */
export async function listServerGroupPermissions(
  client: Client,
  sgid: ServerGroupID,
): Promise<PermissionEntry[]> {
  return (await query(client, "servergrouppermlist", [["sgid", sgid]])).map(parsePermission);
}

export async function addServerGroupPermission(
  client: Client,
  sgid: ServerGroupID,
  options: {
    permvalue: number;
    permnegated: boolean;
    permskip: boolean;
    permid?: PermissionID;
    permsid?: string;
  },
): Promise<void> {
  await exec(client, "servergroupaddperm", [
    ["sgid", sgid],
    ["permvalue", options.permvalue],
    ["permnegated", options.permnegated],
    ["permskip", options.permskip],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

export async function deleteServerGroupPermission(
  client: Client,
  sgid: ServerGroupID,
  options: { permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "servergroupdelperm", [
    ["sgid", sgid],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

// ---- Temporary passwords ----------------------------------------------------

export interface TempPassword {
  password: string;
  description: string;
  start: number;
  end: number;
  targetChannelID: ChannelID;
}

export async function listTempPasswords(client: Client): Promise<TempPassword[]> {
  const rows = await query(client, "servertemppasswordlist");
  return rows.map((row) => ({
    password: str(row, "pw_clear"),
    description: str(row, "desc"),
    start: num(row, "start"),
    end: num(row, "end"),
    targetChannelID: big(row, "tcid") as ChannelID,
  }));
}

/** Create a temporary password, and return it as the server generated it. */
export async function addTempPassword(
  client: Client,
  options: {
    description: string;
    /** Validity in seconds. */
    duration: number;
    targetChannelID: ChannelID;
    targetChannelPassword?: string;
  },
): Promise<string> {
  const rows = await query(client, "servertemppasswordadd", [
    ["pw", ""],
    ["desc", options.description],
    ["duration", options.duration],
    ["tcid", options.targetChannelID],
    ["tcpw", options.targetChannelPassword],
  ]);
  return str(rows[0] ?? {}, "pw_clear");
}

export async function deleteTempPassword(client: Client, password: string): Promise<void> {
  await exec(client, "servertemppassworddel", [["pw", password]]);
}
