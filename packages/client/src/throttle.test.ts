import { describe, it, expect, vi } from "vitest";
import { CommandThrottle } from "./throttle.js";

describe("CommandThrottle", () => {
  it("allows immediate calls when tokens are available", async () => {
    const t = new CommandThrottle();
    const start = Date.now();
    await t.wait();
    await t.wait();
    await t.wait();
    await t.wait();
    await t.wait();
    // 5 calls should succeed instantly (initial tokens = 5)
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("throttles when bucket is exhausted", async () => {
    const t = new CommandThrottle();
    // Exhaust initial 5 tokens
    for (let i = 0; i < 5; i++) await t.wait();
    const start = Date.now();
    // One more token should require ~250ms at rate 4/s
    await t.wait();
    expect(Date.now() - start).toBeGreaterThan(50);
  });

  it("respects AbortSignal", async () => {
    const t = new CommandThrottle();
    // Exhaust tokens
    for (let i = 0; i < 5; i++) await t.wait();

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("aborted")), 50);

    await expect(t.wait(controller.signal)).rejects.toThrow("aborted");
  });

  // Each waiter used to poll on its own timer, so a later one could take the
  // turn of one that had waited longer.
  it("releases waiters in the order they arrived", async () => {
    vi.useFakeTimers();
    try {
      const t = new CommandThrottle();
      const order: number[] = [];
      const waits: Promise<void>[] = [];
      for (let i = 0; i < 12; i++) waits.push(t.wait().then(() => void order.push(i)));
      // A token is due at 250 ms, and the sleepers woke 10 ms after it.
      await vi.advanceTimersByTimeAsync(255);
      for (let i = 12; i < 14; i++) waits.push(t.wait().then(() => void order.push(i)));
      const aborted = new AbortController();
      const givenUp = expect(t.wait(aborted.signal)).rejects.toThrow("gave up");
      aborted.abort(new Error("gave up"));
      waits.push(t.wait().then(() => void order.push(14)));
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(waits);

      expect(order).toEqual([...Array(15).keys()]);
      await givenUp;
    } finally {
      vi.useRealTimers();
    }
  });
});
