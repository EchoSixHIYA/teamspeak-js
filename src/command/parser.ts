import { unescape } from "./command.js";
import type { Command } from "./command.js";

export function parseCommand(s: string): Command | null {
  if (s === "") return null;

  // Skip leading non-printable bytes (< 0x20 or > 0x7E)
  let startIndex = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 32 && code <= 126) {
      startIndex = i;
      break;
    }
  }
  if (startIndex > 0) {
    s = s.slice(startIndex);
  }

  const parts = s.split(" ");
  if (parts.length === 0) return null;

  // TeamSpeak leaves the command name off response rows. A clientlist reply is
  // "clid=6 cid=2 ..." and a rejection is "-1 id=2 ...", so the first token is
  // a name only when it is neither a key=value pair nor a leading-'-' flag.
  // Deciding that here keeps every consumer from having to re-inspect `name`
  // for an '=' it was never told about.
  const first = parts[0] ?? "";
  if (first === "") return null;

  const params: Record<string, string> = {};
  let name = "";
  let start = 0;

  if (first.startsWith("-")) {
    // Negative feedback: "-<cmdId> <error>". The id is the command being
    // rejected, so the rest of the line carries the error, not this one.
    params["flag"] = first.slice(1);
    start = 1;
  } else if (first.includes("=")) {
    // A response row — the whole line is data, so parse from the first token.
    start = 0;
  } else {
    name = first;
    start = 1;
  }

  for (let i = start; i < parts.length; i++) {
    const p = parts[i];
    if (p === undefined || p === "") continue;
    const eqIdx = p.indexOf("=");
    if (eqIdx >= 0) {
      params[unescape(p.slice(0, eqIdx))] = unescape(p.slice(eqIdx + 1));
    } else {
      params[unescape(p)] = "";
    }
  }

  return { name, params };
}
