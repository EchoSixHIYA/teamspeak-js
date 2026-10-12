import { describe, expect, it } from "vitest";
import {
  findChannels,
  listChannelClientPermissions,
  listChannelPermissions,
  listChannels,
} from "./channels.js";
import {
  findClientDatabase,
  findClients,
  getClientIDs,
  listClientDatabase,
  listClientPermissions,
  listClients,
} from "./clients.js";
import { listActiveTransfers, listFiles } from "./files.js";
import {
  findPermission,
  getPermissionOverview,
  listChannelGroupClients,
  listChannelGroupPermissions,
  listChannelGroups,
  listPermissions,
  listPrivilegeKeys,
} from "./groups.js";
import { listBans, listComplaints, listMessages } from "./moderation.js";
import {
  getServerGroupsByClient,
  listBindings,
  listServerGroupClients,
  listServerGroupPermissions,
  listServerGroups,
  listTempPasswords,
} from "./server.js";
import {
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asServerGroupID,
  asUID,
} from "../command/ids.js";
import type { CommandExecutor } from "../command/request.js";
import { ErrorCode } from "../errorcode.js";
import { ServerError } from "../errors.js";
import { permissionByName } from "../permission.js";

/** An executor whose every command the server refuses with `code`. */
const refusing = (code: number): CommandExecutor => ({
  send: async () => {
    throw new ServerError(code, "refused");
  },
});

const cid = asChannelID(1n);
const cldbid = asClientDBID(1n);
const permission = permissionByName("i_client_talk_power");

/** Every list and find, called with whatever it needs. */
const lists: Record<string, (client: CommandExecutor) => Promise<readonly unknown[]>> = {
  listChannels: (c) => listChannels(c),
  findChannels: (c) => findChannels(c, "x"),
  listChannelPermissions: (c) => listChannelPermissions(c, cid),
  listChannelClientPermissions: (c) => listChannelClientPermissions(c, cid, cldbid),
  listClients: (c) => listClients(c),
  findClients: (c) => findClients(c, "x"),
  getClientIDs: (c) => getClientIDs(c, asUID("x")),
  listClientDatabase: (c) => listClientDatabase(c),
  findClientDatabase: (c) => findClientDatabase(c, "x"),
  listClientPermissions: (c) => listClientPermissions(c, cldbid),
  listFiles: (c) => listFiles(c, cid, "/"),
  listActiveTransfers: (c) => listActiveTransfers(c),
  listChannelGroups: (c) => listChannelGroups(c),
  listChannelGroupClients: (c) => listChannelGroupClients(c),
  listChannelGroupPermissions: (c) => listChannelGroupPermissions(c, asChannelGroupID(1n)),
  listPermissions: (c) => listPermissions(c),
  findPermission: (c) => findPermission(c, permission),
  getPermissionOverview: (c) => getPermissionOverview(c, cid, cldbid),
  listPrivilegeKeys: (c) => listPrivilegeKeys(c),
  listBans: (c) => listBans(c),
  listComplaints: (c) => listComplaints(c),
  listMessages: (c) => listMessages(c),
  listServerGroups: (c) => listServerGroups(c),
  listBindings: (c) => listBindings(c),
  listServerGroupClients: (c) => listServerGroupClients(c, asServerGroupID(1n)),
  getServerGroupsByClient: (c) => getServerGroupsByClient(c, cldbid),
  listServerGroupPermissions: (c) => listServerGroupPermissions(c, asServerGroupID(1n)),
  listTempPasswords: (c) => listTempPasswords(c),
};

describe("empty results", () => {
  // The server reports an empty list as error 1281; several lists threw it.
  it.each(Object.keys(lists))("%s answers [] for 1281", async (name) => {
    await expect(lists[name]!(refusing(ErrorCode.DatabaseEmptyResult))).resolves.toEqual([]);
  });

  it.each(Object.keys(lists))("%s still throws any other refusal", async (name) => {
    await expect(
      lists[name]!(refusing(ErrorCode.PermissionsClientInsufficient)),
    ).rejects.toBeInstanceOf(ServerError);
  });

  // Measured on TS3 3.13: clientfind finding no one answers 512, channelfind
  // finding nothing 768. Neither command names a client or a channel, so
  // that can only mean no match.
  it("answers a search that found nothing with []", async () => {
    await expect(findClients(refusing(ErrorCode.ClientInvalidID), "x")).resolves.toEqual([]);
    await expect(findChannels(refusing(ErrorCode.ChannelInvalidID), "x")).resolves.toEqual([]);
    await expect(listClients(refusing(ErrorCode.ClientInvalidID))).rejects.toBeInstanceOf(
      ServerError,
    );
  });
});
