import type { Command } from "@honeybbq/teamspeak-core";
import type {
  ClientInfo,
  ClientLeftViewEvent,
  ClientMovedEvent,
  TextMessage,
  PokeEvent,
} from "./types.js";
import { parseUint64, parseUint16, parseInt10 } from "@honeybbq/teamspeak-core/internal";

export type NotificationResult =
  | { kind: "clientEnter"; info: ClientInfo }
  | { kind: "clientLeave"; event: ClientLeftViewEvent; isSelf: boolean }
  | { kind: "clientMoved"; event: ClientMovedEvent }
  | { kind: "textMessage"; message: TextMessage }
  | { kind: "poked"; event: PokeEvent }
  | { kind: "unknown" };

export function handleNotification(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientInfo>,
  nickname: string,
): NotificationResult {
  switch (cmd.name) {
    case "notifycliententerview":
      return handleClientEnterView(cmd, clients, nickname);
    case "notifyclientleftview":
      return handleClientLeftView(cmd, selfCLID, clients);
    case "notifyclientmoved":
      return handleClientMoved(cmd, clients);
    case "notifytextmessage":
      return handleTextMessage(cmd, clients);
    case "notifyclientpoke":
      return handleClientPoked(cmd);
    default:
      return { kind: "unknown" };
  }
}

function handleClientEnterView(
  cmd: Command,
  clients: Map<number, ClientInfo>,
  _nickname: string,
): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const ctid = parseUint64(cmd.params["ctid"] ?? "");
  const clientType = parseInt10(cmd.params["client_type"] ?? "");
  const groupsStr = cmd.params["client_servergroups"] ?? "";

  const info: ClientInfo = {
    id: clid,
    nickname: cmd.params["client_nickname"] ?? "",
    uid: cmd.params["client_unique_identifier"] ?? "",
    channelID: ctid,
    type: clientType,
    serverGroups: groupsStr ? groupsStr.split(",") : [],
  };

  if (clid !== 0) {
    clients.set(clid, info);
  }

  return { kind: "clientEnter", info };
}

function handleClientLeftView(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientInfo>,
): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const reasonID = parseInt10(cmd.params["reasonid"] ?? "");

  const isSelf = clid === selfCLID;
  if (clid !== 0) clients.delete(clid);

  return {
    kind: "clientLeave",
    event: {
      id: clid,
      reasonID,
      reasonMsg: cmd.params["reasonmsg"] ?? "",
      targetID: parseUint16(cmd.params["targetid"] ?? ""),
    },
    isSelf,
  };
}

function handleClientMoved(cmd: Command, clients: Map<number, ClientInfo>): NotificationResult {
  const clid = parseUint16(cmd.params["clid"] ?? "");
  const ctid = parseUint64(cmd.params["ctid"] ?? "");

  if (clid !== 0) {
    const existing = clients.get(clid);
    if (existing) clients.set(clid, { ...existing, channelID: ctid });
  }

  return {
    kind: "clientMoved",
    event: {
      id: clid,
      targetChannelID: ctid,
      reasonID: parseInt10(cmd.params["reasonid"] ?? ""),
      invokerID: parseUint16(cmd.params["invokerid"] ?? ""),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: cmd.params["invokeruid"] ?? "",
    },
  };
}

function handleTextMessage(cmd: Command, clients: Map<number, ClientInfo>): NotificationResult {
  const invokerID = parseUint16(cmd.params["invokerid"] ?? "");
  const invokerInfo = clients.get(invokerID);

  const message: TextMessage = {
    targetMode: parseInt10(cmd.params["targetmode"] ?? ""),
    targetID: parseUint64(cmd.params["target"] ?? ""),
    invokerID,
    invokerName: cmd.params["invokername"] ?? "",
    invokerUID: cmd.params["invokeruid"] ?? invokerInfo?.uid ?? "",
    message: cmd.params["msg"] ?? "",
    invokerGroups: invokerInfo?.serverGroups ?? [],
  };

  return { kind: "textMessage", message };
}

function handleClientPoked(cmd: Command): NotificationResult {
  return {
    kind: "poked",
    event: {
      invokerID: parseUint16(cmd.params["invokerid"] ?? ""),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: cmd.params["invokeruid"] ?? "",
      message: cmd.params["msg"] ?? "",
    },
  };
}
