/**
 * Reconnection policy.
 *
 * A dropped connection is normal on a UDP voice session, so a bot that cannot
 * recover is not usable unattended. Reconnecting is opt-in rather than
 * automatic: a silent reconnect makes a dropped session look like a healthy
 * one, and a caller that wanted to know about the drop never finds out.
 *
 * Backoff is not a nicety here. TeamSpeak bans an IP that opens several
 * connections in quick succession — measured at roughly three, after which the
 * server answers `error id=3329` and refuses everything. A reconnect loop
 * without a delay therefore bans itself, and the ban outlasts the outage it was
 * recovering from.
 */

import { ErrorCode, ServerError } from "@honeybbq/teamspeak-core";

/** How long to wait before each attempt. */
export interface BackoffPolicy {
  /** Delay before the first retry, in milliseconds. */
  initialDelayMs: number;
  /** Ceiling for the delay; it never grows past this. */
  maxDelayMs: number;
  /** Multiplier applied after each failed attempt. */
  factor: number;
  /**
   * Fraction of the delay to randomise, 0 to 1.
   *
   * A fleet of bots that drop together would otherwise retry in lockstep and
   * hit the server in a burst. Jitter spreads them out.
   */
  jitter: number;
  /** Give up after this many consecutive failures. 0 means never give up. */
  maxAttempts: number;
}

export const defaultBackoffPolicy: BackoffPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: 0,
};

export interface ReconnectOptions {
  /**
   * Reconnect after a dropped connection. Off by default.
   *
   * A deliberate `disconnect()` never reconnects, whatever this is set to.
   */
  enabled?: boolean;
  /** Tuning for the retry delays. */
  backoff?: Partial<BackoffPolicy>;
  /**
   * Decide whether a given failure is worth retrying.
   *
   * Returning false stops the loop. The default retries transport failures and
   * gives up on the server's own refusals — an invalid password, a ban, a
   * version mismatch — because retrying those produces the same answer and, for
   * a ban, makes it worse.
   */
  shouldRetry?: (error: Error | undefined, attempt: number) => boolean;
}

/**
 * Compute the delay before an attempt.
 *
 * `attempt` is 1-based: the delay before the first retry is
 * `initialDelayMs`, and the returned value is never above `maxDelayMs`.
 */
export function backoffDelay(policy: BackoffPolicy, attempt: number, random = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.initialDelayMs * policy.factor ** exponent;
  const capped = Math.min(raw, policy.maxDelayMs);

  if (policy.jitter <= 0) return Math.round(capped);

  // Full jitter would ignore the computed delay; this keeps the trend while
  // spreading peers, so a whole fleet does not retry on the same millisecond.
  const spread = capped * policy.jitter;
  const offset = (random() * 2 - 1) * spread;

  return Math.max(0, Math.round(capped + offset));
}

/**
 * Server errors where retrying cannot help.
 *
 * Deliberately a short list of codes known to be refusals, rather than "any
 * ServerError". The server also answers transiently: after a dropped
 * connection it still holds the old session, and a reconnect with the same
 * identity is refused with 521 "too many clones already connected" until it
 * reaps the zombie — a condition that clears itself and is worth retrying.
 *
 * The asymmetry is deliberate. Retrying a permanent failure costs a few bounded
 * attempts; not retrying a transient one means never recovering.
 */
const PERMANENT_SERVER_ERRORS: ReadonlySet<number> = new Set([
  ErrorCode.ConnectFailedBanned,
  ErrorCode.BanFlooding,
  ErrorCode.ServerInvalidPassword,
  ErrorCode.ChannelInvalidPassword,
  ErrorCode.PermissionsClientInsufficient,
]);

export function isPermanentFailure(error: Error | undefined): boolean {
  // Anything but a listed refusal — a transport failure, or a ServerError the
  // list does not name — is treated as worth retrying. See
  // PERMANENT_SERVER_ERRORS for why that is the safer direction to be wrong in.
  return error instanceof ServerError && PERMANENT_SERVER_ERRORS.has(error.code);
}

export function resolveBackoffPolicy(options: ReconnectOptions): BackoffPolicy {
  return { ...defaultBackoffPolicy, ...options.backoff };
}
