import type { ChannelInfo, DirectoryClientInfo } from "./types.js";
import { parseInt10, parseUint16, parseUint64 } from "./helpers.js";

/** Parse one `channellist` row into the stable directory representation. */
export function parseDirectoryChannel(params: Record<string, string>): ChannelInfo | null {
  const id = parseUint64(params["cid"] ?? "");
  if (id === 0n) return null;

  return {
    id,
    parentID: parseUint64(params["pid"] ?? params["cpid"] ?? ""),
    name: params["channel_name"] ?? "",
    description: params["channel_topic"] ?? params["channel_description"] ?? "",
  };
}

/** Parse one `channelclientlist` row into the stable directory representation. */
export function parseDirectoryClient(params: Record<string, string>): DirectoryClientInfo | null {
  const id = parseUint16(params["clid"] ?? "");
  if (id === 0) return null;

  const groups = params["client_servergroups"] ?? "";
  return {
    id,
    nickname: params["client_nickname"] ?? "",
    uid: params["client_unique_identifier"] ?? "",
    channelID: parseUint64(params["cid"] ?? params["ctid"] ?? ""),
    type: parseInt10(params["client_type"] ?? ""),
    serverGroups: groups ? groups.split(",") : [],
    away: params["client_away"] === "1",
    awayMessage: params["client_away_message"] ?? "",
    inputMuted: params["client_input_muted"] === "1",
    outputMuted: params["client_output_muted"] === "1",
    channelCommander: params["client_is_channel_commander"] === "1",
  };
}

/** Apply a channel notification and report whether the directory changed. */
export function applyChannelNotification(
  name: string,
  params: Record<string, string>,
  channels: Map<bigint, ChannelInfo>,
): boolean {
  const id = parseUint64(params["cid"] ?? "");
  if (id === 0n) return false;

  switch (name) {
    case "notifychannelcreated": {
      const channel = parseDirectoryChannel(params);
      if (!channel) return false;
      channels.set(channel.id, channel);
      return true;
    }
    case "notifychanneledited": {
      const current = channels.get(id);
      if (!current) return false;
      const next: ChannelInfo = { ...current };
      if (params["channel_name"] !== undefined) next.name = params["channel_name"];
      if (params["channel_topic"] !== undefined) next.description = params["channel_topic"];
      if (params["channel_description"] !== undefined && params["channel_topic"] === undefined) {
        next.description = params["channel_description"];
      }
      if (params["cpid"] !== undefined || params["pid"] !== undefined) {
        next.parentID = parseUint64(params["cpid"] ?? params["pid"] ?? "");
      }
      channels.set(id, next);
      return true;
    }
    case "notifychannelmoved": {
      const current = channels.get(id);
      if (!current) return false;
      channels.set(id, {
        ...current,
        parentID: parseUint64(params["cpid"] ?? params["pid"] ?? ""),
      });
      return true;
    }
    case "notifychanneldeleted":
      return channels.delete(id);
    default:
      return false;
  }
}

export function cloneDirectorySnapshot(
  channels: Map<bigint, ChannelInfo>,
  clients: Map<number, DirectoryClientInfo>,
): { channels: ChannelInfo[]; clients: DirectoryClientInfo[] } {
  return {
    channels: [...channels.values()].map((channel) => ({ ...channel })),
    clients: [...clients.values()].map((client) => ({
      ...client,
      serverGroups: [...client.serverGroups],
    })),
  };
}
