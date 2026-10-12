/**
 * File transfer commands.
 *
 * These are the control-plane half: they list, move and delete files, and they
 * negotiate an upload or download. The actual bytes travel over a separate TCP
 * connection to the file transfer port, which `transfer.ts` handles.
 *
 * Every command here takes a channel password, in cleartext: the voice client
 * sends it as `base64(sha1(password))`, the same encoding `clientmove` uses,
 * and ServerQuery as it is. Passing `""` is correct and common for a channel
 * with no password.
 */

import {
  exec,
  query,
  list,
  encodeFields,
  str,
  big,
  num,
  date,
  durationMs,
  SECOND,
} from "./command.js";
import type { WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type { ChannelID, ClientID } from "../command/ids.js";
import { asClientID } from "../command/ids.js";
import type { FileDownloadInfo, FileUploadInfo } from "../types.js";

const asPath = (path: string): string => (path.startsWith("/") ? path : `/${path}`);

/** One entry of a directory listing, or one file's details. */
export interface FileEntry {
  /** The file or directory name. */
  readonly name: string;
  /** The size in bytes; 0 for a directory. */
  readonly size: bigint;
  /**
   * When it was last modified. TS3 sends seconds, TS6 milliseconds in a
   * listing and nanoseconds in `getFileInfo`; all are read as the same time.
   */
  readonly modifiedAt: Date | undefined;
  /**
   * Whether this is a directory. The listing sends `type=0` for a directory
   * and `type=1` for a file; `getFileInfo`'s answer carries no type, so there
   * it is always false.
   */
  readonly isDirectory: boolean;
}

const parseFileEntry = (row: Record<string, string>): FileEntry => ({
  name: str(row, "name"),
  size: big(row, "size"),
  modifiedAt: date(row, "datetime"),
  isDirectory: row["type"] === "0",
});

/** Directory listing for one path in a channel's file area. */
export async function listFiles(
  client: CommandExecutor,
  cid: ChannelID,
  path = "/",
  password = "",
  options?: CommandOptions,
): Promise<FileEntry[]> {
  const rows = await query(
    client,
    "ftgetfilelist",
    [
      ["cid", cid],
      ["path", asPath(path)],
      ["cpw", password],
    ],
    options,
    ["cpw"],
  );
  return rows.map(parseFileEntry);
}

/** Size and timestamp of one file. */
export async function getFileInfo(
  client: CommandExecutor,
  cid: ChannelID,
  path: string,
  password = "",
  options?: CommandOptions,
): Promise<FileEntry> {
  const rows = await query(
    client,
    "ftgetfileinfo",
    [
      ["cid", cid],
      ["name", asPath(path)],
      ["cpw", password],
    ],
    options,
    ["cpw"],
  );
  return parseFileEntry(rows[0] ?? {});
}

/**
 * Delete one or more files.
 *
 * The names travel as a `|`-separated list in a single parameter, which is why
 * this takes an array rather than being called once per file.
 */
export async function deleteFile(
  client: CommandExecutor,
  cid: ChannelID,
  paths: string | readonly string[],
  password = "",
  options?: CommandOptions,
): Promise<void> {
  const names = (typeof paths === "string" ? [paths] : paths).map(asPath);
  if (names.length === 0) return;

  await exec(
    client,
    "ftdeletefile",
    [
      ["cid", cid],
      ["name", names.join("|")],
      ["cpw", password],
    ],
    options,
    ["cpw"],
  );
}

/** Create a directory, including any missing parents. */
export async function createDirectory(
  client: CommandExecutor,
  cid: ChannelID,
  dirname: string,
  password = "",
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "ftcreatedir",
    [
      ["cid", cid],
      ["dirname", asPath(dirname)],
      ["cpw", password],
    ],
    options,
    ["cpw"],
  );
}

/** Where {@link renameFile} moves a file, and the passwords it needs. Unset fields are omitted. */
export interface FileRenameOptions {
  /** The source channel's password, in cleartext (`cpw`). */
  readonly password?: string | undefined;
  /** Move the file into this channel's file area; unset keeps it in the same channel (`tcid`). */
  readonly targetChannelID?: ChannelID | undefined;
  /** The target channel's password, in cleartext (`tcpw`). */
  readonly targetChannelPassword?: string | undefined;
}

const renameNames: WireNames<FileRenameOptions> = {
  password: "cpw",
  targetChannelID: "tcid",
  targetChannelPassword: "tcpw",
};

/** Rename or move a file, optionally into another channel. */
export async function renameFile(
  client: CommandExecutor,
  cid: ChannelID,
  oldName: string,
  newName: string,
  rename: FileRenameOptions = {},
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "ftrenamefile",
    [
      ["cid", cid],
      ["oldname", asPath(oldName)],
      ["newname", asPath(newName)],
      ...encodeFields(rename, renameNames),
    ],
    options,
    ["cpw", "tcpw"],
  );
}

/**
 * Cancel a running transfer.
 *
 * `removePartialFile` removes the partial file as well, which is usually what
 * you want after a failed upload.
 */
export async function stopFileTransfer(
  client: CommandExecutor,
  serverFileTransferID: number,
  removePartialFile: boolean,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "ftstop",
    [
      ["serverftfid", serverFileTransferID],
      ["delete", removePartialFile],
    ],
    options,
  );
}

/** A running transfer, as `ftlist` reports it. */
export interface ActiveTransfer {
  /** The client transferring. */
  readonly clientID: ClientID;
  /** The directory in the channel's file area. */
  readonly path: string;
  /** The file name. */
  readonly name: string;
  /** The file's size in bytes. */
  readonly size: bigint;
  /** How many bytes have been transferred. */
  readonly sizeDone: bigint;
  /** The client's id for the transfer. */
  readonly clientFileTransferID: number;
  /** The server's id for the transfer, which {@link stopFileTransfer} takes. */
  readonly serverFileTransferID: number;
  /** Which side sends the data, as the server reports it (`sender`). */
  readonly sender: string;
  /** The transfer's state. */
  readonly status: number;
  /** The current speed, in bytes per second. */
  readonly currentSpeed: number;
  /** The average speed, in bytes per second. */
  readonly averageSpeed: number;
  /** How long the transfer has been running, in milliseconds. The server reports seconds. */
  readonly runtimeMs: number;
}

/**
 * File transfers in progress. Requires the file-transfer-info permission. None
 * is an empty list.
 */
export async function listActiveTransfers(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<ActiveTransfer[]> {
  const rows = await list(client, "ftlist", [], options);
  return rows.map((row) => ({
    clientID: asClientID(num(row, "clid")),
    path: str(row, "path"),
    name: str(row, "name"),
    size: big(row, "size"),
    sizeDone: big(row, "sizedone"),
    clientFileTransferID: num(row, "clientftfid"),
    serverFileTransferID: num(row, "serverftfid"),
    sender: str(row, "sender"),
    status: num(row, "status"),
    currentSpeed: num(row, "current_speed"),
    averageSpeed: num(row, "average_speed"),
    runtimeMs: durationMs(row, "runtime", SECOND),
  }));
}

/**
 * The `clientftfid` for the next negotiation.
 *
 * The server echoes it in the answer, and the echo is the only thing tying the
 * answer to the request — it arrives after the command has already returned —
 * so two transfers negotiated at once must not share one.
 */
let lastClientFileTransferID = 0;
function nextClientFileTransferID(): number {
  lastClientFileTransferID = (lastClientFileTransferID % 65535) + 1;
  return lastClientFileTransferID;
}

/** How {@link initFileUpload} negotiates an upload. */
export interface FileUploadOptions {
  /** The channel's password, in cleartext; "" by default (`cpw`). */
  readonly password?: string | undefined;
  /** Replace an existing file; true by default (`overwrite`). */
  readonly overwrite?: boolean | undefined;
  /** Continue a partial upload; false by default (`resume`). */
  readonly resume?: boolean | undefined;
}

/**
 * Negotiate an upload, returning the key and port to dial over TCP.
 *
 * Pass the result to the client's `uploadFileData` to send the data; it does
 * not go through this command. A refusal — no permission to upload, say — is
 * thrown as a ServerError, even though the voice protocol reports it in a
 * separate notification after the command itself has succeeded.
 */
export async function initFileUpload(
  client: CommandExecutor,
  cid: ChannelID,
  path: string,
  size: bigint,
  upload: FileUploadOptions = {},
  options?: CommandOptions,
): Promise<FileUploadInfo> {
  const rows = await query(
    client,
    "ftinitupload",
    [
      ["clientftfid", nextClientFileTransferID()],
      ["name", asPath(path)],
      ["cid", cid],
      ["cpw", upload.password ?? ""],
      ["size", size],
      ["overwrite", upload.overwrite ?? true],
      ["resume", upload.resume ?? false],
      // proto is required: omitting it fails the whole call with 1539
      // (parameter not found) rather than defaulting.
      ["proto", 0],
    ],
    options,
    ["cpw"],
  );
  const row = rows[0] ?? {};
  return {
    fileTransferKey: str(row, "ftkey"),
    port: num(row, "port"),
    seekPosition: big(row, "seekpos"),
    clientFileTransferID: num(row, "clientftfid"),
    serverFileTransferID: num(row, "serverftfid"),
  };
}

/** How {@link initFileDownload} negotiates a download. */
export interface FileDownloadOptions {
  /** The channel's password, in cleartext; "" by default (`cpw`). */
  readonly password?: string | undefined;
  /** The byte offset to start from, to resume; 0 by default (`seekpos`). */
  readonly seekPosition?: bigint | undefined;
}

/**
 * Negotiate a download, returning the key, port and size to dial over TCP.
 *
 * Pass the result to the client's `downloadFileData`. Refusals are thrown as
 * for {@link initFileUpload}.
 */
export async function initFileDownload(
  client: CommandExecutor,
  cid: ChannelID,
  path: string,
  download: FileDownloadOptions = {},
  options?: CommandOptions,
): Promise<FileDownloadInfo> {
  const rows = await query(
    client,
    "ftinitdownload",
    [
      ["clientftfid", nextClientFileTransferID()],
      ["name", asPath(path)],
      ["cid", cid],
      ["cpw", download.password ?? ""],
      ["seekpos", download.seekPosition ?? 0n],
      ["proto", 0],
    ],
    options,
    ["cpw"],
  );
  const row = rows[0] ?? {};
  return {
    fileTransferKey: str(row, "ftkey"),
    port: num(row, "port"),
    size: big(row, "size"),
    clientFileTransferID: num(row, "clientftfid"),
    serverFileTransferID: num(row, "serverftfid"),
  };
}
