import type { Command } from "@honeybbq/teamspeak-core";
import type {
  ClientInfo,
  ClientLeftViewEvent,
  ClientMovedEvent,
  TextMessage,
  PokeEvent,
} from "./types.js";
import {
  parseClient,
  parseUint64,
  parseUint16,
  parseInt10,
} from "@honeybbq/teamspeak-core/internal";
import { asChannelID, asClientID, asUID, type TextMessageTarget } from "@honeybbq/teamspeak-core";

export type NotificationResult =
  | { kind: "clientEnter"; info: ClientInfo }
  | { kind: "clientLeave"; event: ClientLeftViewEvent; isSelf: boolean }
  | { kind: "clientMoved"; event: ClientMovedEvent; reasonMessage: string }
  | { kind: "textMessage"; message: TextMessage }
  | { kind: "poked"; event: PokeEvent }
  | { kind: "unknown" };

export function handleNotification(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientInfo>,
  _nickname: string,
): NotificationResult {
  switch (cmd.name) {
    case "notifycliententerview":
      return handleClientEnterView(cmd, clients);
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

function handleClientEnterView(cmd: Command, clients: Map<number, ClientInfo>): NotificationResult {
  const info = parseClient(cmd.params);
  if (info.id !== 0) clients.set(info.id, info);
  return { kind: "clientEnter", info };
}

function handleClientLeftView(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientInfo>,
): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  const isSelf = clid !== 0 && clid === selfCLID;
  if (clid !== 0) clients.delete(clid);
  return {
    kind: "clientLeave",
    event: {
      id: clid,
      reason: parseInt10(cmd.params["reasonid"] ?? ""),
      reasonMessage: cmd.params["reasonmsg"] ?? "",
      invokerID: asClientID(parseUint16(cmd.params["invokerid"] ?? "")),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: asUID(cmd.params["invokeruid"] ?? ""),
    },
    isSelf,
  };
}

function handleClientMoved(cmd: Command, clients: Map<number, ClientInfo>): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  const ctid = asChannelID(parseUint64(cmd.params["ctid"] ?? ""));

  if (clid !== 0) {
    const existing = clients.get(clid);
    if (existing) clients.set(clid, { ...existing, channelID: ctid });
  }

  return {
    kind: "clientMoved",
    event: {
      id: clid,
      targetChannelID: ctid,
      reason: parseInt10(cmd.params["reasonid"] ?? ""),
      invokerID: asClientID(parseUint16(cmd.params["invokerid"] ?? "")),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: asUID(cmd.params["invokeruid"] ?? ""),
    },
    reasonMessage: cmd.params["reasonmsg"] ?? "",
  };
}

function handleTextMessage(cmd: Command, clients: Map<number, ClientInfo>): NotificationResult {
  const invokerID = asClientID(parseUint16(cmd.params["invokerid"] ?? ""));
  const invokerInfo = clients.get(invokerID);

  const message: TextMessage = {
    targetMode: parseInt10(cmd.params["targetmode"] ?? "") as TextMessageTarget,
    targetID: asClientID(parseUint16(cmd.params["target"] ?? "")),
    invokerID,
    invokerName: cmd.params["invokername"] ?? "",
    invokerUID: asUID(cmd.params["invokeruid"] ?? invokerInfo?.uid ?? ""),
    message: cmd.params["msg"] ?? "",
    invokerGroups: invokerInfo?.serverGroups ?? [],
  };

  return { kind: "textMessage", message };
}

function handleClientPoked(cmd: Command): NotificationResult {
  return {
    kind: "poked",
    event: {
      invokerID: asClientID(parseUint16(cmd.params["invokerid"] ?? "")),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: asUID(cmd.params["invokeruid"] ?? ""),
      message: cmd.params["msg"] ?? "",
    },
  };
}
