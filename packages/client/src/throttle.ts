/**
 * Token-bucket limiter for outbound TS3 commands.
 * Mirrors Go's commandThrottle.
 */
export class CommandThrottle {
  static readonly TOKEN_RATE = 4.0; // tokens per second
  static readonly TOKEN_MAX = 8.0; // bucket capacity

  #tokens = 5.0;
  #lastUpdate = Date.now();

  /**
   * Wait for a token. Aborting `signal` rejects with its reason, and the
   * abort listener is removed however the wait ends.
   */
  async wait(signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();

      const now = Date.now();
      const elapsed = (now - this.#lastUpdate) / 1000;
      this.#tokens = Math.min(
        this.#tokens + elapsed * CommandThrottle.TOKEN_RATE,
        CommandThrottle.TOKEN_MAX,
      );
      this.#lastUpdate = now;

      if (this.#tokens >= 1.0) {
        this.#tokens -= 1.0;
        return;
      }

      const waitMs = Math.ceil(((1.0 - this.#tokens) / CommandThrottle.TOKEN_RATE) * 1000) + 10;

      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(signal!.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
