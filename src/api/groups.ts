/**
 * Channel groups, the permission catalogue, and the tokens used to join groups.
 */

import { exec, query, parsePermission, createdGroupID, str, big, num, bool } from "./command.js";
import type { PermissionEntry } from "./command.js";
import type { Client } from "../client.js";
import type { ChannelGroupID, ChannelID, ClientDBID, PermissionID } from "../command/ids.js";
import { asChannelGroupID } from "../command/ids.js";

/** A channel group as `channelgrouplist` reports it. */
export interface ChannelGroup {
  id: ChannelGroupID;
  name: string;
  type: number;
  iconID: bigint;
  savedInDatabase: boolean;
  sortID: bigint;
  nameMode: number;
  modifyPower: number;
  memberAddPower: number;
  memberRemovePower: number;
}

const parseChannelGroup = (row: Record<string, string>): ChannelGroup => ({
  id: asChannelGroupID(big(row, "cgid")),
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

/** Every channel group. */
export async function listChannelGroups(client: Client): Promise<ChannelGroup[]> {
  return (await query(client, "channelgrouplist")).map(parseChannelGroup);
}

export async function createChannelGroup(
  client: Client,
  name: string,
  type?: number,
): Promise<ChannelGroupID> {
  const rows = await query(client, "channelgroupadd", [
    ["name", name],
    ["type", type],
  ]);
  return asChannelGroupID(createdGroupID(rows, "cgid", name));
}

export async function deleteChannelGroup(
  client: Client,
  cgid: ChannelGroupID,
  force: boolean,
): Promise<void> {
  await exec(client, "channelgroupdel", [
    ["cgid", cgid],
    ["force", force],
  ]);
}

export async function renameChannelGroup(
  client: Client,
  cgid: ChannelGroupID,
  name: string,
): Promise<void> {
  await exec(client, "channelgrouprename", [
    ["cgid", cgid],
    ["name", name],
  ]);
}

export async function copyChannelGroup(
  client: Client,
  sourceGroupID: ChannelGroupID,
  targetGroupID: ChannelGroupID,
  name: string,
  type: number,
): Promise<ChannelGroupID> {
  const rows = await query(client, "channelgroupcopy", [
    ["scgid", sourceGroupID],
    ["tcgid", targetGroupID],
    ["name", name],
    ["type", type],
  ]);
  // Copying onto an existing group keeps that group's id.
  if (targetGroupID !== 0n) return targetGroupID;
  return asChannelGroupID(createdGroupID(rows, "cgid", name));
}

/**
 * Which channel group each client holds in which channel.
 *
 * Pass at least one of `cid`, `cldbid` or `cgid` to narrow it; called with
 * none the server may return nothing.
 */
export async function listChannelGroupClients(
  client: Client,
  options: { cid?: ChannelID; cldbid?: ClientDBID; cgid?: ChannelGroupID } = {},
): Promise<Array<{ channelID: ChannelID; databaseID: ClientDBID; groupID: ChannelGroupID }>> {
  const rows = await query(client, "channelgroupclientlist", [
    ["cid", options.cid],
    ["cldbid", options.cldbid],
    ["cgid", options.cgid],
  ]);
  return rows.map((row) => ({
    channelID: big(row, "cid") as ChannelID,
    databaseID: big(row, "cldbid") as ClientDBID,
    groupID: asChannelGroupID(big(row, "cgid")),
  }));
}

/** Permissions set on a channel group. */
export async function listChannelGroupPermissions(
  client: Client,
  cgid: ChannelGroupID,
): Promise<PermissionEntry[]> {
  return (await query(client, "channelgrouppermlist", [["cgid", cgid]])).map(parsePermission);
}

export async function addChannelGroupPermission(
  client: Client,
  cgid: ChannelGroupID,
  options: { permvalue: number; permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "channelgroupaddperm", [
    ["cgid", cgid],
    ["permvalue", options.permvalue],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

export async function deleteChannelGroupPermission(
  client: Client,
  cgid: ChannelGroupID,
  options: { permid?: PermissionID; permsid?: string },
): Promise<void> {
  await exec(client, "channelgroupdelperm", [
    ["cgid", cgid],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

// ---- Permissions ------------------------------------------------------------

/** The server's full permission catalogue. */
export async function listPermissions(client: Client): Promise<Record<string, string>[]> {
  return query(client, "permissionlist");
}

/**
 * Resolve a permission name to its numeric id.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function getPermissionIDByName(
  client: Client,
  permsid: string,
): Promise<PermissionID | undefined> {
  const rows = await query(client, "permidgetbyname", [["permsid", permsid]]);
  if (rows.length === 0) return undefined;
  return big(rows[0] ?? {}, "permid") as PermissionID;
}

/** Every place a permission is set, as `permfind` reports it. */
export async function findPermission(
  client: Client,
  options: { permid?: PermissionID; permsid?: string },
): Promise<Array<{ type: number; id1: bigint; id2: bigint; permission: bigint }>> {
  const rows = await query(client, "permfind", [
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
  return rows.map((row) => ({
    type: num(row, "t"),
    id1: big(row, "id1"),
    id2: big(row, "id2"),
    permission: big(row, "p"),
  }));
}

/** A client's effective permissions in a channel. */
export async function getPermissionOverview(
  client: Client,
  cid: ChannelID,
  cldbid: ClientDBID,
  options: { permid?: PermissionID; permsid?: string } = {},
): Promise<Record<string, string>[]> {
  return query(client, "permoverview", [
    ["cid", cid],
    ["cldbid", cldbid],
    ["permid", options.permid],
    ["permsid", options.permsid],
  ]);
}

/**
 * Wipe all permission overrides and restore the defaults.
 *
 * Destructive: every custom permission on the server goes. It also drops the
 * caller's own rights, because it resets the group they rely on.
 */
export async function resetPermissions(client: Client): Promise<void> {
  await exec(client, "permreset");
}

// ---- Tokens and privilege keys ----------------------------------------------

/**
 * A privilege key, which grants a group when redeemed.
 *
 * `token` and `privilegekey` name the same thing; the server accepts both
 * command families.
 */
export interface PrivilegeKey {
  token: string;
  type: number;
  id1: bigint;
  id2: bigint;
  description: string;
  createdAt: number;
}

const parseKey = (row: Record<string, string>): PrivilegeKey => ({
  token: str(row, "token"),
  type: num(row, "token_type"),
  id1: big(row, "token_id1"),
  id2: big(row, "token_id2"),
  description: str(row, "token_description"),
  createdAt: num(row, "token_created"),
});

/** Every privilege key on the server. */
export async function listPrivilegeKeys(client: Client): Promise<PrivilegeKey[]> {
  return (await query(client, "privilegekeylist")).map(parseKey);
}

export async function listTokens(client: Client): Promise<PrivilegeKey[]> {
  return (await query(client, "tokenlist")).map(parseKey);
}

/** Create a privilege key. Returns the key as the server generated it. */
export async function addPrivilegeKey(
  client: Client,
  options: {
    /** 0 = server group, 1 = channel group. */
    tokenType: number;
    /** Group id for a server group, channel id for a channel group. */
    tokenID1: bigint;
    /** Channel id for a channel group, otherwise 0. */
    tokenID2: bigint;
    description?: string;
  },
): Promise<string> {
  const rows = await query(client, "privilegekeyadd", [
    ["tokentype", options.tokenType],
    ["tokenid1", options.tokenID1],
    ["tokenid2", options.tokenID2],
    ["tokendescription", options.description],
  ]);
  return str(rows[0] ?? {}, "token");
}

export async function deletePrivilegeKey(client: Client, token: string): Promise<void> {
  await exec(client, "privilegekeydelete", [["token", token]]);
}

/**
 * Redeem a privilege key.
 *
 * The key grants only if this connection has not already used one.
 */
export async function usePrivilegeKey(client: Client, token: string): Promise<void> {
  await exec(client, "privilegekeyuse", [["token", token]]);
}

export async function addToken(
  client: Client,
  options: { tokenType: number; tokenID1: bigint; tokenID2: bigint; description?: string },
): Promise<string> {
  const rows = await query(client, "tokenadd", [
    ["tokentype", options.tokenType],
    ["tokenid1", options.tokenID1],
    ["tokenid2", options.tokenID2],
    ["tokendescription", options.description],
  ]);
  return str(rows[0] ?? {}, "token");
}

export async function deleteToken(client: Client, token: string): Promise<void> {
  await exec(client, "tokendelete", [["token", token]]);
}

export async function useToken(client: Client, token: string): Promise<void> {
  await exec(client, "tokenuse", [["token", token]]);
}
