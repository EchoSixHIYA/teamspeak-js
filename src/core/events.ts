/**
 * The events a TeamSpeak client receives from the server. Every kind of client
 * shares these types.
 */

import type { ChannelID, ClientID, ServerGroupID, UID } from "./command/ids.js";
import type { ClientEntry } from "./api/clients.js";
import type { NotificationName } from "./notification-name.js";

/** A text message, sent privately, to a channel, or to the whole server. */
export interface TextMessageEvent {
  /** The sender's nickname. */
  readonly invokerName: string;
  /** The sender's unique identifier. */
  readonly invokerUID: UID;
  /** The message, unescaped. */
  readonly message: string;
  /**
   * The sender's server groups. A text message does not carry them; they are
   * those of the sender as the client knows it, so they are `undefined` for a
   * sender the client has not seen.
   */
  readonly invokerGroups: readonly ServerGroupID[] | undefined;
  /**
   * Private, channel or server; compare it with `TextMessageTarget`. A plain
   * number, since a server may send a mode that table does not name.
   */
  readonly targetMode: number;
  /**
   * The client a private message was sent to. Channel and server messages
   * carry no target, so it is 0 for them.
   */
  readonly targetID: ClientID;
  /** The sender. */
  readonly invokerID: ClientID;
}

/** A client changing channel, of its own accord or moved by someone. */
export interface ClientMovedEvent {
  /** Who moved the client; the client itself for a move of its own. */
  readonly invokerName: string;
  /** The mover's unique identifier. */
  readonly invokerUID: UID;
  /** The channel the client is now in. */
  readonly targetChannelID: ChannelID;
  /** Why the client moved; compare it with `Reason`. */
  readonly reason: number;
  /** The message that came with the move, such as a channel kick's reason; "" when none. */
  readonly reasonMessage: string;
  /** The client that moved. */
  readonly clientID: ClientID;
  /** The mover. */
  readonly invokerID: ClientID;
}

/**
 * A client going out of view: leaving the server, kicked or banned from it, or
 * in a channel that stopped being subscribed.
 */
export interface ClientLeaveEvent {
  /** The reason given for a kick or a ban, or the client's own parting message. */
  readonly reasonMessage: string;
  /** Why the client left; compare it with `Reason`. */
  readonly reason: number;
  /** The client that left. */
  readonly clientID: ClientID;
  /** Who kicked or banned the client; empty otherwise. */
  readonly invokerName: string;
  /** The kicker's unique identifier; empty unless kicked or banned. */
  readonly invokerUID: UID;
  /** The kicker; 0 unless kicked or banned. */
  readonly invokerID: ClientID;
}

/** This client being kicked from its channel or the server. */
export interface KickedEvent {
  /** The reason the invoker gave. */
  readonly reasonMessage: string;
  /** `Reason.KickChannel`, `Reason.KickServer` or `Reason.KickServerBan`. */
  readonly reason: number;
  /** Who kicked this client. */
  readonly invokerName: string;
  /** The kicker's unique identifier. */
  readonly invokerUID: UID;
  /** The kicker. */
  readonly invokerID: ClientID;
}

/**
 * A client coming into view: the same record `listClients` returns, so one
 * type describes a client however it was learned of; its own id is `id`, as
 * in every record. The fields only `clientlist -times` reports are undefined
 * here.
 */
export type ClientEnterEvent = ClientEntry;

/** This client being poked. */
export interface PokeEvent {
  /** Who poked. */
  readonly invokerName: string;
  /** The poker's unique identifier. */
  readonly invokerUID: UID;
  /** The poker. */
  readonly invokerID: ClientID;
  /** The poke's message, unescaped. */
  readonly message: string;
}

/** Audio from another client, in the channel or whispered. */
export interface VoiceDataEvent {
  /** Who is speaking. */
  readonly clientID: ClientID;
  /**
   * How the audio is encoded; compare it with `Codec`. A plain number, since a
   * server may relay a codec that table does not name.
   */
  readonly codec: number;
  /** One encoded frame, copied: it stays valid after the listener returns. */
  readonly data: Uint8Array;
}

/**
 * A notification from the server, as it arrived: the escape hatch for one the
 * SDK does not model. Match its `name` against `NotificationName`.
 */
export interface NotificationEvent {
  /** The notification's name, such as `notifyserveredited`; `NotificationName` lists the known ones. */
  readonly name: NotificationName | (string & {});
  /** Its parameters, unescaped. */
  readonly params: Readonly<Record<string, string>>;
}

/** What `connected` delivers. */
export interface ConnectedEvent {
  /**
   * Whether the reconnect loop made this connection, rather than a call to
   * `connect()`.
   */
  readonly reconnected: boolean;
}

/** What `disconnected` delivers. */
export interface DisconnectedEvent {
  /**
   * `undefined` after `disconnect()`, and the cause otherwise, such as a failed
   * handshake, the connection timing out, or the client being removed.
   */
  readonly error: Error | undefined;
  /**
   * Whether the reconnect loop will try again, as of this event. False after
   * `disconnect()`, without `reconnect` options, when `shouldRetry` refuses
   * this cause, and once `backoff.maxAttempts` is spent. A `disconnect()` or a
   * manual `connect()` while it waits can still end the loop.
   */
  readonly willReconnect: boolean;
}

/** The events a server sends, by name, that every kind of client delivers. */
export interface ServerEventMap {
  /** A text message to this client, its channel or the server. */
  textMessage: TextMessageEvent;
  /** A client coming into view, including every client already there on connecting. */
  clientEnter: ClientEnterEvent;
  /** A client going out of view. */
  clientLeave: ClientLeaveEvent;
  /** A client changing channel. */
  clientMoved: ClientMovedEvent;
  /**
   * Every notification the server sends, modelled or not, after any event it
   * produces.
   */
  notification: NotificationEvent;
}

/** The events about a connection's own life, by name, that every kind of client delivers. */
export interface SessionEventMap {
  /** The handshake completing, on `connect()` and on every reconnection. */
  connected: ConnectedEvent;
  /**
   * The connection ending, after `disconnect()`, a drop, or a failed attempt;
   * the event says why and whether the reconnect loop will try again.
   */
  disconnected: DisconnectedEvent;
  /** A kick from the server also ends the connection, which `disconnected` reports. */
  kicked: KickedEvent;
}
