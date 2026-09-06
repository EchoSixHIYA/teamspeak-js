import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { clientMove } from "./api.js";
import type { Client } from "./client.js";

describe("clientMove", () => {
  it("hashes channel passwords in the TeamSpeak client protocol format", async () => {
    const execCommand = vi.fn().mockResolvedValue(undefined);
    const client = { execCommand } as unknown as Client;

    await clientMove(client, 7, 42n, "test-channel-password");

    const digest = createHash("sha1").update("test-channel-password").digest("base64");
    expect(execCommand).toHaveBeenCalledWith(`clientmove clid=7 cid=42 cpw=${digest.replaceAll("/", "\\/")}`, 10_000);
  });

  it("does not send a password field for an open channel", async () => {
    const execCommand = vi.fn().mockResolvedValue(undefined);
    const client = { execCommand } as unknown as Client;

    await clientMove(client, 7, 42n);

    expect(execCommand).toHaveBeenCalledWith("clientmove clid=7 cid=42", 10_000);
  });
});
