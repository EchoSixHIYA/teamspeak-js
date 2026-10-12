import type { CommandMiddleware, Logger } from "@honeybbq/teamspeak-core";
import type { ReconnectOptions } from "./reconnect.js";

// ---- Events ---------------------------------------------------------------

export interface TextMessage {
  readonly invokerName: string;
  readonly invokerUID: string;
  readonly message: string;
  readonly invokerGroups: readonly string[];
  readonly targetMode: number;
  readonly targetID: bigint;
  readonly invokerID: number;
}

export interface ClientMovedEvent {
  readonly invokerName: string;
  readonly invokerUID: string;
  readonly targetChannelID: bigint;
  /** Why the client moved; compare it with `Reason`. */
  readonly reason: number;
  readonly id: number;
  readonly invokerID: number;
}

export interface ClientLeftViewEvent {
  /** The reason given for a kick or a ban, or the client's own parting message. */
  readonly reasonMessage: string;
  /** Why the client left; compare it with `Reason`. */
  readonly reason: number;
  readonly id: number;
  /** Who kicked or banned the client; empty otherwise. */
  readonly invokerName: string;
  readonly invokerUID: string;
  readonly invokerID: number;
}

/** This client being kicked from its channel or the server. */
export interface KickedEvent {
  /** The reason the invoker gave. */
  readonly reasonMessage: string;
  /** `Reason.KickChannel`, `Reason.KickServer` or `Reason.KickServerBan`. */
  readonly reason: number;
  readonly invokerName: string;
  readonly invokerUID: string;
  readonly invokerID: number;
}

export interface ClientInfo {
  readonly nickname: string;
  readonly uid: string;
  readonly serverGroups: readonly string[];
  readonly channelID: bigint;
  readonly type: number;
  readonly id: number;
}

export interface PokeEvent {
  readonly invokerName: string;
  readonly invokerUID: string;
  readonly invokerID: number;
  readonly message: string;
}

export interface VoiceData {
  readonly clientId: number;
  readonly codec: number;
  readonly data: Uint8Array;
}

/**
 * A notification from the server, as it arrived: the escape hatch for one the
 * SDK does not model.
 */
export interface RawNotification {
  /** The notification's name, such as `notifyserveredited`. */
  readonly name: string;
  /** Its parameters, unescaped. */
  readonly params: Readonly<Record<string, string>>;
}

/** The events `Client.on()` takes, and what each delivers. */
export interface EventMap {
  textMessage: TextMessage;
  clientEnter: ClientInfo;
  clientLeave: ClientLeftViewEvent;
  clientMoved: ClientMovedEvent;
  poked: PokeEvent;
  voiceData: VoiceData;
  /**
   * Every notification the server sends, modelled or not, after any event it
   * produces.
   */
  notification: RawNotification;
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

/** Creates a UDP socket of the given address family. */
export type SocketFactory = (family: 4 | 6) => import("node:dgram").Socket;

/** Creates the TCP socket a file transfer runs over, unconnected. */
export type FileTransferSocketFactory = (host: string, port: number) => import("node:net").Socket;

// ---- Client status ----------------------------------------------------------

export const ClientStatus = {
  Disconnected: "disconnected",
  Connecting: "connecting",
  Connected: "connected",
} as const;
export type ClientStatus = (typeof ClientStatus)[keyof typeof ClientStatus];

/** Wraps the delivery of server events; it may observe, alter or drop them. */
export type EventMiddleware = (next: (event: ServerEvent) => void) => (event: ServerEvent) => void;

// ---- Resolved address (from discovery) --------------------------------------

export interface ResolvedAddr {
  addr: string;
  source: string;
  expiry: Date;
}

// ---- AddrResolver interface -------------------------------------------------

export interface AddrResolver {
  resolve(addr: string, signal?: AbortSignal): Promise<ResolvedAddr[]>;
}

// ---- ClientOptions ----------------------------------------------------------

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
  resolver?: AddrResolver;
  commandMiddleware?: CommandMiddleware[];
  eventMiddleware?: EventMiddleware[];
  /** Server password sent during the initial `clientinit` handshake. */
  serverPassword?: string;
  /** Default channel name to join during the initial `clientinit` handshake. */
  defaultChannel?: string;
  /** Password for `defaultChannel`, sent during the initial `clientinit` handshake. */
  defaultChannelPassword?: string;
}
