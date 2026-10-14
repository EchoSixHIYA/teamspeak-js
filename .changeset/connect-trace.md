---
"@honeybbq/teamspeak-client": minor
---

Add `connectTrace` to `ClientOptions`: hooks (`resolveStart`, `resolveDone`, `connectStart`, `handshakeDone`, `sessionStart`, `welcomeDone`, `attemptFailed`, `reconnectScheduled`) that are called synchronously at each milestone of every connection attempt, the reconnect loop's included, with durations in milliseconds, for timing, metrics and progress displays. Every attempt ends with exactly one of `sessionStart` and `attemptFailed`, which names the phase (`ConnectPhase`: `open`, `handshake` or `join`) the attempt failed in; a hook that throws is reported like a throwing listener and never affects the connection.
