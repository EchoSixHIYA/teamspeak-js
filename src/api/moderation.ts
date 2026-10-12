/**
 * Bans, complaints, offline messages and the server log.
 *
 * All four are administrative: expect a permission error, not an empty list,
 * when the client lacks the rights.
 */

import { exec, query, str, big, num, bool } from "./command.js";
import type { Client } from "../client.js";
import type { ChannelID, ClientDBID, ClientID } from "../command/ids.js";

// ---- Bans -------------------------------------------------------------------

/** A ban entry, as `banlist` reports it. */
export interface BanEntry {
  id: bigint;
  ip: string;
  name: string;
  uid: string;
  lastNickname: string;
  created: number;
  duration: number;
  invokerDatabaseID: ClientDBID;
  invokerName: string;
  invokerUID: string;
  reason: string;
}

const parseBan = (row: Record<string, string>): BanEntry => ({
  id: big(row, "banid"),
  ip: str(row, "ip"),
  name: str(row, "name"),
  uid: str(row, "uid"),
  lastNickname: str(row, "lastnickname"),
  created: num(row, "created"),
  duration: num(row, "duration"),
  invokerDatabaseID: big(row, "invokercldbid") as ClientDBID,
  invokerName: str(row, "invokername"),
  invokerUID: str(row, "invokeruid"),
  reason: str(row, "reason"),
});

/** Every active ban. */
export async function listBans(client: Client): Promise<BanEntry[]> {
  return (await query(client, "banlist")).map(parseBan);
}

/**
 * Add a ban. At least one of `ip`, `name` or `uid` must be given, otherwise the
 * server rejects the call.
 */
export async function addBan(
  client: Client,
  options: {
    ip?: string;
    name?: string;
    uid?: string;
    /** Seconds; 0 means permanent. */
    duration?: number;
    reason?: string;
  },
): Promise<bigint> {
  const rows = await query(client, "banadd", [
    ["ip", options.ip],
    ["name", options.name],
    ["uid", options.uid],
    ["time", options.duration],
    ["banreason", options.reason],
  ]);
  return big(rows[0] ?? {}, "banid");
}

/** Ban a connected client by clid. */
export async function banClient(
  client: Client,
  clid: ClientID,
  options: { duration?: number; reason?: string } = {},
): Promise<bigint> {
  const rows = await query(client, "banclient", [
    ["clid", clid],
    ["time", options.duration],
    ["banreason", options.reason],
  ]);
  return big(rows[0] ?? {}, "banid");
}

export async function deleteBan(client: Client, banID: bigint): Promise<void> {
  await exec(client, "bandel", [["banid", banID]]);
}

export async function deleteAllBans(client: Client): Promise<void> {
  await exec(client, "bandelall");
}

// ---- Complaints -------------------------------------------------------------

/** A complaint one client filed against another. */
export interface Complaint {
  targetDatabaseID: ClientDBID;
  targetName: string;
  fromDatabaseID: ClientDBID;
  fromName: string;
  message: string;
  timestamp: number;
}

const parseComplaint = (row: Record<string, string>): Complaint => ({
  targetDatabaseID: big(row, "tcldbid") as ClientDBID,
  targetName: str(row, "tname"),
  fromDatabaseID: big(row, "fcldbid") as ClientDBID,
  fromName: str(row, "fname"),
  message: str(row, "message"),
  timestamp: num(row, "timestamp"),
});

/** Complaints, optionally only those against one client. */
export async function listComplaints(
  client: Client,
  targetDatabaseID?: ClientDBID,
): Promise<Complaint[]> {
  return (await query(client, "complainlist", [["tcldbid", targetDatabaseID]])).map(parseComplaint);
}

export async function addComplaint(
  client: Client,
  targetDatabaseID: ClientDBID,
  message: string,
): Promise<void> {
  await exec(client, "complainadd", [
    ["tcldbid", targetDatabaseID],
    ["message", message],
  ]);
}

/** Withdraw a complaint this client filed. */
export async function deleteComplaint(
  client: Client,
  targetDatabaseID: ClientDBID,
  fromDatabaseID: ClientDBID,
): Promise<void> {
  await exec(client, "complaindel", [
    ["tcldbid", targetDatabaseID],
    ["fcldbid", fromDatabaseID],
  ]);
}

/** Withdraw every complaint against a client. */
export async function deleteAllComplaints(
  client: Client,
  targetDatabaseID: ClientDBID,
): Promise<void> {
  await exec(client, "complaindelall", [["tcldbid", targetDatabaseID]]);
}

// ---- Offline messages -------------------------------------------------------

/** An offline message left for a client. */
export interface OfflineMessage {
  id: bigint;
  uid: string;
  subject: string;
  message: string;
  timestamp: number;
  isRead: boolean;
}

const parseMessage = (row: Record<string, string>): OfflineMessage => ({
  id: big(row, "msgid"),
  uid: str(row, "cluid"),
  subject: str(row, "subject"),
  message: str(row, "message"),
  timestamp: num(row, "timestamp"),
  isRead: bool(row, "flag_read"),
});

/** Offline messages for this client. */
export async function listMessages(client: Client): Promise<OfflineMessage[]> {
  return (await query(client, "messagelist")).map(parseMessage);
}

export async function getMessage(client: Client, messageID: bigint): Promise<OfflineMessage> {
  return parseMessage((await query(client, "messageget", [["msgid", messageID]]))[0] ?? {});
}

export async function deleteMessage(client: Client, messageID: bigint): Promise<void> {
  await exec(client, "messagedel", [["msgid", messageID]]);
}

/** Mark a message read or unread. */
export async function updateMessageFlag(
  client: Client,
  messageID: bigint,
  read: boolean,
): Promise<void> {
  await exec(client, "messageupdateflag", [
    ["msgid", messageID],
    ["flag", read],
  ]);
}

// ---- Text messages ----------------------------------------------------------

/** Where `sendTextMessage` delivers. */
export const TextMessageTarget = {
  /** A private message to one client; `target` is their clid. */
  Client: 1,
  /** A message in one channel; `target` is the cid. */
  Channel: 2,
  /** A message to everyone on the server. */
  Server: 3,
} as const;

/**
 * Send a text message.
 *
 * The target is a clid, cid or nothing depending on `targetMode`, which is why
 * the two are separate parameters here rather than one polymorphic id: passing a
 * channel id to a client-mode message reaches an unrelated client.
 */
export async function sendTextMessage(
  client: Client,
  targetMode: number,
  message: string,
  target?: ClientID | ChannelID,
): Promise<void> {
  await exec(client, "sendtextmessage", [
    ["targetmode", targetMode],
    ["msg", message],
    ["target", target],
  ]);
}

// ---- Log --------------------------------------------------------------------

/** One line of the server log. */
export interface LogEntry {
  /** The server's line number, for paging with `beginPosition`. */
  lastPosition: number;
  fileSize: bigint;
  lines: string[];
}

/** Read the server log. */
export async function viewLog(
  client: Client,
  options: { lines?: number; reverse?: boolean; instance?: boolean; beginPosition?: bigint } = {},
): Promise<LogEntry> {
  const rows = await query(client, "logview", [
    ["lines", options.lines],
    ["reverse", options.reverse],
    ["instance", options.instance],
    ["begin_pos", options.beginPosition],
  ]);
  const row = rows[0] ?? {};
  return {
    lastPosition: num(row, "last_pos"),
    fileSize: big(row, "file_size"),
    lines: str(row, "log") === "" ? [] : str(row, "log").split("\n"),
  };
}

/**
 * Write an entry to the server log.
 *
 * `level` follows the server's own levels: 1 error, 2 warning, 3 debug,
 * 4 info.
 */
export async function addLog(client: Client, level: number, message: string): Promise<void> {
  await exec(client, "logadd", [
    ["loglevel", level],
    ["logmsg", message],
  ]);
}

/** Accepted levels for {@link addLog}, matching the server's log. */
export const LogLevel = {
  Error: 1,
  Warning: 2,
  Debug: 3,
  Info: 4,
} as const;
