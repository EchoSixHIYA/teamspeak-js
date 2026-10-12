import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { listClients, moveClient } from "./clients.js";
import { createdGroupID } from "./command.js";
import { deleteFile, initFileUpload, listFiles } from "./files.js";
import { listServerGroups } from "./server.js";
import type { Client } from "../client.js";
import { asChannelID, asClientID } from "../command/ids.js";

const fakeClient = () => {
  const execCommand = vi.fn().mockResolvedValue(undefined);
  const execCommandWithResponse = vi.fn().mockResolvedValue([]);
  return {
    client: { execCommand, execCommandWithResponse } as unknown as Client,
    execCommand,
    execCommandWithResponse,
  };
};

describe("password handling", () => {
  // The client protocol expects base64(sha1(password)) for channel passwords,
  // unlike raw ServerQuery. Getting this wrong is invisible until a valid
  // password is rejected with 781.
  it("hashes the channel password in clientmove", async () => {
    const { client, execCommand } = fakeClient();
    await moveClient(client, asClientID(7), asChannelID(42n), "7274");

    const digest = createHash("sha1").update("7274").digest("base64");
    expect(execCommand).toHaveBeenCalledWith(
      `clientmove clid=7 cid=42 cpw=${digest.replaceAll("/", "\\/")}`,
      10_000,
    );
  });

  it("omits cpw entirely for an open channel", async () => {
    const { client, execCommand } = fakeClient();
    await moveClient(client, asClientID(7), asChannelID(42n));

    // Not `cpw=` — an empty parameter and no parameter are different things.
    expect(execCommand).toHaveBeenCalledWith("clientmove clid=7 cid=42", 10_000);
  });

  it("hashes the password in the file transfer commands too", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    await listFiles(client, asChannelID(1), "/", "secret");

    const digest = createHash("sha1").update("secret").digest("base64");
    expect(execCommandWithResponse).toHaveBeenCalledWith(
      `ftgetfilelist cid=1 path=\\/ cpw=${digest.replaceAll("/", "\\/")}`,
      10_000,
    );
  });

  it("sends a multi-file delete as one pipe-separated parameter", async () => {
    const { client, execCommand } = fakeClient();
    await deleteFile(client, asChannelID(1), ["/a", "/b"]);

    // The separator is escaped as \p, not left as a literal pipe: an unescaped
    // pipe would split this into a second parameter and the server would see a
    // parameter named "/b".
    expect(execCommand).toHaveBeenCalledWith("ftdeletefile cid=1 name=\\/a\\p\\/b cpw=", 10_000);
  });
});

describe("parameter encoding", () => {
  it("encodes booleans as 0 and 1", async () => {
    const { client, execCommand } = fakeClient();
    const { deleteChannel } = await import("./channels.js");
    await deleteChannel(client, asChannelID(5), true);
    expect(execCommand).toHaveBeenCalledWith("channeldelete cid=5 force=1", 10_000);

    await deleteChannel(client, asChannelID(5), false);
    expect(execCommand).toHaveBeenCalledWith("channeldelete cid=5 force=0", 10_000);
  });

  it("escapes values that would otherwise split the command", async () => {
    const { client, execCommand } = fakeClient();
    const { pokeClient } = await import("./clients.js");
    // A space, a pipe and a backslash are all parameter separators on the wire.
    await pokeClient(client, asClientID(3), "a b|c\\d");

    const call = execCommand.mock.calls[0]?.[0] as string;
    expect(call).toContain("msg=a\\sb\\pc\\\\d");
  });
});

describe("flags", () => {
  // `-uid` is a switch. The voice protocol also accepts `-uid=1`, but that is
  // not the documented form, and ServerQuery is not promised to.
  it("sends a flag bare", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    await listClients(client, { away: true });

    expect(execCommandWithResponse).toHaveBeenCalledWith("clientlist -uid -away", 10_000);
  });
});

describe("string fields", () => {
  // The parser unescapes once. A second pass turned a real `\s` into a space.
  it("returns the parsed value unchanged", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    execCommandWithResponse.mockResolvedValue([{ sgid: "9", name: "C:\\stuff" }]);
    const [group] = await listServerGroups(client);

    expect(group?.name).toBe("C:\\stuff");
  });
});

describe("createdGroupID", () => {
  // The voice protocol answers servergroupadd with the whole list; the first
  // row is whatever group the server lists first.
  it("finds the new group by name in a full list", () => {
    const rows = [
      { sgid: "1", name: "Guest Server Query" },
      { sgid: "6", name: "Server Admin" },
      { sgid: "12", name: "bots" },
    ];
    expect(createdGroupID(rows, "sgid", "bots")).toBe(12n);
  });

  it("takes the newest when a name repeats", () => {
    const rows = [
      { sgid: "4", name: "bots" },
      { sgid: "12", name: "bots" },
    ];
    expect(createdGroupID(rows, "sgid", "bots")).toBe(12n);
  });

  it("reads a bare id, which is how ServerQuery answers", () => {
    expect(createdGroupID([{ sgid: "12" }], "sgid", "bots")).toBe(12n);
  });

  it("throws rather than returning another group's id", () => {
    expect(() => createdGroupID([{ sgid: "1", name: "Guest" }], "sgid", "bots")).toThrow();
  });
});

describe("file transfer negotiation", () => {
  // The answer arrives after the command returns and is matched only by the
  // echoed clientftfid, so two negotiations must not share one.
  it("gives each negotiation its own clientftfid", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    await initFileUpload(client, asChannelID(1n), "/a", 3n);
    await initFileUpload(client, asChannelID(1n), "/b", 3n);

    const ids = execCommandWithResponse.mock.calls.map(
      ([cmd]) => /clientftfid=(\d+)/.exec(String(cmd))?.[1],
    );
    expect(ids[0]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("returns what the upload answer carries", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    execCommandWithResponse.mockResolvedValue([
      { clientftfid: "1", serverftfid: "2", ftkey: "key", port: "30033", seekpos: "0" },
    ]);
    const info = await initFileUpload(client, asChannelID(1n), "/a", 3n);

    expect(info).toEqual({
      fileTransferKey: "key",
      port: 30033,
      seekPosition: 0n,
      clientFileTransferID: 1,
      serverFileTransferID: 2,
    });
  });
});
