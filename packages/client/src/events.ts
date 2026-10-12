import type { EventMiddleware, ServerEvent } from "./types.js";
import type { CommandMiddleware } from "@honeybbq/teamspeak-core";

/**
 * Compose a chain of middlewares around a base handler.
 * Rightmost middleware wraps the base first.
 */
export function buildCommandChain(
  middlewares: CommandMiddleware[],
  base: (cmd: string) => Promise<void>,
): (cmd: string) => Promise<void> {
  let handler = base;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    handler = middlewares[i]!(handler);
  }
  return handler;
}

export function buildEventChain(
  middlewares: EventMiddleware[],
  base: (event: ServerEvent) => void,
): (event: ServerEvent) => void {
  let handler = base;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    handler = middlewares[i]!(handler);
  }
  return handler;
}
