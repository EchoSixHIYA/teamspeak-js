import { describe, it, expect } from "vitest";
import { handleNotification } from "./notifications.js";
import type { ClientEnterEvent } from "@honeybbq/teamspeak-core";

function makeClients(): Map<number, ClientEnterEvent> {
  return new Map();
}

describe("handleNotification", () => {
  describe("notifycliententerview", () => {
    it("uses ctid as the client's channel ID", () => {
      const clients = makeClients();
      const cmd = {
        name: "notifycliententerview",
        params: {
          clid: "7",
          ctid: "42",
          client_nickname: "Alice",
          client_unique_identifier: "uid123",
          client_type: "0",
          client_servergroups: "6,9",
        },
      };

      const result = handleNotification(cmd, 1, clients, "Bot");

      expect(result.kind).toBe("clientEnter");
      if (result.kind !== "clientEnter") return;
      expect(result.info.channelID).toBe(42n);
      expect(clients.get(7)?.channelID).toBe(42n);
    });
  });

  describe("notifyclientmoved", () => {
    // A channel id is 0 to 2^64-1 in plain decimal. Anything else names no
    // channel; it must not throw, which would drop the datagram's other rows.
    it.each(["-1", "18446744073709551616", "0x10", "1e3", ""])(
      "reads ctid %j as channel 0",
      (ctid) => {
        const cmd = { name: "notifyclientmoved", params: { clid: "7", ctid, reasonid: "1" } };

        const result = handleNotification(cmd, 1, makeClients(), "Bot");

        expect(result.kind).toBe("clientMoved");
        if (result.kind !== "clientMoved") return;
        expect(result.event.targetChannelID).toBe(0n);
      },
    );

    it("reads the largest channel id as itself", () => {
      const cmd = {
        name: "notifyclientmoved",
        params: { clid: "7", ctid: "18446744073709551615" },
      };

      const result = handleNotification(cmd, 1, makeClients(), "Bot");

      expect(result.kind === "clientMoved" && result.event.targetChannelID).toBe(
        18446744073709551615n,
      );
    });
  });

  describe("notifyclientpoke", () => {
    it("parses poke with message", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {
          invokerid: "5",
          invokername: "Alice",
          invokeruid: "uid123",
          msg: "hello",
        },
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.invokerID).toBe(5);
      expect(result.event.invokerName).toBe("Alice");
      expect(result.event.invokerUID).toBe("uid123");
      expect(result.event.message).toBe("hello");
    });

    it("parses poke with empty message", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {
          invokerid: "3",
          invokername: "Bob",
          invokeruid: "uid456",
          msg: "",
        },
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.message).toBe("");
      expect(result.event.invokerName).toBe("Bob");
    });

    it("handles missing fields gracefully", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {},
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.invokerID).toBe(0);
      expect(result.event.invokerName).toBe("");
      expect(result.event.invokerUID).toBe("");
      expect(result.event.message).toBe("");
    });
  });

  it("returns unknown for unrecognized notifications", () => {
    const cmd = {
      name: "notifysomethingelse",
      params: {},
    };
    const result = handleNotification(cmd, 1, makeClients(), "Bot");
    expect(result.kind).toBe("unknown");
  });

  // No client has id 0; a row naming it, or naming none, describes nobody.
  it.each(["notifycliententerview", "notifyclientleftview", "notifyclientmoved"])(
    "drops %s for clid 0",
    (name) => {
      const clients = makeClients();
      for (const params of [{ clid: "0", ctid: "1" }, { ctid: "1" }]) {
        expect(handleNotification({ name, params }, 0, clients, "Bot").kind).toBe("unknown");
      }
      expect(clients.size).toBe(0);
    },
  );
});

describe("notification names", () => {
  // handleNotification dispatches on literal names; each must be one the
  // table lists, so a typo in either is caught.
  it("lists every name handleNotification dispatches on", async () => {
    const { readFile } = await import("node:fs/promises");
    const { NotificationName } = await import("@honeybbq/teamspeak-core");
    const source = await readFile(new URL("./notifications.ts", import.meta.url), "utf8");
    const dispatched = [...source.matchAll(/case "(notify\w+)"/g)].map((m) => m[1] as string);
    expect(dispatched.length).toBeGreaterThan(0);
    const known = new Set<string>(Object.values(NotificationName));
    for (const name of dispatched) expect(known.has(name), name).toBe(true);
  });
});
