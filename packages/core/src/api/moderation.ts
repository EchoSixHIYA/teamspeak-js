/**
 * Bans, complaints, offline messages, text messages and the server log.
 *
 * All administrative: expect a permission error, not an empty list, when the
 * client lacks the rights.
 */

import {
  firstRow,
  exec,
  query,
  list,
  encodeFields,
  nonEmpty,
  toWireDuration,
  str,
  big,
  num,
  bool,
  date,
  durationMs,
  SECOND,
} from "./command.js";
import type { Params, WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions, ParamValue } from "../command/request.js";
import type { BanID, ClientDBID, ClientID, MessageID, UID } from "../command/ids.js";
import { asBanID, asClientDBID, asMessageID, asUID } from "../command/ids.js";
import { TextMessageTarget } from "../enums.js";
import type { LogLevel } from "../enums.js";

// ---- Bans -------------------------------------------------------------------

/** A ban, as `banlist` reports it. */
export interface BanEntry {
  /** The ban's id. */
  readonly id: BanID;
  /** The address pattern the ban matches, or "". */
  readonly ip: string;
  /** The nickname pattern the ban matches, or "". */
  readonly name: string;
  /** The unique identifier the ban matches, or "". */
  readonly uid: UID;
  /** The nickname of the last client the ban caught. */
  readonly lastNickname: string;
  /** When the ban was made. */
  readonly createdAt: Date | undefined;
  /**
   * How long the ban lasts from `createdAt`, in milliseconds; 0 is a
   * permanent ban. The server reports it in seconds.
   */
  readonly durationMs: number;
  /** Who made the ban. */
  readonly invokerDatabaseID: ClientDBID;
  /** Their nickname. */
  readonly invokerName: string;
  /** Their unique identifier. */
  readonly invokerUID: UID;
  /** The reason given. */
  readonly reason: string;
  /** How many times the ban has turned a client away. */
  readonly enforcements: number;
}

const parseBan = (row: Record<string, string>): BanEntry => ({
  id: asBanID(big(row, "banid")),
  ip: str(row, "ip"),
  name: str(row, "name"),
  uid: asUID(str(row, "uid")),
  lastNickname: str(row, "lastnickname"),
  createdAt: date(row, "created"),
  durationMs: durationMs(row, "duration", SECOND),
  invokerDatabaseID: asClientDBID(big(row, "invokercldbid")),
  invokerName: str(row, "invokername"),
  invokerUID: asUID(str(row, "invokeruid")),
  reason: str(row, "reason"),
  enforcements: num(row, "enforcements"),
});

/** Every active ban. A server with none answers an empty list. */
export async function listBans(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<BanEntry[]> {
  return (await list(client, "banlist", [], options)).map(parseBan);
}

/**
 * A ban's duration on the wire. A permanent ban (0) omits it: the server's
 * default is permanent, which is also what `time=0` means. A positive duration
 * never rounds down to 0, which would make it permanent.
 */
const banTime = (ms: number): ParamValue => (ms === 0 ? undefined : toWireDuration(ms, SECOND));

/**
 * How long a ban lasts and why. Unset fields are omitted; so is an empty
 * `reason`.
 */
export interface BanClientOptions extends CommandOptions {
  /**
   * How long the ban lasts, in milliseconds (`time`); unset or 0 is permanent.
   * Sent in whole seconds, and a positive duration under a second is sent as
   * one rather than rounded down to forever.
   */
  readonly durationMs?: number | undefined;
  /** The reason, shown to the banned client (`banreason`). */
  readonly reason?: string | undefined;
}

const banClientNames: WireNames<BanClientOptions> = {
  durationMs: ["time", banTime],
  reason: ["banreason", nonEmpty],
};

/**
 * A ban to add. `ip` and `name` are regular expressions matched against a
 * client's address and nickname. At least one of `ip`, `name` or `uid` must be
 * set; a ban matching nothing is refused before anything is sent.
 *
 * An empty string is treated as unset in every field here, never sent: an
 * empty pattern would match every client.
 */
export interface BanOptions extends BanClientOptions {
  /** The address pattern to ban (`ip`). */
  readonly ip?: string | undefined;
  /** The nickname pattern to ban (`name`). */
  readonly name?: string | undefined;
  /** The unique identifier to ban (`uid`). */
  readonly uid?: UID | undefined;
}

const banNames: WireNames<BanOptions> = {
  ip: ["ip", nonEmpty],
  name: ["name", nonEmpty],
  uid: ["uid", nonEmpty],
  ...banClientNames,
};

/**
 * Add a ban and return its id — over ServerQuery. The voice protocol reports
 * no id, so there this resolves to undefined.
 */
export async function addBan(
  client: CommandExecutor,
  ban: BanOptions,
  options?: CommandOptions,
): Promise<BanID | undefined> {
  if (!ban.ip && !ban.name && !ban.uid) {
    throw new TypeError("a ban needs an ip, a name or a uid to match");
  }
  const rows = await query(client, "banadd", encodeFields(ban, banNames), options);
  return rows[0]?.["banid"] === undefined ? undefined : asBanID(big(rows[0], "banid"));
}

/**
 * Ban a connected client by clid, and return the id of every ban that made.
 *
 * The server bans the client on several counts at once — its address, its
 * uid, and on TS6 its myTeamSpeak id — and over ServerQuery answers one
 * `banid` row for each; returning the first left the others to be found by
 * hand. The voice protocol reports no ids, so there this resolves to `[]`.
 */
export async function banClient(
  client: CommandExecutor,
  clid: ClientID,
  options: BanClientOptions = {},
): Promise<BanID[]> {
  const rows = await query(
    client,
    "banclient",
    [["clid", clid], ...encodeFields(options, banClientNames)],
    options,
  );
  return rows.flatMap((row) => (str(row, "banid") === "" ? [] : [asBanID(big(row, "banid"))]));
}

/** Remove a ban. */
export async function deleteBan(
  client: CommandExecutor,
  banID: BanID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "bandel", [["banid", banID]], options);
}

/** Remove every ban. */
export async function deleteAllBans(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "bandelall", [], options);
}

// ---- Complaints -------------------------------------------------------------

/** A complaint one client filed against another. */
export interface Complaint {
  /** Who the complaint is about. */
  readonly targetDatabaseID: ClientDBID;
  /** Their nickname. */
  readonly targetName: string;
  /** Who filed it. */
  readonly fromDatabaseID: ClientDBID;
  /** Their nickname. */
  readonly fromName: string;
  /** The complaint. */
  readonly message: string;
  /** When it was filed. */
  readonly createdAt: Date | undefined;
}

const parseComplaint = (row: Record<string, string>): Complaint => ({
  targetDatabaseID: asClientDBID(big(row, "tcldbid")),
  targetName: str(row, "tname"),
  fromDatabaseID: asClientDBID(big(row, "fcldbid")),
  fromName: str(row, "fname"),
  message: str(row, "message"),
  createdAt: date(row, "timestamp"),
});

/** Which complaints {@link listComplaints} reports. */
export interface ComplaintListOptions extends CommandOptions {
  /** Only those against this client; unset for all (`tcldbid`). */
  readonly targetDatabaseID?: ClientDBID | undefined;
}

/** Complaints, optionally only those against one client. */
export async function listComplaints(
  client: CommandExecutor,
  options: ComplaintListOptions = {},
): Promise<Complaint[]> {
  const params: Params = [["tcldbid", options.targetDatabaseID]];
  return (await list(client, "complainlist", params, options)).map(parseComplaint);
}

/** File a complaint against a client. */
export async function addComplaint(
  client: CommandExecutor,
  targetDatabaseID: ClientDBID,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "complainadd",
    [
      ["tcldbid", targetDatabaseID],
      ["message", message],
    ],
    options,
  );
}

/** Withdraw one complaint. */
export async function deleteComplaint(
  client: CommandExecutor,
  targetDatabaseID: ClientDBID,
  fromDatabaseID: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "complaindel",
    [
      ["tcldbid", targetDatabaseID],
      ["fcldbid", fromDatabaseID],
    ],
    options,
  );
}

/** Withdraw every complaint against a client. */
export async function deleteAllComplaints(
  client: CommandExecutor,
  targetDatabaseID: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "complaindelall", [["tcldbid", targetDatabaseID]], options);
}

// ---- Offline messages -------------------------------------------------------

/** A message left for a client while they were away. */
export interface OfflineMessage {
  /** The message's id. */
  readonly id: MessageID;
  /** The sender's unique identifier. */
  readonly uid: UID;
  /** The subject. */
  readonly subject: string;
  /** The message; `messagelist` leaves it out, `getMessage` has it. */
  readonly message: string;
  /** When it was sent. */
  readonly sentAt: Date | undefined;
  /** Whether it has been read. */
  readonly isRead: boolean;
}

const parseMessage = (row: Record<string, string>): OfflineMessage => ({
  id: asMessageID(big(row, "msgid")),
  uid: asUID(str(row, "cluid")),
  subject: str(row, "subject"),
  message: str(row, "message"),
  sentAt: date(row, "timestamp"),
  isRead: bool(row, "flag_read"),
});

/** Offline messages for this client. None is an empty list. */
export async function listMessages(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<OfflineMessage[]> {
  return (await list(client, "messagelist", [], options)).map(parseMessage);
}

/** One offline message, with its text. */
export async function getMessage(
  client: CommandExecutor,
  messageID: MessageID,
  options?: CommandOptions,
): Promise<OfflineMessage> {
  const rows = await query(client, "messageget", [["msgid", messageID]], options);
  return { ...parseMessage(firstRow(rows, "messageget")), id: messageID };
}

/** Delete an offline message. */
export async function deleteMessage(
  client: CommandExecutor,
  messageID: MessageID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "messagedel", [["msgid", messageID]], options);
}

/** Mark a message read or unread. */
export async function updateMessageFlag(
  client: CommandExecutor,
  messageID: MessageID,
  read: boolean,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "messageupdateflag",
    [
      ["msgid", messageID],
      ["flag", read],
    ],
    options,
  );
}

// ---- Text messages ----------------------------------------------------------
//
// Three functions rather than one taking a mode and an id, because the id meant
// a different thing in each mode — a clid, a cid, or nothing — and an untyped
// one let a channel id reach an unrelated client.
//
// Each waits for the server's answer, so a refusal — no permission to message
// that target — is thrown rather than lost.

/** Send a text message to one client. */
export async function sendPrivateMessage(
  client: CommandExecutor,
  clid: ClientID,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "sendtextmessage",
    [
      ["targetmode", TextMessageTarget.Client],
      ["target", clid],
      ["msg", message],
    ],
    options,
  );
}

/**
 * Send a text message to the channel this connection is in.
 *
 * It takes no channel because the server takes none: measured on TS3 and TS6,
 * a channel message naming another channel still arrives in the sender's own.
 * To write to another channel, move there first.
 */
export async function sendChannelMessage(
  client: CommandExecutor,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "sendtextmessage",
    [
      ["targetmode", TextMessageTarget.Channel],
      ["msg", message],
    ],
    options,
  );
}

/** Send a text message to everyone on the virtual server. */
export async function sendServerMessage(
  client: CommandExecutor,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "sendtextmessage",
    [
      ["targetmode", TextMessageTarget.Server],
      ["msg", message],
    ],
    options,
  );
}

// ---- Log --------------------------------------------------------------------

/** One read of the server log. */
export interface LogPage {
  /** The lines read, in the order the server sent them. */
  readonly lines: readonly string[];
  /**
   * The byte offset the read stopped at. Pass it as the next read's
   * `beginPosition` to continue from there.
   */
  readonly lastPosition: number;
  /** The log file's size in bytes. */
  readonly fileSize: number;
}

/**
 * Which part of the log {@link viewLog} reads. Unset fields are omitted, and
 * left to the server.
 *
 * The log is paged by byte offset rather than by row, and nothing says when
 * the walk is done, so there is no iterator as there is for the client
 * database: read a page, then pass its `lastPosition` as the next read's
 * `beginPosition`.
 */
export interface LogViewOptions extends CommandOptions {
  /** How many lines to read, at most 100 (`lines`). */
  readonly lines?: number | undefined;
  /** Read backwards from `beginPosition`, newest line first (`reverse`). */
  readonly reverse?: boolean | undefined;
  /** Read the instance log rather than the virtual server's (`instance`). */
  readonly instance?: boolean | undefined;
  /** The byte offset to read from (`begin_pos`). */
  readonly beginPosition?: number | undefined;
}

const logViewNames: WireNames<LogViewOptions> = {
  lines: "lines",
  reverse: "reverse",
  instance: "instance",
  beginPosition: "begin_pos",
};

/** Read a page of the server log. */
export async function viewLog(
  client: CommandExecutor,
  options: LogViewOptions = {},
): Promise<LogPage> {
  const rows = await query(client, "logview", encodeFields(options, logViewNames), options);
  const first = firstRow(rows, "logview");
  // One line per row, under the key `l`. This used to read only a `log` field
  // from the first row, which the server does not send; it is still read,
  // should a server send the lines that way.
  const lines = rows.flatMap((row) => (row["l"] === undefined ? [] : [row["l"]]));
  const joined = str(first, "log");
  return {
    lines: lines.length === 0 && joined !== "" ? joined.split("\n") : lines,
    lastPosition: num(first, "last_pos"),
    fileSize: num(first, "file_size"),
  };
}

/** Write an entry to the server log. */
export async function addLog(
  client: CommandExecutor,
  level: LogLevel,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "logadd",
    [
      ["loglevel", level],
      ["logmsg", message],
    ],
    options,
  );
}
