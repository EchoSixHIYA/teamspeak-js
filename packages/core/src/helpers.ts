import { isCommandName } from "./command/parser.js";

export function parseUint64(s: string): bigint {
  if (s === "" || s === undefined) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

export function parseUint16(s: string): number {
  const v = parseInt(s, 10);
  if (isNaN(v) || v < 0 || v > 65535) return 0;
  return v;
}

export function parseInt10(s: string): number {
  const v = parseInt(s, 10);
  return isNaN(v) ? 0 : v;
}

/**
 * Expand a pipe-separated multi-row TS3 command line into individual rows.
 *
 * A named line (`notifyclientleftview a=1|a=2`) keeps its name on every row; a
 * nameless response (`cldbid=1|cldbid=2`) stays nameless. Whether the first
 * token is a name is decided by the parser's own rule — deciding it here by
 * position is how a nameless batch with no space in it went through unsplit and
 * a one-field-per-row response came back as a single row.
 */
export function splitCommandRows(line: string): string[] {
  const spaceIdx = line.indexOf(" ");
  const head = spaceIdx < 0 ? line : line.slice(0, spaceIdx);
  const name = isCommandName(head) ? head : "";
  const rest = name === "" ? line : spaceIdx < 0 ? "" : line.slice(spaceIdx + 1);

  if (!rest.includes("|")) return [line];

  const parts = rest.split("|");
  const rows: string[] = [];
  let inheritedFields = new Map<string, string>();

  for (const part of parts) {
    if (part === "") continue;

    // TeamSpeak compresses pipe-separated rows by omitting fields whose
    // values are unchanged from the previous row. This is especially
    // important for notifycliententerview, where ctid is commonly present
    // only on the first row of a batch. Keep the raw escaped tokens so the
    // command parser can still perform the single unescape pass later.
    const tokens = part.split(" ").filter(Boolean);
    const currentFields = new Set<string>();
    for (const token of tokens) currentFields.add(fieldName(token));

    const inheritedTokens: string[] = [];
    for (const [field, token] of inheritedFields) {
      if (!currentFields.has(field)) inheritedTokens.push(token);
    }

    const resolvedTokens = [...inheritedTokens, ...tokens];
    const row = resolvedTokens.join(" ");
    rows.push(name === "" ? row : `${name} ${row}`);

    inheritedFields = new Map<string, string>();
    for (const token of resolvedTokens) {
      inheritedFields.set(fieldName(token), token);
    }
  }
  return rows.length === 0 ? [line] : rows;
}

function fieldName(token: string): string {
  const equalIndex = token.indexOf("=");
  return equalIndex > 0 ? token.slice(0, equalIndex) : token;
}

/**
 * Sleep, or wake early once `cancelled` reports true.
 *
 * Polling rather than an abort signal, because the caller that cancels is a
 * flag on the client rather than a signal it hands around.
 */
export function sleep(ms: number, cancelled?: () => boolean): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(
      () => {
        if (cancelled?.() || Date.now() - started >= ms) {
          clearInterval(tick);
          resolve();
        }
      },
      Math.min(50, ms),
    );
    tick.unref?.();
  });
}
