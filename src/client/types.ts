import type {
  ClientEnterEvent,
  ClientVersion,
  ClientLeaveEvent,
  ClientMovedEvent,
  CommandMiddleware,
  KickedEvent,
  Logger,
  NotificationEvent,
  PokeEvent,
  TextMessageEvent,
  VoiceDataEvent,
} from "@honeybbq/teamspeak";
import type { Duplex } from "node:stream";
import type { ReconnectOptions } from "./reconnect.js";
import type { ClientTrace } from "./trace.js";

// ---- Events ---------------------------------------------------------------

/**
 * The events `Client.on()` takes, and what each delivers. May gain events in a
 * minor release; code that handles every event generically should expect
 * names it does not know.
 */
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
  /**
   * Audio from another client. Only decoded with a listener or event
   * middleware. Voice is dropped, counted and reported in a warning at most
   * every ten seconds, while more than 256 deliveries are waiting: a listener
   * that cannot keep up loses audio rather than memory.
   */
  voiceData: VoiceDataEvent;
  /**
   * Every notification the server sends, modelled or not, after any event it
   * produces.
   */
  notification: NotificationEvent;
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
   * `undefined` after `disconnect()`, and the cause otherwise: a failed
   * handshake, a `ConnectionTimeoutError`, or a `RemovedError` for a kick, a
   * ban or a server stopping.
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

/** The values of the table below, before freezing. */
const eventNameValues = {
  /** A text message to this client, its channel or the server. */
  TextMessage: "textMessage",
  /** A client coming into view, including every client already there on connecting. */
  ClientEnter: "clientEnter",
  /** A client going out of view. */
  ClientLeave: "clientLeave",
  /** A client changing channel. */
  ClientMoved: "clientMoved",
  /** This client being poked. */
  Poked: "poked",
  /** Audio from another client. Only decoded with a listener or event middleware. */
  VoiceData: "voiceData",
  /** Every notification the server sends, modelled or not, after any event it produces. */
  Notification: "notification",
  /** The handshake completing, on `connect()` and on every reconnection. */
  Connected: "connected",
  /** The connection ending, with its cause and whether a reconnection follows. */
  Disconnected: "disconnected",
  /** A kick from the server, which also ends the connection. */
  Kicked: "kicked",
} as const;
/**
 * The names of the events `Client.on()` takes, as constants. `on(EventName.TextMessage, ...)`
 * and `on("textMessage", ...)` are the same call, and both give the listener
 * the same payload type.
 */
export const EventName: typeof eventNameValues = /* @__PURE__ */ Object.freeze(eventNameValues);
/**
 * One of {@link EventName}, and so a key of {@link EventMap}. May gain members
 * in a minor release: a `switch` over it needs a default case.
 */
export type EventName = (typeof EventName)[keyof typeof EventName];

// Each direction fails to compile when `EventMap` and `EventName` drift: an
// event without a name, and a name that is not an event.
const eventNamesCoverEventMap: [Exclude<keyof EventMap, EventName>] extends [never] ? true : never =
  true;
const eventMapCoversEventNames: [Exclude<EventName, keyof EventMap>] extends [never]
  ? true
  : never = true;
void eventNamesCoverEventMap;
void eventMapCoversEventNames;

/**
 * The events that come from the server, and so pass through event middleware.
 * May gain members in a minor release: a `switch` over an event's name needs
 * a default case.
 */
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
 *
 * Should a later release use more of a socket, the new members will be
 * optional here, so an implementation of this interface keeps compiling.
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
  /**
   * The local end of the socket, for a trace to report. Optional: a socket that
   * cannot say is reported with an empty local address.
   */
  address?(): { readonly address: string; readonly port: number };
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

/** The values of the table below, before freezing. */
const clientStatusValues = {
  /** Not connected: before `connect()`, after `disconnect()`, or after a drop. */
  Disconnected: "disconnected",
  /** Connecting: `connect()` is waiting for the handshake. */
  Connecting: "connecting",
  /** Connected: the handshake completed and commands can be sent. */
  Connected: "connected",
} as const;
/** Where a client is in its connection's life. */
export const ClientStatus: typeof clientStatusValues =
  /* @__PURE__ */ Object.freeze(clientStatusValues);
/**
 * One of {@link ClientStatus}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type ClientStatus = (typeof ClientStatus)[keyof typeof ClientStatus];

/** Wraps the delivery of server events; it may observe, alter or drop them. */
export type EventMiddleware = (next: (event: ServerEvent) => void) => (event: ServerEvent) => void;

// ---- Resolved address (from discovery) --------------------------------------

/**
 * An address a server's name resolved to. Only `addr` is needed to connect;
 * the rest describes the answer.
 */
export interface ResolvedAddr {
  /** The endpoint, as `host:port`. */
  readonly addr: string;
  /** How it was found, such as `SRV`, `TSDNS-SRV`, `TSDNS-Direct` or `Direct`. */
  readonly source?: string | undefined;
  /** When the answer stops being valid; unset for no stated lifetime. */
  readonly expiry?: Date | undefined;
}

// ---- AddrResolver interface -------------------------------------------------

/**
 * Turns the address a client was given — a host, `host:port`, or a TeamSpeak
 * name — into endpoints to connect to. The default follows SRV records and
 * TSDNS, as the TeamSpeak application does.
 */
export interface AddrResolver {
  /**
   * The endpoints for `addr`, best first. An empty answer falls back to `addr`
   * itself. `signal` aborts when the connection attempt is given up, or once
   * resolution has taken 10 seconds, after which the client connects to
   * `addr` as given; a resolver that ignores it is abandoned all the same.
   */
  resolve(
    addr: string,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<readonly ResolvedAddr[]>;
}

// ---- ClientOptions ----------------------------------------------------------

/** How a `Client` connects, logs and behaves; every field is optional. */
export interface ClientOptions {
  /** Where the client logs. Silent unless set: a library has no business writing to the console. */
  readonly logger?: Logger | undefined;
  /**
   * Creates the UDP socket the client talks through, given the address family
   * the server's address resolved to.
   *
   * Supplying one lets an application route traffic through a proxy or tunnel,
   * or drive the client from something other than a real socket. It is the only
   * seam into the transport: without it the SDK always creates its own.
   */
  readonly socketFactory?: SocketFactory | undefined;
  /**
   * Reconnect after a dropped connection.
   *
   * Off by default: a silent reconnect makes an outage look like an ordinary
   * session. An explicit `disconnect()` never reconnects regardless.
   */
  readonly reconnect?: ReconnectOptions | undefined;
  /**
   * Hooks called at each milestone of every connection attempt, for timing,
   * metrics and progress. The object is copied when the client is made, so
   * changing it afterwards has no effect. See {@link ClientTrace} for the
   * rules a hook follows.
   */
  readonly trace?: ClientTrace | undefined;
  /**
   * Creates the TCP socket a file transfer runs over.
   *
   * Separate from `socketFactory` because file transfer dials its own
   * connection to a different port, on demand. Set both to route everything
   * through a proxy.
   */
  readonly fileTransferSocketFactory?: FileTransferSocketFactory | undefined;
  /**
   * Look a dot-less address up as a server nickname at named.myteamspeak.com,
   * as the TeamSpeak application does. Off by default, since it sends the name
   * to a third party; without it a dot-less name is resolved like any host.
   * Ignored with a custom `resolver`.
   */
  readonly nicknameLookup?: boolean | undefined;
  /** Replaces the SRV and TSDNS resolution `connect()` performs. */
  readonly resolver?: AddrResolver | undefined;
  /**
   * Wraps every typed command, outermost first; see `CommandMiddleware`. Raw
   * lines sent with `exec` and `execNoWait` do not pass through it. Fixed for
   * the client's life.
   */
  readonly commandMiddleware?: readonly CommandMiddleware[] | undefined;
  /** Wraps the delivery of every server event, outermost first. Fixed for the client's life. */
  readonly eventMiddleware?: readonly EventMiddleware[] | undefined;
  /**
   * The platform, version and signature `clientinit` sends. Default: a recent
   * Windows build. Pick another from `@honeybbq/teamspeak/versions`; a version
   * the server does not know, or a build below its minimum, is refused when
   * connecting. A bad value throws when the client is made.
   */
  readonly version?: ClientVersion | undefined;
  /** Server password sent during the initial `clientinit` handshake. */
  readonly serverPassword?: string | undefined;
  /** Default channel name to join during the initial `clientinit` handshake. */
  readonly defaultChannel?: string | undefined;
  /** Password for `defaultChannel`, sent during the initial `clientinit` handshake. */
  readonly defaultChannelPassword?: string | undefined;
}
