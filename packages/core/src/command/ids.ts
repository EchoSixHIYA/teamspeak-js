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

export type ChannelID = bigint & { readonly __brand: "ChannelID" };
export type ClientID = number & { readonly __brand: "ClientID" };
export type ClientDBID = bigint & { readonly __brand: "ClientDBID" };
export type ServerGroupID = bigint & { readonly __brand: "ServerGroupID" };
export type ChannelGroupID = bigint & { readonly __brand: "ChannelGroupID" };
/** A permission's numeric id (`permid`), a 32-bit value assigned by the server build. */
export type PermissionID = number & { readonly __brand: "PermissionID" };
/**
 * An icon: the unsigned CRC32 of the icon file, which also names the file
 * (`/icon_<id>`) in the server's file area.
 */
export type IconID = number & { readonly __brand: "IconID" };

export const asChannelID = (v: bigint | number): ChannelID => BigInt(v) as ChannelID;
export const asClientID = (v: number): ClientID => v as ClientID;
export const asClientDBID = (v: bigint | number): ClientDBID => BigInt(v) as ClientDBID;
export const asServerGroupID = (v: bigint | number): ServerGroupID => BigInt(v) as ServerGroupID;
export const asChannelGroupID = (v: bigint | number): ChannelGroupID => BigInt(v) as ChannelGroupID;
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
export const asUID = (v: string): UID => v as UID;
