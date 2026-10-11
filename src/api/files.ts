/**
 * File transfer commands.
 *
 * These are the control-plane half: they list, move and delete files, and they
 * negotiate an upload or download. The actual bytes travel over a separate TCP
 * connection to the file transfer port, which `transfer.ts` handles.
 *
 * Every command here takes a channel password, and the server expects it as
 * `base64(sha1(password))` rather than cleartext — the same encoding `clientmove`
 * uses. Passing `""` is correct and common for a channel with no password.
 */

import { exec, query, str, big, num } from "./command.js";
import type { Client } from "../client.js";
import type { ChannelID } from "../command/ids.js";

const asPath = (path: string): string => (path.startsWith("/") ? path : `/${path}`);

/** One entry of a directory listing. */
export interface FileEntry {
  name: string;
  size: bigint;
  /** Seconds since the epoch. */
  modifiedAt: number;
  /** 0 = file, 1 = directory. */
  type: number;
}

const parseFileEntry = (row: Record<string, string>): FileEntry => ({
  name: str(row, "name"),
  size: big(row, "size"),
  modifiedAt: num(row, "datetime"),
  type: num(row, "type"),
});

/** Directory listing for one path in a channel's file area. */
export async function listFiles(
  client: Client,
  cid: ChannelID,
  path = "/",
  password = "",
): Promise<FileEntry[]> {
  const rows = await query(
    client,
    "ftgetfilelist",
    [
      ["cid", cid],
      ["path", asPath(path)],
      ["cpw", password],
    ],
    ["cpw"],
  );
  return rows.map(parseFileEntry);
}

/** Size and timestamp of one file. */
export async function getFileInfo(
  client: Client,
  cid: ChannelID,
  path: string,
  password = "",
): Promise<FileEntry> {
  const rows = await query(
    client,
    "ftgetfileinfo",
    [
      ["cid", cid],
      ["name", asPath(path)],
      ["cpw", password],
    ],
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
  client: Client,
  cid: ChannelID,
  paths: string | string[],
  password = "",
): Promise<void> {
  const names = (Array.isArray(paths) ? paths : [paths]).map(asPath);
  if (names.length === 0) return;

  await exec(
    client,
    "ftdeletefile",
    [
      ["cid", cid],
      ["name", names.join("|")],
      ["cpw", password],
    ],
    ["cpw"],
  );
}

/** Create a directory, including any missing parents. */
export async function createDirectory(
  client: Client,
  cid: ChannelID,
  dirname: string,
  password = "",
): Promise<void> {
  await exec(
    client,
    "ftcreatedir",
    [
      ["cid", cid],
      ["dirname", asPath(dirname)],
      ["cpw", password],
    ],
    ["cpw"],
  );
}

/** Rename or move a file, optionally into another channel. */
export async function renameFile(
  client: Client,
  cid: ChannelID,
  oldName: string,
  newName: string,
  options: { targetChannelID?: ChannelID; targetChannelPassword?: string; password?: string } = {},
): Promise<void> {
  await exec(
    client,
    "ftrenamefile",
    [
      ["cid", cid],
      ["oldname", asPath(oldName)],
      ["newname", asPath(newName)],
      ["cpw", options.password],
      ["tcid", options.targetChannelID],
      ["tcpw", options.targetChannelPassword],
    ],
    ["cpw", "tcpw"],
  );
}

/**
 * Cancel a running transfer.
 *
 * `delete` removes the partial file as well, which is usually what you want
 * after a failed upload.
 */
export async function stopFileTransfer(
  client: Client,
  serverFileTransferID: number,
  removePartialFile: boolean,
): Promise<void> {
  await exec(client, "ftstop", [
    ["serverftfid", serverFileTransferID],
    ["delete", removePartialFile],
  ]);
}

/** A running transfer, as `ftlist` reports it. */
export interface ActiveTransfer {
  clientID: number;
  path: string;
  name: string;
  size: bigint;
  sizeDone: bigint;
  clientFileTransferID: number;
  serverFileTransferID: number;
  sender: string;
  status: number;
  currentSpeed: number;
  averageSpeed: number;
  runtime: number;
}

/** File transfers in progress. Requires the file-transfer-info permission. */
export async function listActiveTransfers(client: Client): Promise<ActiveTransfer[]> {
  const rows = await query(client, "ftlist");
  return rows.map((row) => ({
    clientID: num(row, "clid"),
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
    runtime: num(row, "runtime"),
  }));
}

/**
 * Negotiate an upload.
 *
 * Returns the transfer key and port the caller then dials over TCP; the data
 * itself does not go through this client. `seekPosition` is deliberately absent
 * — see `uploadFileData` in transfer.ts, which always starts at 0 and so does
 * not need the server's resume support.
 */
export async function initFileUpload(
  client: Client,
  cid: ChannelID,
  path: string,
  size: bigint,
  options: { password?: string; overwrite?: boolean; clientFileTransferID?: number } = {},
): Promise<{
  fileTransferKey: string;
  port: number;
  clientFileTransferID: number;
  serverFileTransferID: number;
}> {
  const rows = await query(
    client,
    "ftinitupload",
    [
      ["cid", cid],
      ["name", asPath(path)],
      ["size", size],
      ["overwrite", options.overwrite ?? true],
      ["resume", false],
      ["clientftfid", options.clientFileTransferID ?? 0],
      ["cpw", options.password],
    ],
    ["cpw"],
  );
  const row = rows[0] ?? {};
  return {
    fileTransferKey: str(row, "ftkey"),
    port: num(row, "port"),
    clientFileTransferID: num(row, "clientftfid"),
    serverFileTransferID: num(row, "serverftfid"),
  };
}

/** Negotiate a download, returning the key and port to dial over TCP. */
export async function initFileDownload(
  client: Client,
  cid: ChannelID,
  path: string,
  options: { password?: string; seekPosition?: bigint; clientFileTransferID?: number } = {},
): Promise<{
  fileTransferKey: string;
  port: number;
  size: bigint;
  clientFileTransferID: number;
  serverFileTransferID: number;
}> {
  const rows = await query(
    client,
    "ftinitdownload",
    [
      ["cid", cid],
      ["name", asPath(path)],
      ["seekpos", options.seekPosition ?? 0n],
      ["clientftfid", options.clientFileTransferID ?? 0],
      ["cpw", options.password],
    ],
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
