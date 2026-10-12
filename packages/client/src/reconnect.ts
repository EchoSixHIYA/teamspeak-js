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

import { ErrorCode, Reason, ServerError } from "@honeybbq/teamspeak-core";
import { RemovedError } from "./errors.js";

/** How long to wait before each attempt. */
export interface BackoffPolicy {
  /** Delay before the first retry, in milliseconds. */
  readonly initialDelayMs: number;
  /** Ceiling for the delay; it never grows past this. */
  readonly maxDelayMs: number;
  /** Multiplier applied after each failed attempt. */
  readonly factor: number;
  /**
   * Fraction of the delay to randomise, 0 to 1.
   *
   * A fleet of bots that drop together would otherwise retry in lockstep and
   * hit the server in a burst. Jitter spreads them out.
   */
  readonly jitter: number;
  /** Give up after this many consecutive failures. 0 means never give up. */
  readonly maxAttempts: number;
}

/** One second, doubling, capped at a minute, with 20% jitter, never giving up. */
export const defaultBackoffPolicy: Readonly<BackoffPolicy> = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: 0,
});

/**
 * How a client reconnects after its connection drops. Supplying it, even as
 * `{}`, turns reconnecting on; a deliberate `disconnect()` never reconnects.
 */
export interface ReconnectOptions {
  /** Tuning for the retry delays; unset fields keep {@link defaultBackoffPolicy}'s. */
  readonly backoff?:
    | { readonly [K in keyof BackoffPolicy]?: BackoffPolicy[K] | undefined }
    | undefined;
  /**
   * Decide whether a given failure is worth retrying. Returning false stops the
   * loop. Defaults to {@link defaultShouldRetry}.
   */
  readonly shouldRetry?: ((error: Error | undefined, attempt: number) => boolean) | undefined;
}

/**
 * Compute the delay before an attempt.
 *
 * `attempt` is 1-based: the delay before the first retry is `initialDelayMs`,
 * give or take the jitter, and the delay never grows past `maxDelayMs`.
 */
export function backoffDelay(policy: Readonly<BackoffPolicy>, attempt: number): number {
  return jitteredDelay(policy, attempt, Math.random);
}

/** @internal The delay, with `random` supplying the jitter. */
export function jitteredDelay(
  policy: Readonly<BackoffPolicy>,
  attempt: number,
  random: () => number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.initialDelayMs * policy.factor ** exponent;
  const capped = Math.min(raw, policy.maxDelayMs);

  if (policy.jitter <= 0) return Math.round(capped);

  // Full jitter would ignore the computed delay; this keeps the trend while
  // spreading peers, so a whole fleet does not retry on the same millisecond.
  // Kept under the ceiling, which a caller reasonably reads as a promise.
  const spread = capped * Math.min(policy.jitter, 1);
  const delay = capped + (random() * 2 - 1) * spread;
  return Math.round(Math.max(0, Math.min(delay, policy.maxDelayMs)));
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

/**
 * Whether a failure is worth another attempt.
 *
 * Transport failures are retried; so is a server that stopped, and a server
 * error other than the known refusals — a ban, flooding, a wrong server or
 * channel password, missing permissions — since some, such as 521 "too many
 * clones" right after a drop, clear by themselves. A kick or a ban is not:
 * someone removed the client on purpose.
 */
export function defaultShouldRetry(error: Error | undefined): boolean {
  if (error instanceof RemovedError) {
    return error.reason !== Reason.KickServer && error.reason !== Reason.KickServerBan;
  }
  return !(error instanceof ServerError && PERMANENT_SERVER_ERRORS.has(error.code));
}

export function resolveBackoffPolicy(options: ReconnectOptions): BackoffPolicy {
  const policy: Record<string, number> = { ...defaultBackoffPolicy };
  // An explicit undefined keeps the default, as an unset field does.
  for (const [key, value] of Object.entries(options.backoff ?? {})) {
    if (value !== undefined) policy[key] = value;
  }
  return policy as unknown as BackoffPolicy;
}
