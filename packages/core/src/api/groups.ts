/**
 * Channel groups, the permission catalogue, and the privilege keys that grant groups.
 */

import {
  exec,
  query,
  list,
  encodeFields,
  nonEmpty,
  parsePermission,
  permissionParam,
  createdGroupID,
  str,
  big,
  num,
  bool,
  icon,
  date,
} from "./command.js";
import type { Params, PermissionEntry, WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type {
  ChannelGroupID,
  ChannelID,
  ClientDBID,
  IconID,
  PermissionID,
  ServerGroupID,
} from "../command/ids.js";
import {
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asPermissionID,
  asServerGroupID,
} from "../command/ids.js";
import { PermissionTarget, TokenType } from "../enums.js";
import type { GroupType } from "../enums.js";
import type { Permission } from "../permission.js";

/** A channel group as `channelgrouplist` reports it. */
export interface ChannelGroup {
  /** The group's id. */
  readonly id: ChannelGroupID;
  /** The group's name. */
  readonly name: string;
  /** What kind of group this is, one of {@link GroupType}. */
  readonly type: number;
  /** The group's icon, or undefined for none. */
  readonly iconID: IconID | undefined;
  /** Whether membership is stored, rather than lost when the server restarts. */
  readonly savedInDatabase: boolean;
  /** Where the group sorts among the others; a 32-bit value. */
  readonly sortID: number;
  /** Where the group's name shows beside a member's nickname, one of {@link GroupNameMode}. */
  readonly nameMode: number;
  /** The power needed to modify the group. */
  readonly modifyPower: number;
  /** The power needed to add a member. */
  readonly memberAddPower: number;
  /** The power needed to remove a member. */
  readonly memberRemovePower: number;
}

const parseChannelGroup = (row: Record<string, string>): ChannelGroup => ({
  id: asChannelGroupID(big(row, "cgid")),
  name: str(row, "name"),
  type: num(row, "type"),
  iconID: icon(row, "iconid"),
  savedInDatabase: bool(row, "savedb"),
  sortID: num(row, "sortid"),
  nameMode: num(row, "namemode"),
  modifyPower: num(row, "n_modifyp"),
  memberAddPower: num(row, "n_member_addp"),
  memberRemovePower: num(row, "n_member_removep"),
});

/** Every channel group. */
export async function listChannelGroups(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<ChannelGroup[]> {
  return (await query(client, "channelgrouplist", [], options)).map(parseChannelGroup);
}

/**
 * Create a channel group.
 *
 * `type` is required, and always sent: the server's own default is
 * `GroupType.Regular`, while the type's first value is `Template`, so leaving
 * it to a default on either side is a trap.
 */
export async function createChannelGroup(
  client: CommandExecutor,
  name: string,
  type: GroupType,
  options?: CommandOptions,
): Promise<ChannelGroupID> {
  const rows = await query(
    client,
    "channelgroupadd",
    [
      ["name", name],
      ["type", type],
    ],
    options,
  );
  return asChannelGroupID(createdGroupID(rows, "cgid", name));
}

/** How a group is deleted. */
export interface GroupDeleteOptions extends CommandOptions {
  /** Delete the group even while it has members; false by default (`force`, always sent). */
  readonly force?: boolean | undefined;
}

/** Delete a channel group. */
export async function deleteChannelGroup(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  options: GroupDeleteOptions = {},
): Promise<void> {
  await exec(
    client,
    "channelgroupdel",
    [
      ["cgid", cgid],
      ["force", options.force ?? false],
    ],
    options,
  );
}

/** Rename a channel group. */
export async function renameChannelGroup(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  name: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "channelgrouprename",
    [
      ["cgid", cgid],
      ["name", name],
    ],
    options,
  );
}

/**
 * Copy a channel group's permissions onto another; a `targetGroupID` of 0
 * makes the server create a new group named `name`, of `type`.
 */
export async function copyChannelGroup(
  client: CommandExecutor,
  sourceGroupID: ChannelGroupID,
  targetGroupID: ChannelGroupID,
  name: string,
  type: GroupType,
  options?: CommandOptions,
): Promise<ChannelGroupID> {
  const rows = await query(
    client,
    "channelgroupcopy",
    [
      ["scgid", sourceGroupID],
      ["tcgid", targetGroupID],
      ["name", name],
      ["type", type],
    ],
    options,
  );
  // Copying onto an existing group keeps that group's id.
  if (targetGroupID !== 0n) return targetGroupID;
  return asChannelGroupID(createdGroupID(rows, "cgid", name));
}

/**
 * Which channel group memberships {@link listChannelGroupClients} reports.
 * Unset fields do not narrow the list.
 */
export interface ChannelGroupClientFilter extends CommandOptions {
  /** Only memberships in this channel (`cid`). */
  readonly channelID?: ChannelID | undefined;
  /** Only this client's memberships (`cldbid`). */
  readonly databaseID?: ClientDBID | undefined;
  /** Only memberships of this group (`cgid`). */
  readonly groupID?: ChannelGroupID | undefined;
}

const membershipFilterNames: WireNames<ChannelGroupClientFilter> = {
  channelID: "cid",
  databaseID: "cldbid",
  groupID: "cgid",
};

/** One client holding one channel group in one channel. */
export interface ChannelGroupMembership {
  /** The channel. */
  readonly channelID: ChannelID;
  /** The client's database id. */
  readonly databaseID: ClientDBID;
  /** The channel group. */
  readonly groupID: ChannelGroupID;
}

/**
 * Which channel group each client holds in which channel.
 *
 * Set at least one filter field to narrow it; called with none the server may
 * return nothing.
 */
export async function listChannelGroupClients(
  client: CommandExecutor,
  options: ChannelGroupClientFilter = {},
): Promise<ChannelGroupMembership[]> {
  const rows = await list(
    client,
    "channelgroupclientlist",
    encodeFields(options, membershipFilterNames),
    options,
  );
  return rows.map((row) => ({
    channelID: asChannelID(big(row, "cid")),
    databaseID: asClientDBID(big(row, "cldbid")),
    groupID: asChannelGroupID(big(row, "cgid")),
  }));
}

/** Permissions set on a channel group. */
export async function listChannelGroupPermissions(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  options?: CommandOptions,
): Promise<PermissionEntry[]> {
  return (await list(client, "channelgrouppermlist", [["cgid", cgid]], options)).map(
    parsePermission,
  );
}

/** Set a permission on a channel group. */
export async function addChannelGroupPermission(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  permission: Permission,
  value: number,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "channelgroupaddperm",
    [["cgid", cgid], permissionParam(permission), ["permvalue", value]],
    options,
  );
}

/** Remove a permission from a channel group. */
export async function deleteChannelGroupPermission(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  permission: Permission,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "channelgroupdelperm", [["cgid", cgid], permissionParam(permission)], options);
}

// ---- Permissions ------------------------------------------------------------

/** One permission in the server's catalogue. */
export interface PermissionInfo {
  /** The permission's id on this server build (`permid`). */
  readonly id: PermissionID;
  /** The permission's name, such as "i_client_talk_power" (`permname`). */
  readonly name: string;
  /** What the permission controls (`permdesc`). */
  readonly description: string;
}

/**
 * The server's full permission catalogue.
 *
 * Rows that name no permission — the group markers some servers interleave —
 * are left out.
 */
export async function listPermissions(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<PermissionInfo[]> {
  const rows = await query(client, "permissionlist", [], options);
  return rows
    .filter((row) => row["permname"] !== undefined)
    .map((row) => ({
      id: asPermissionID(num(row, "permid")),
      name: str(row, "permname"),
      description: str(row, "permdesc"),
    }));
}

/**
 * Resolve a permission name to its numeric id, or undefined when the server
 * knows no such permission.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function getPermissionIDByName(
  client: CommandExecutor,
  name: string,
  options?: CommandOptions,
): Promise<PermissionID | undefined> {
  const rows = await query(client, "permidgetbyname", [["permsid", name]], options);
  if (rows.length === 0) return undefined;
  return asPermissionID(num(rows[0] ?? {}, "permid"));
}

/**
 * What a permission is set on, as `permfind` and `permoverview` report it:
 * discriminated on `target`, so each kind carries its own typed ids. The wire
 * sends them as `t`, `id1` and `id2`, whose meaning depends on `t`; a row with
 * a target this table does not name is left out of the results.
 */
export type PermissionLocation =
  | {
      /** Set on a server group. */
      readonly target: typeof PermissionTarget.ServerGroup;
      /** The group (`id1`). */
      readonly serverGroupID: ServerGroupID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    }
  | {
      /** Set on a client, server-wide. */
      readonly target: typeof PermissionTarget.Client;
      /** The client (`id1`). */
      readonly databaseID: ClientDBID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    }
  | {
      /** Set on a channel. */
      readonly target: typeof PermissionTarget.Channel;
      /** The channel (`id1`). */
      readonly channelID: ChannelID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    }
  | {
      /** Set on a channel group, in one channel. */
      readonly target: typeof PermissionTarget.ChannelGroup;
      /** The channel (`id1`). */
      readonly channelID: ChannelID;
      /** The group (`id2`). */
      readonly channelGroupID: ChannelGroupID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    }
  | {
      /** Set on a client within one channel. */
      readonly target: typeof PermissionTarget.ChannelClient;
      /** The channel (`id1`). */
      readonly channelID: ChannelID;
      /** The client (`id2`). */
      readonly databaseID: ClientDBID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    };

/** Read a location from a `permfind` or `permoverview` row; undefined for an unknown target. */
function parseLocation(row: Record<string, string>): PermissionLocation | undefined {
  const permission = asPermissionID(num(row, "p"));
  const id1 = big(row, "id1");
  const id2 = big(row, "id2");
  switch (num(row, "t")) {
    case PermissionTarget.ServerGroup:
      return {
        target: PermissionTarget.ServerGroup,
        serverGroupID: asServerGroupID(id1),
        permission,
      };
    case PermissionTarget.Client:
      return { target: PermissionTarget.Client, databaseID: asClientDBID(id1), permission };
    case PermissionTarget.Channel:
      return { target: PermissionTarget.Channel, channelID: asChannelID(id1), permission };
    case PermissionTarget.ChannelGroup:
      return {
        target: PermissionTarget.ChannelGroup,
        channelID: asChannelID(id1),
        channelGroupID: asChannelGroupID(id2),
        permission,
      };
    case PermissionTarget.ChannelClient:
      return {
        target: PermissionTarget.ChannelClient,
        channelID: asChannelID(id1),
        databaseID: asClientDBID(id2),
        permission,
      };
    default:
      return undefined;
  }
}

/** Every place a permission is set. */
export async function findPermission(
  client: CommandExecutor,
  permission: Permission,
  options?: CommandOptions,
): Promise<PermissionLocation[]> {
  const rows = await list(client, "permfind", [permissionParam(permission)], options);
  return rows.flatMap((row) => parseLocation(row) ?? []);
}

/** How a permission applies, in a {@link PermissionOverviewEntry}. */
export interface PermissionOverviewValue {
  /** The permission's value there (`v`). */
  readonly value: number;
  /** Whether the value is negated (`n`). */
  readonly negated: boolean;
  /** Whether it skips channel and client overrides (`s`). */
  readonly skip: boolean;
}

/** One permission applying to a client in a channel, as `permoverview` reports it. */
export type PermissionOverviewEntry = PermissionLocation & PermissionOverviewValue;

/**
 * Every permission that applies to a client in a channel, from every source,
 * unfiltered.
 *
 * It always asks for all of them (`permid=0`): the server requires a
 * permission parameter — omitting it fails with 1539 — and treats 0 as "all".
 * Each entry names its permission, so one is easy to pick out.
 */
export async function getPermissionOverview(
  client: CommandExecutor,
  cid: ChannelID,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<PermissionOverviewEntry[]> {
  const rows = await list(
    client,
    "permoverview",
    [
      ["cid", cid],
      ["cldbid", cldbid],
      ["permid", 0],
    ],
    options,
  );
  return rows.flatMap((row) => {
    const location = parseLocation(row);
    if (location === undefined) return [];
    return [{ ...location, value: num(row, "v"), negated: bool(row, "n"), skip: bool(row, "s") }];
  });
}

/**
 * Wipe all permission overrides and restore the defaults.
 *
 * Destructive: every custom permission on the server goes. It also drops the
 * caller's own rights, because it resets the group they rely on.
 */
export async function resetPermissions(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "permreset", [], options);
}

// ---- Privilege keys ----------------------------------------------

/**
 * A privilege key, which grants a group when redeemed. The server also
 * accepts the older `token…` commands for the same keys; these functions use
 * the `privilegekey…` ones.
 */
export interface PrivilegeKey {
  /** The key itself. */
  readonly token: string;
  /** Which kind of group the key grants, one of {@link TokenType}. */
  readonly type: number;
  /** The server group a `TokenType.ServerGroup` key grants; undefined otherwise. */
  readonly serverGroupID: ServerGroupID | undefined;
  /** The channel group a `TokenType.ChannelGroup` key grants; undefined otherwise. */
  readonly channelGroupID: ChannelGroupID | undefined;
  /** The channel a `TokenType.ChannelGroup` key grants its group in; undefined otherwise. */
  readonly channelID: ChannelID | undefined;
  /** The key's description. */
  readonly description: string;
  /** When the key was created. */
  readonly createdAt: Date | undefined;
}

/**
 * Read a key. The wire carries the group as `token_id1` and the channel as
 * `token_id2`, whichever kind of group it is; which typed field each belongs in
 * depends on the token type.
 */
const parseKey = (row: Record<string, string>): PrivilegeKey => {
  const type = num(row, "token_type");
  const channelGroup = type === TokenType.ChannelGroup;
  return {
    token: str(row, "token"),
    type,
    serverGroupID: channelGroup ? undefined : asServerGroupID(big(row, "token_id1")),
    channelGroupID: channelGroup ? asChannelGroupID(big(row, "token_id1")) : undefined,
    channelID: channelGroup ? asChannelID(big(row, "token_id2")) : undefined,
    description: str(row, "token_description"),
    createdAt: date(row, "token_created"),
  };
};

/** Every privilege key on the server. */
export async function listPrivilegeKeys(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<PrivilegeKey[]> {
  return (await list(client, "privilegekeylist", [], options)).map(parseKey);
}

/**
 * A privilege key to create: one that grants a server group, or one that
 * grants a channel group in one channel.
 */
export type PrivilegeKeyOptions =
  | {
      /** The server group the key grants. */
      readonly serverGroupID: ServerGroupID;
      readonly channelGroupID?: never;
      readonly channelID?: never;
      /** Shown in the key list; unset or "" sends none. */
      readonly description?: string | undefined;
    }
  | {
      readonly serverGroupID?: never;
      /** The channel group the key grants. */
      readonly channelGroupID: ChannelGroupID;
      /** The channel it grants the group in. */
      readonly channelID: ChannelID;
      /** Shown in the key list; unset or "" sends none. */
      readonly description?: string | undefined;
    };

/**
 * Encode the group a key grants.
 *
 * The wire form is a type and two untyped ids whose meaning depends on it:
 * `tokenid1` is the group and `tokenid2` the channel. The options used to take
 * them as such, documented the other way round, so the typed fields are checked
 * here to describe exactly one kind of key.
 */
function keyParams(key: PrivilegeKeyOptions): Params {
  const { serverGroupID, channelGroupID, channelID } = key as {
    serverGroupID?: unknown;
    channelGroupID?: unknown;
    channelID?: unknown;
  };
  const isID = (v: unknown): v is bigint => typeof v === "bigint" && v > 0n;
  const description = nonEmpty(key.description ?? "");
  if (isID(serverGroupID) && channelGroupID === undefined && channelID === undefined) {
    return [
      ["tokentype", TokenType.ServerGroup],
      ["tokenid1", serverGroupID],
      ["tokenid2", 0],
      ["tokendescription", description],
    ];
  }
  if (serverGroupID === undefined && isID(channelGroupID) && isID(channelID)) {
    return [
      ["tokentype", TokenType.ChannelGroup],
      ["tokenid1", channelGroupID],
      ["tokenid2", channelID],
      ["tokendescription", description],
    ];
  }
  throw new TypeError("a key grants a server group, or a channel group in a channel");
}

/** Create a privilege key. Returns the key as the server generated it. */
export async function addPrivilegeKey(
  client: CommandExecutor,
  key: PrivilegeKeyOptions,
  options?: CommandOptions,
): Promise<string> {
  const rows = await query(client, "privilegekeyadd", keyParams(key), options);
  return str(rows[0] ?? {}, "token");
}

/** Delete a privilege key. */
export async function deletePrivilegeKey(
  client: CommandExecutor,
  token: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "privilegekeydelete", [["token", token]], options);
}

/**
 * Redeem a privilege key.
 *
 * The key grants only if this connection has not already used one.
 */
export async function usePrivilegeKey(
  client: CommandExecutor,
  token: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "privilegekeyuse", [["token", token]], options);
}
