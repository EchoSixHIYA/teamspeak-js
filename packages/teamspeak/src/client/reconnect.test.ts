import { describe, it, expect } from "vitest";
import {
  backoffDelay,
  defaultBackoffPolicy,
  defaultShouldRetry,
  jitteredDelay,
  resolveBackoffPolicy,
  type BackoffPolicy,
} from "./reconnect.js";
import { ServerError } from "@honeybbq/teamspeak";
import { AlreadyConnectedError, FileTransferError, InvalidAddressError } from "./errors.js";

const policy = (overrides: Partial<BackoffPolicy> = {}): BackoffPolicy => ({
  ...defaultBackoffPolicy,
  jitter: 0,
  ...overrides,
});

describe("backoffDelay", () => {
  it("doubles from the initial delay", () => {
    const p = policy({ initialDelayMs: 100, factor: 2, maxDelayMs: 10_000 });
    expect(backoffDelay(p, 1)).toBe(100);
    expect(backoffDelay(p, 2)).toBe(200);
    expect(backoffDelay(p, 3)).toBe(400);
    expect(backoffDelay(p, 4)).toBe(800);
  });

  it("never exceeds the ceiling", () => {
    const p = policy({ initialDelayMs: 1_000, factor: 2, maxDelayMs: 5_000 });
    expect(backoffDelay(p, 10)).toBe(5_000);
    expect(backoffDelay(p, 50)).toBe(5_000);
  });

  // TeamSpeak bans an IP after roughly three rapid connects, so a retry loop
  // that returns 0 — or a tiny delay — bans itself and cannot recover.
  it("is never zero, so a retry cannot hammer the server", () => {
    const p = policy({ initialDelayMs: 1, factor: 1, maxDelayMs: 1 });
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(backoffDelay(p, attempt)).toBeGreaterThan(0);
    }
  });

  it("keeps the delay near the target when jittered", () => {
    const p = policy({ initialDelayMs: 1_000, factor: 2, maxDelayMs: 60_000, jitter: 0.2 });
    for (const random of [0, 0.5, 1]) {
      const delay = jitteredDelay(p, 1, () => random);
      // Within 20% either side of 1000ms.
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1_200);
    }
  });

  it("keeps a jittered delay under the ceiling", () => {
    const p = policy({ initialDelayMs: 1_000, factor: 2, maxDelayMs: 4_000, jitter: 0.5 });
    expect(jitteredDelay(p, 10, () => 1)).toBe(4_000);
  });

  it("spreads peers rather than letting them retry in lockstep", () => {
    const p = policy({ initialDelayMs: 1_000, jitter: 0.5 });
    const low = jitteredDelay(p, 1, () => 0);
    const high = jitteredDelay(p, 1, () => 1);
    expect(low).not.toBe(high);
  });
});

describe("defaultShouldRetry", () => {
  // Retrying a ban makes it worse; retrying a dropped packet fixes it.
  it("treats a ban as permanent", () => {
    expect(defaultShouldRetry(new ServerError(3329, "connection failed, you are banned"))).toBe(
      false,
    );
    expect(defaultShouldRetry(new ServerError(3331, "flood ban"))).toBe(false);
  });

  // The codes once listed here were wrong: 1029 and 1030 are not the password
  // refusals, and 2569 is group modify power, so a wrong password was retried.
  it("treats the real password and permission refusals as permanent", () => {
    expect(defaultShouldRetry(new ServerError(1028, "invalid server password"))).toBe(false);
    expect(defaultShouldRetry(new ServerError(781, "invalid channel password"))).toBe(false);
    expect(defaultShouldRetry(new ServerError(2568, "insufficient client permissions"))).toBe(
      false,
    );
    expect(defaultShouldRetry(new ServerError(1029, "deployment active"))).toBe(true);
  });

  // The server also refuses transiently: a reconnect made while it still holds
  // the dropped session fails with 521 until it reaps the zombie. Giving up on
  // that would mean never recovering from an ordinary drop.
  it("keeps retrying an unrecognised server error", () => {
    expect(defaultShouldRetry(new ServerError(521, "too many clones already connected"))).toBe(
      true,
    );
    expect(defaultShouldRetry(new ServerError(9999, "something else"))).toBe(true);
  });

  it("treats a transport failure as worth retrying", () => {
    expect(defaultShouldRetry(new Error("read ECONNRESET"))).toBe(true);
    expect(defaultShouldRetry(new FileTransferError("connection timeout"))).toBe(true);
  });

  it("stops once the client is connected already", () => {
    expect(defaultShouldRetry(new AlreadyConnectedError())).toBe(false);
    expect(defaultShouldRetry(new InvalidAddressError("x:0", "bad port"))).toBe(false);
  });

  it("treats no error at all as worth retrying", () => {
    // A clean close with no error is a dropped socket, not a refusal.
    expect(defaultShouldRetry(undefined)).toBe(true);
  });
});

describe("defaultBackoffPolicy", () => {
  it("cannot be changed for every client in the process", () => {
    expect(Object.isFrozen(defaultBackoffPolicy)).toBe(true);
  });
});

describe("resolveBackoffPolicy", () => {
  it("applies overrides over the defaults", () => {
    const p = resolveBackoffPolicy({ backoff: { initialDelayMs: 5_000 } });
    expect(p.initialDelayMs).toBe(5_000);
    expect(p.maxDelayMs).toBe(defaultBackoffPolicy.maxDelayMs);
  });
});
