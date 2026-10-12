import type { EventMiddleware, ServerEvent } from "./types.js";
import type { CommandExecutor, CommandMiddleware } from "@honeybbq/teamspeak-core";

/**
 * Compose a chain of middlewares around a base handler.
 * Rightmost middleware wraps the base first.
 */
export function buildCommandChain(
  middlewares: readonly CommandMiddleware[],
  base: CommandExecutor["send"],
): CommandExecutor["send"] {
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
