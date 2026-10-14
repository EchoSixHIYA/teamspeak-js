import type { ClientID } from "@honeybbq/teamspeak-core";
import type { ServerCapabilities } from "./capabilities.js";

/** The values of the table below, before freezing. */
const connectPhaseValues = {
  /** Opening the socket, or the address was not usable once resolved. */
  Open: "open",
  /** The handshake, from the first packet until the shared secret exists. */
  Handshake: "handshake",
  /** After the handshake, waiting for the server to accept the client: a wrong password, a ban or an invalid nickname end here. */
  Join: "join",
} as const;
/** Where a connection attempt can fail; see {@link AttemptFailedInfo}. */
export const ConnectPhase: typeof connectPhaseValues =
  /* @__PURE__ */ Object.freeze(connectPhaseValues);
/**
 * One of {@link ConnectPhase}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type ConnectPhase = (typeof ConnectPhase)[keyof typeof ConnectPhase];

/** What every milestone of one connection attempt says about the attempt. */
interface AttemptInfo {
  /**
   * The attempt's number, from 1. The attempt `connect()` starts is 1; a
   * reconnection attempt carries the retry number the reconnect policy uses,
   * the one `shouldRetry` and the backoff see.
   */
  readonly attempt: number;
  /** Whether the reconnect loop started this attempt rather than a call to `connect()`. */
  readonly reconnect: boolean;
}

/** The address is about to be resolved. */
export interface ResolveStartInfo extends AttemptInfo {
  /** The address as the client was given it. */
  readonly addr: string;
}

/** The address has been resolved, or the lookup failed and the address is used as given. */
export interface ResolveDoneInfo extends AttemptInfo {
  /** The address as the client was given it. */
  readonly addr: string;
  /** The `host:port` that will be dialled. */
  readonly target: string;
  /** What the resolver reports as the source of the answer; may be empty. */
  readonly source: string;
  /** Why the lookup failed, when the address is used as given; `undefined` otherwise. */
  readonly error: unknown;
  /** How long the resolution took, in milliseconds. */
  readonly durationMs: number;
}

/** The socket is about to be opened. */
export interface ConnectStartInfo extends AttemptInfo {
  /** The `host:port` being dialled. */
  readonly target: string;
}

/** The encrypted session exists; `clientinit` has not been sent yet. */
export interface HandshakeDoneInfo extends AttemptInfo {
  /** Milliseconds since the socket was about to be opened. */
  readonly durationMs: number;
}

/** The server accepted the client, which is now connected. */
export interface SessionStartInfo extends AttemptInfo {
  /** The client's ID on the server, the same as `client.clientID`. */
  readonly clientID: ClientID;
  /** What the server said about itself in this handshake. */
  readonly capabilities: ServerCapabilities;
  /** Milliseconds since the socket was about to be opened. */
  readonly durationMs: number;
}

/** The server's welcome sequence ended: the channel list and the clients already there have arrived. */
export interface WelcomeDoneInfo extends AttemptInfo {
  /** Milliseconds since the socket was about to be opened. */
  readonly durationMs: number;
}

/** An attempt ended without a session. */
export interface AttemptFailedInfo extends AttemptInfo {
  /** Where the attempt failed. */
  readonly phase: ConnectPhase;
  /** Why: the error `connect()` rejects with, or the one that ended the reconnection attempt. */
  readonly error: unknown;
  /** Milliseconds since the address was about to be resolved. */
  readonly durationMs: number;
}

/** The reconnect loop will retry, after a wait. */
export interface ReconnectScheduledInfo {
  /** The attempt that will follow, numbered as in {@link ResolveStartInfo.attempt}. */
  readonly attempt: number;
  /** How long the loop waits first, in milliseconds. */
  readonly delayMs: number;
  /** The error that ended the previous connection or attempt. */
  readonly cause: unknown;
}

/**
 * Hooks that observe the milestones of every connection attempt, for timing,
 * metrics, logs or a progress display. Every hook is optional.
 *
 * A hook is called synchronously, at the moment of the milestone, and the
 * client waits for it to return: keep it quick, and hand slow work to your own
 * task. What it returns is ignored, and a returned promise is never awaited. A
 * hook that throws, or whose promise rejects, is reported the way a throwing
 * event listener is, and the connection carries on. A hook may read the
 * client's state. It must not call `connect()` or `disconnect()`: to give up
 * on an attempt, abort the signal passed to `connect()`, and to leave once
 * connected, call `disconnect()` from a `connected` listener.
 *
 * Every attempt ends with exactly one of `sessionStart` and `attemptFailed`.
 * The hooks are read when the client is made, from a copy of this object.
 */
export interface ConnectTrace {
  /** Before the address is resolved. */
  readonly resolveStart?: (info: ResolveStartInfo) => void;
  /** After the address is resolved, also when it fell back to the address as given. */
  readonly resolveDone?: (info: ResolveDoneInfo) => void;
  /** Right before the socket is opened. */
  readonly connectStart?: (info: ConnectStartInfo) => void;
  /** When the shared secret is derived, before `clientinit` is sent. */
  readonly handshakeDone?: (info: HandshakeDoneInfo) => void;
  /** When the server accepts the client: before `connect()` resolves and before `connected` is delivered. */
  readonly sessionStart?: (info: SessionStartInfo) => void;
  /** When the server's welcome sequence ends; at most once per attempt, and only after `sessionStart`. */
  readonly welcomeDone?: (info: WelcomeDoneInfo) => void;
  /** When an attempt ends without `sessionStart`, for any reason, an abort or `disconnect()` included. */
  readonly attemptFailed?: (info: AttemptFailedInfo) => void;
  /** When the reconnect loop has decided to retry and is about to wait. */
  readonly reconnectScheduled?: (info: ReconnectScheduledInfo) => void;
}
