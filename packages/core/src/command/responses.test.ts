import { describe, expect, it } from "vitest";
import { CommandName } from "../command-name.js";
import { NotificationName } from "../notification-name.js";
import { RESPONSES, responseSpec } from "./responses.js";

describe("responseSpec", () => {
  // The SDK sends privilegekeyadd and privilegekeylist; the tokenadd and
  // tokenlist aliases are gone from its API, and so is their answer shape.
  it("knows the privilege key commands, and not their old token aliases", () => {
    expect(responseSpec("privilegekeyadd")?.notifications).toEqual(["notifytokenadd"]);
    expect(responseSpec("privilegekeylist")?.notifications).toEqual(["notifytokenlist"]);
    expect(responseSpec("tokenadd")).toBeUndefined();
    expect(responseSpec("tokenlist")).toBeUndefined();
  });
});

describe("RESPONSES", () => {
  // Every name the table keys on or waits for is one the name tables know, so
  // a typo here cannot go unnoticed.
  it("uses only names CommandName and NotificationName list", () => {
    const commands = new Set<string>(Object.values(CommandName));
    const notifications = new Set<string>(Object.values(NotificationName));
    for (const [command, spec] of Object.entries(RESPONSES)) {
      expect(commands.has(command), command).toBe(true);
      const answers = [
        ...(spec.notifications ?? []),
        ...(spec.correlated?.notifications ?? []),
        ...(spec.correlated?.failure ? [spec.correlated.failure] : []),
      ];
      for (const name of answers) expect(notifications.has(name), name).toBe(true);
    }
  });
});
