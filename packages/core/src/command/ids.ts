/**
 * Branded identifiers.
 *
 * TeamSpeak uses one 64-bit integer space for several unrelated kinds of id, so
 * a `bigint` alone cannot tell a channel from a client. Branding makes the
 * mistake a compile error instead of a silent move-to-the-wrong-place, and the
 * brands cost nothing at runtime.
 *
 * The ids the protocol defines as 32 bits or narrower — a clid, a permission,
 * an icon — are `number` brands; the 64-bit ones are `bigint` brands.
 */

/** A channel (`cid`). */
export type ChannelID = bigint & { readonly __brand: "ChannelID" };
/**
 * A connected client (`clid`): an id for this connection only, assigned anew
 * every time the client connects.
 */
export type ClientID = number & { readonly __brand: "ClientID" };
/**
 * A client's database record (`cldbid`): stable across connections, unlike its
 * ClientID.
 */
export type ClientDBID = bigint & { readonly __brand: "ClientDBID" };
/** A server group (`sgid`). */
export type ServerGroupID = bigint & { readonly __brand: "ServerGroupID" };
/** A channel group (`cgid`). */
export type ChannelGroupID = bigint & { readonly __brand: "ChannelGroupID" };
/** A permission's numeric id (`permid`), a 32-bit value assigned by the server build. */
export type PermissionID = number & { readonly __brand: "PermissionID" };
/**
 * An icon: the unsigned CRC32 of the icon file, which also names the file
 * (`/icon_<id>`) in the server's file area.
 */
export type IconID = number & { readonly __brand: "IconID" };

/** A ban (`banid`). */
export type BanID = bigint & { readonly __brand: "BanID" };
/** An offline message (`msgid`). */
export type MessageID = bigint & { readonly __brand: "MessageID" };
/** A virtual server on an instance (`sid`, `virtualserver_id`). */
export type ServerID = bigint & { readonly __brand: "ServerID" };
/** The client's id for a file transfer (`clientftfid`), a 16-bit value it chooses. */
export type ClientFileTransferID = number & { readonly __brand: "ClientFileTransferID" };
/** The server's id for a file transfer (`serverftfid`), a 16-bit value. */
export type ServerFileTransferID = number & { readonly __brand: "ServerFileTransferID" };

/** Brand a ban id, from a number or a bigint. */
export const asBanID = (v: bigint | number): BanID => BigInt(v) as BanID;
/** Brand an offline message id, from a number or a bigint. */
export const asMessageID = (v: bigint | number): MessageID => BigInt(v) as MessageID;
/** Brand a virtual server id, from a number or a bigint. */
export const asServerID = (v: bigint | number): ServerID => BigInt(v) as ServerID;
/** Brand the client's id for a file transfer. */
export const asClientFileTransferID = (v: number): ClientFileTransferID =>
  v as ClientFileTransferID;
/** Brand the server's id for a file transfer. */
export const asServerFileTransferID = (v: number): ServerFileTransferID =>
  v as ServerFileTransferID;

/** Brand a channel id, from a number or a bigint. */
export const asChannelID = (v: bigint | number): ChannelID => BigInt(v) as ChannelID;
/** Brand a client id. */
export const asClientID = (v: number): ClientID => v as ClientID;
/** Brand a client database id, from a number or a bigint. */
export const asClientDBID = (v: bigint | number): ClientDBID => BigInt(v) as ClientDBID;
/** Brand a server group id, from a number or a bigint. */
export const asServerGroupID = (v: bigint | number): ServerGroupID => BigInt(v) as ServerGroupID;
/** Brand a channel group id, from a number or a bigint. */
export const asChannelGroupID = (v: bigint | number): ChannelGroupID => BigInt(v) as ChannelGroupID;
/** Brand a permission id. */
export const asPermissionID = (v: number): PermissionID => v as PermissionID;
/**
 * Brand an icon id. A negative value is taken as the signed form of the same
 * CRC32, which is how the server sometimes sends one, and stored unsigned.
 */
export const asIconID = (v: number): IconID => (v >>> 0) as IconID;

/**
 * Read an icon id as the server sends it: the CRC32, sometimes as a negative
 * 32-bit number, sometimes unsigned. Both name the same icon, so both come back
 * as the unsigned value; 0, garbage and out-of-range values mean no icon.
 */
export function parseIconID(raw: string | undefined): IconID | undefined {
  const text = raw?.trim() ?? "";
  if (!/^-?\d{1,10}$/.test(text)) return undefined;
  const value = Number(text);
  if (value < -(2 ** 31) || value >= 2 ** 32 || value === 0) return undefined;
  return asIconID(value);
}

/**
 * A unique identifier: `base64(SHA-1(publicKey))` on TeamSpeak 3 and
 * `base64(SHA-256(publicKey))` on TeamSpeak 6.
 *
 * The length differs between versions, so treat it as opaque bytes rather than
 * assuming either width.
 */
export type UID = string & { readonly __brand: "UID" };
/** Brand a unique identifier. */
export const asUID = (v: string): UID => v as UID;
