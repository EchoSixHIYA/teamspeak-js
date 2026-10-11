/**
 * Branded identifiers.
 *
 * TeamSpeak uses one 64-bit integer space for several unrelated kinds of id, so
 * a `bigint` alone cannot tell a channel from a client. Branding makes the
 * mistake a compile error instead of a silent move-to-the-wrong-place, and the
 * brands cost nothing at runtime.
 */

export type ChannelID = bigint & { readonly __brand: "ChannelID" };
export type ClientID = number & { readonly __brand: "ClientID" };
export type ClientDBID = bigint & { readonly __brand: "ClientDBID" };
export type ServerGroupID = bigint & { readonly __brand: "ServerGroupID" };
export type ChannelGroupID = bigint & { readonly __brand: "ChannelGroupID" };
export type PermissionID = bigint & { readonly __brand: "PermissionID" };
export type IconID = bigint & { readonly __brand: "IconID" };

export const asChannelID = (v: bigint | number): ChannelID => BigInt(v) as ChannelID;
export const asClientID = (v: number): ClientID => v as ClientID;
export const asClientDBID = (v: bigint | number): ClientDBID => BigInt(v) as ClientDBID;
export const asServerGroupID = (v: bigint | number): ServerGroupID => BigInt(v) as ServerGroupID;
export const asChannelGroupID = (v: bigint | number): ChannelGroupID => BigInt(v) as ChannelGroupID;
export const asPermissionID = (v: bigint | number): PermissionID => BigInt(v) as PermissionID;
export const asIconID = (v: bigint | number): IconID => BigInt(v) as IconID;

/**
 * A unique identifier: `base64(SHA-1(publicKey))` on TeamSpeak 3 and
 * `base64(SHA-256(publicKey))` on TeamSpeak 6.
 *
 * The length differs between versions, so treat it as opaque bytes rather than
 * assuming either width.
 */
export type UID = string & { readonly __brand: "UID" };
export const asUID = (v: string): UID => v as UID;
