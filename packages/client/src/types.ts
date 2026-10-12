import type {
  ChannelID,
  ClientEntry,
  ClientID,
  CommandMiddleware,
  Logger,
  ServerGroupID,
  UID,
} from "@honeybbq/teamspeak-core";
import type { Duplex } from "node:stream";
import type { ReconnectOptions } from "./reconnect.js";

// ---- Events ---------------------------------------------------------------

/** A text message, sent privately, to a channel, or to the whole server. */
export interface TextMessageEvent {
  /** The sender's nickname. */
  readonly invokerName: string;
  /** The sender's unique identifier. */
  readonly invokerUID: UID;
  /** The message, unescaped. */
  readonly message: string;
  /** The sender's server groups, as this client last saw them. */
  readonly invokerGroups: readonly ServerGroupID[];
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
 * SDK does not model.
 */
export interface NotificationEvent {
  /** The notification's name, such as `notifyserveredited`. */
  readonly name: string;
  /** Its parameters, unescaped. */
  readonly params: Readonly<Record<string, string>>;
}

/** The events `Client.on()` takes, and what each delivers. */
export interface EventMap {
  /** A text message to this client, its channel or the server. */
  textMessage: TextMessageEvent;
  /** A client coming into view, including every client already there on connecting. */
  clientEnter: ClientEnterEvent;
  /** A client going out of view. */
  clientLeave: ClientLeaveEvent;
  /** A client changing channel. */
  clientMoved: ClientMovedEvent;
  /** This client being poked. */
  poked: PokeEvent;
  /** Audio from another client. Only decoded with a listener or event middleware. */
  voiceData: VoiceDataEvent;
  /**
   * Every notification the server sends, modelled or not, after any event it
   * produces.
   */
  notification: NotificationEvent;
  /** The handshake completing, on `connect()` and on every reconnection. */
  connected: void;
  /**
   * `undefined` after `disconnect()`, and the cause otherwise: a failed
   * handshake, a `TimedOutError`, or a `RemovedError` for a kick, a
   * ban or a server stopping.
   */
  disconnected: Error | undefined;
  /** A kick from the server also ends the connection, which `disconnected` reports. */
  kicked: KickedEvent;
}

/** The events that come from the server, and so pass through event middleware. */
export type ServerEventName =
  | "textMessage"
  | "clientEnter"
  | "clientLeave"
  | "clientMoved"
  | "poked"
  | "voiceData"
  | "notification";

/** A server event as event middleware sees it. */
export type ServerEvent = {
  [K in ServerEventName]: { readonly name: K; readonly payload: EventMap[K] };
}[ServerEventName];

/** A listener for one event. */
export type Listener<K extends keyof EventMap> = EventMap[K] extends void
  ? () => void
  : (payload: EventMap[K]) => void;

/** Removes a listener; calling it again does nothing. Also a `Disposable`, for `using`. */
export type Unsubscribe = (() => void) & Disposable;

// ---- Transport seam ---------------------------------------------------------

/**
 * The part of a UDP socket the client uses. A `node:dgram` socket is one; so
 * is anything else with these methods, such as a tunnel or a test double.
 */
export interface DatagramSocket {
  /** Fix the peer, then call `callback`; failure is reported as an `error` event. */
  connect(port: number, address: string, callback: () => void): void;
  /** Send one datagram to the peer. */
  send(data: Uint8Array, callback: (error: Error | null) => void): void;
  /** Close the socket; it then emits `close`. */
  close(): void;
  /** Listen for each datagram received. */
  on(event: "message", listener: (message: Uint8Array) => void): unknown;
  /** Listen for a failure, which ends the connection. */
  on(event: "error", listener: (error: Error) => void): unknown;
  /** Listen for the socket closing. */
  on(event: "close", listener: () => void): unknown;
  /** Listen for the next failure only, while connecting. */
  once(event: "error", listener: (error: Error) => void): unknown;
  /** Stop listening for failures. */
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** Creates the UDP socket the client talks through, for the given address family. */
export type SocketFactory = (family: 4 | 6) => DatagramSocket;

/**
 * Opens the connection a file transfer runs over, to `host:port`. A
 * `node:net` socket is one, as is the socket a SOCKS or HTTP proxy library
 * returns. It may still be connecting when returned: the transfer waits for
 * it.
 */
export type FileTransferSocketFactory = (host: string, port: number) => Duplex;

// ---- Client status ----------------------------------------------------------

/** Where a client is in its connection's life. */
export const ClientStatus = {
  /** Not connected: before `connect()`, after `disconnect()`, or after a drop. */
  Disconnected: "disconnected",
  /** Connecting: `connect()` is waiting for the handshake. */
  Connecting: "connecting",
  /** Connected: the handshake completed and commands can be sent. */
  Connected: "connected",
} as const;
/** One of {@link ClientStatus}. */
export type ClientStatus = (typeof ClientStatus)[keyof typeof ClientStatus];

/** Wraps the delivery of server events; it may observe, alter or drop them. */
export type EventMiddleware = (next: (event: ServerEvent) => void) => (event: ServerEvent) => void;

// ---- Resolved address (from discovery) --------------------------------------

/** An address a server's name resolved to. */
export interface ResolvedAddr {
  /** The endpoint, as `host:port`. */
  addr: string;
  /** How it was found: an SRV record, TSDNS, or the address as given. */
  source: string;
  /** When the answer stops being valid. */
  expiry: Date;
}

// ---- AddrResolver interface -------------------------------------------------

/**
 * Turns the address a client was given — a host, `host:port`, or a TeamSpeak
 * name — into endpoints to connect to. The default follows SRV records and
 * TSDNS, as the TeamSpeak application does.
 */
export interface AddrResolver {
  /** The endpoints for `addr`, best first. An empty answer falls back to `addr` itself. */
  resolve(addr: string, signal?: AbortSignal): Promise<ResolvedAddr[]>;
}

// ---- ClientOptions ----------------------------------------------------------

/** How a `Client` connects, logs and behaves; every field is optional. */
export interface ClientOptions {
  /** Where the client logs. Silent unless set: a library has no business writing to the console. */
  logger?: Logger;
  /**
   * Creates the UDP socket the client talks through, given the address family
   * the server's address resolved to.
   *
   * Supplying one lets an application route traffic through a proxy or tunnel,
   * or drive the client from something other than a real socket. It is the only
   * seam into the transport: without it the SDK always creates its own.
   */
  socketFactory?: SocketFactory;
  /**
   * Reconnect after a dropped connection.
   *
   * Off by default: a silent reconnect makes an outage look like an ordinary
   * session. An explicit `disconnect()` never reconnects regardless.
   */
  reconnect?: ReconnectOptions;
  /**
   * Creates the TCP socket a file transfer runs over.
   *
   * Separate from `socketFactory` because file transfer dials its own
   * connection to a different port, on demand. Set both to route everything
   * through a proxy.
   */
  fileTransferSocketFactory?: FileTransferSocketFactory;
  /** Replaces the SRV and TSDNS resolution `connect()` performs. */
  resolver?: AddrResolver;
  /** Wraps every command line sent, outermost first. Fixed for the client's life. */
  commandMiddleware?: CommandMiddleware[];
  /** Wraps the delivery of every server event, outermost first. Fixed for the client's life. */
  eventMiddleware?: EventMiddleware[];
  /** Server password sent during the initial `clientinit` handshake. */
  serverPassword?: string;
  /** Default channel name to join during the initial `clientinit` handshake. */
  defaultChannel?: string;
  /** Password for `defaultChannel`, sent during the initial `clientinit` handshake. */
  defaultChannelPassword?: string;
}
