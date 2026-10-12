import type { CommandMiddleware, Logger } from "@honeybbq/teamspeak-core";
import type { ReconnectOptions } from "./reconnect.js";

// ---- Branded primitive types ------------------------------------------------

// ---- Event map --------------------------------------------------------------

export interface TextMessage {
  invokerName: string;
  invokerUID: string;
  message: string;
  invokerGroups: string[];
  targetMode: number;
  targetID: bigint;
  invokerID: number;
}

export interface ClientMovedEvent {
  invokerName: string;
  invokerUID: string;
  targetChannelID: bigint;
  reasonID: number;
  id: number;
  invokerID: number;
}

export interface ClientLeftViewEvent {
  reasonMsg: string;
  reasonID: number;
  id: number;
  targetID: number;
}

export interface ClientInfo {
  nickname: string;
  uid: string;
  serverGroups: string[];
  channelID: bigint;
  type: number;
  id: number;
}

export interface ChannelInfo {
  name: string;
  description: string;
  id: bigint;
  parentID: bigint;
  /** ID of the sibling channel this one is sorted after; 0 means first. */
  order: bigint;
}

export interface PokeEvent {
  invokerName: string;
  invokerUID: string;
  invokerID: number;
  message: string;
}

export interface VoiceData {
  clientId: number;
  codec: number;
  data: Uint8Array;
}

// ---- Typed event map used by Client.on() ------------------------------------

export interface EventMap {
  textMessage: TextMessage;
  clientEnter: ClientInfo;
  clientLeave: ClientLeftViewEvent;
  clientMoved: ClientMovedEvent;
  poked: PokeEvent;
  voiceData: VoiceData;
  connected: void;
  disconnected: Error | undefined;
  kicked: string;
}

// ---- Transport seam ---------------------------------------------------------

/** Creates a UDP socket of the given address family. */
export type SocketFactory = (family: 4 | 6) => import("node:dgram").Socket;

/** Creates the TCP socket a file transfer runs over, unconnected. */
export type FileTransferSocketFactory = (host: string, port: number) => import("node:net").Socket;

// ---- Client status ----------------------------------------------------------

export const enum ClientStatus {
  Disconnected = 0,
  Connecting = 1,
  Connected = 2,
}

export type EventMiddleware = (
  next: (evt: EventMap[keyof EventMap]) => void,
) => (evt: EventMap[keyof EventMap]) => void;

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
