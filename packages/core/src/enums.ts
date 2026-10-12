/**
 * Enumerations the server reports and accepts as small integers.
 *
 * Each is an object of named values plus a type of the same name, the way
 * `Reason` is: the object names the values (`GroupType.Regular`), the type
 * restricts a parameter to them.
 *
 * Parameters take the type; parsed results carry a plain `number`, since a
 * server may send a value newer than this table — compare it against the
 * names (`group.type === GroupType.Query`).
 */

/** What kind of group a server or channel group is (`type`). */
export const GroupType = {
  /**
   * A template: the server copies it to create the groups of a new virtual
   * server, and no client can be a member.
   */
  Template: 0,
  /** An ordinary group that voice clients join. */
  Regular: 1,
  /** A group for ServerQuery clients. */
  Query: 2,
} as const;

/** A group type. */
export type GroupType = (typeof GroupType)[keyof typeof GroupType];

/** Where a group's name is shown beside a member's nickname (`namemode`). */
export const GroupNameMode = {
  /** No group name is shown. */
  Hidden: 0,
  /** The group name is shown before the nickname. */
  Before: 1,
  /** The group name is shown after the nickname. */
  After: 2,
} as const;

/** A group name mode. */
export type GroupNameMode = (typeof GroupNameMode)[keyof typeof GroupNameMode];

/** Which kind of group a privilege key grants (`token_type`). */
export const TokenType = {
  /** The key grants a server group. */
  ServerGroup: 0,
  /** The key grants a channel group in one channel. */
  ChannelGroup: 1,
} as const;

/** A privilege key type. */
export type TokenType = (typeof TokenType)[keyof typeof TokenType];

/** What kind of connection a client is (`client_type`). */
export const ClientType = {
  /** A voice client, such as the TeamSpeak application or this SDK's client. */
  Voice: 0,
  /** A ServerQuery client. */
  Query: 1,
} as const;

/** A client type. */
export type ClientType = (typeof ClientType)[keyof typeof ClientType];

/** A voice codec: the one a channel uses (`channel_codec`). */
export const Codec = {
  /** Speex at 8 kHz. Current clients no longer play it. */
  SpeexNarrowband: 0,
  /** Speex at 16 kHz. Current clients no longer play it. */
  SpeexWideband: 1,
  /** Speex at 32 kHz. Current clients no longer play it. */
  SpeexUltraWideband: 2,
  /** CELT at 48 kHz. Current clients no longer play it. */
  CELTMono: 3,
  /** Opus tuned for speech, mono. */
  OpusVoice: 4,
  /** Opus tuned for music, stereo. */
  OpusMusic: 5,
} as const;

/** A voice codec. */
export type Codec = (typeof Codec)[keyof typeof Codec];

/** What a permission is set on, as `permfind` and `permoverview` report it (`t`). */
export const PermissionTarget = {
  /** A server group; `id1` is the group. */
  ServerGroup: 0,
  /** A client, server-wide; `id1` is the client's database id. */
  Client: 1,
  /** A channel; `id1` is the channel. */
  Channel: 2,
  /** A channel group; `id2` is the group. */
  ChannelGroup: 3,
  /** A client within one channel; `id1` is the channel and `id2` the client's database id. */
  ChannelClient: 4,
} as const;

/** A permission target. */
export type PermissionTarget = (typeof PermissionTarget)[keyof typeof PermissionTarget];

/** Where a text message goes (`targetmode`), as text message events report it. */
export const TextMessageTarget = {
  /** A private message to one client. */
  Client: 1,
  /** A message to the sender's current channel. */
  Channel: 2,
  /** A message to everyone on the virtual server. */
  Server: 3,
} as const;

/** A text message target. */
export type TextMessageTarget = (typeof TextMessageTarget)[keyof typeof TextMessageTarget];

/** A server log severity, matching the server's own levels (`loglevel`). */
export const LogLevel = {
  /** An error. */
  Error: 1,
  /** A warning. */
  Warning: 2,
  /** Debugging detail. */
  Debug: 3,
  /** Routine information. */
  Info: 4,
} as const;

/** A log level. */
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
