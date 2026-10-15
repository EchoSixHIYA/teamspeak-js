/**
 * The notifications a server pushes, read as the events every client
 * delivers.
 *
 * The voice protocol and ServerQuery carry the same notifications — a move is
 * `notifyclientmoved` on both — and only their framing differs, which each
 * client's own reader takes care of. So the parsing lives here, and both
 * clients call it rather than keeping a copy each.
 *
 * A result is one notification's worth: the event it makes, plus what only the
 * client can decide, such as whether a client that left view was itself.
 */

import { asChannelID, asClientID, asUID } from "./command/ids.js";
import { parseClient } from "./api/parse.js";
import { parseInt10, parseUint16, parseUint64 } from "./helpers.js";
import type { Command } from "./command/command.js";
import type {
  ClientEnterEvent,
  ClientLeaveEvent,
  ClientMovedEvent,
  PokeEvent,
  TextMessageEvent,
} from "./events.js";

/** What one notification amounts to. */
export type NotificationResult =
  | { kind: "clientEnter"; info: ClientEnterEvent }
  | { kind: "clientLeave"; event: ClientLeaveEvent; isSelf: boolean }
  | { kind: "clientMoved"; event: ClientMovedEvent }
  | { kind: "textMessage"; message: TextMessageEvent }
  | { kind: "poked"; event: PokeEvent }
  | { kind: "unknown" };

/**
 * Read a notification. `cmd` is the parsed notification line, `selfCLID` this
 * client's own id (0 when it is not known yet), and `clients` the clients the
 * caller knows, which the enter and leave notifications keep current and the
 * others read: a text message carries no groups, and a move of the client's
 * own carries no invoker.
 */
export function handleNotification(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientEnterEvent>,
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

function handleClientEnterView(
  cmd: Command,
  clients: Map<number, ClientEnterEvent>,
): NotificationResult {
  const info = parseClient(cmd.params);
  // No client has id 0: a row without one describes nobody.
  if (info.id === 0) return { kind: "unknown" };
  clients.set(info.id, info);
  return { kind: "clientEnter", info };
}

function handleClientLeftView(
  cmd: Command,
  selfCLID: number,
  clients: Map<number, ClientEnterEvent>,
): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };
  const isSelf = clid === selfCLID;
  clients.delete(clid);
  return {
    kind: "clientLeave",
    event: {
      clientID: clid,
      reason: parseInt10(cmd.params["reasonid"] ?? ""),
      reasonMessage: cmd.params["reasonmsg"] ?? "",
      invokerID: asClientID(parseUint16(cmd.params["invokerid"] ?? "")),
      invokerName: cmd.params["invokername"] ?? "",
      invokerUID: asUID(cmd.params["invokeruid"] ?? ""),
    },
    isSelf,
  };
}

function handleClientMoved(
  cmd: Command,
  clients: Map<number, ClientEnterEvent>,
): NotificationResult {
  const clid = asClientID(parseUint16(cmd.params["clid"] ?? ""));
  const ctid = asChannelID(parseUint64(cmd.params["ctid"] ?? ""));
  if (clid === 0) return { kind: "unknown" };

  const existing = clients.get(clid);
  if (existing) clients.set(clid, { ...existing, channelID: ctid });

  // A move the client made itself names no invoker, so the fields are empty;
  // the client it knows by `clid` is who that was.
  const invokerID = asClientID(parseUint16(cmd.params["invokerid"] ?? ""));
  const invoker = clients.get(invokerID === 0 ? clid : invokerID);

  return {
    kind: "clientMoved",
    event: {
      clientID: clid,
      targetChannelID: ctid,
      reason: parseInt10(cmd.params["reasonid"] ?? ""),
      reasonMessage: cmd.params["reasonmsg"] ?? "",
      invokerID,
      invokerName: cmd.params["invokername"] ?? invoker?.nickname ?? "",
      invokerUID: asUID(cmd.params["invokeruid"] ?? invoker?.uid ?? ""),
    },
  };
}

function handleTextMessage(
  cmd: Command,
  clients: Map<number, ClientEnterEvent>,
): NotificationResult {
  const invokerID = asClientID(parseUint16(cmd.params["invokerid"] ?? ""));
  const invokerInfo = clients.get(invokerID);

  const message: TextMessageEvent = {
    targetMode: parseInt10(cmd.params["targetmode"] ?? ""),
    targetID: asClientID(parseUint16(cmd.params["target"] ?? "")),
    invokerID,
    invokerName: cmd.params["invokername"] ?? "",
    invokerUID: asUID(cmd.params["invokeruid"] ?? invokerInfo?.uid ?? ""),
    message: cmd.params["msg"] ?? "",
    invokerGroups: invokerInfo?.serverGroups,
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
