import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createChannel, editChannel, addChannelPermission, listChannels } from "./channels.js";
import {
  iterateClientDatabase,
  kickClient,
  listClientPermissions,
  listClients,
  moveClient,
  updateClient,
} from "./clients.js";
import type { KickReason } from "./clients.js";
import {
  createdGroupID,
  date,
  durationMs,
  encodeFields,
  permissionParam,
  toWireDuration,
  MILLISECOND,
  SECOND,
} from "./command.js";
import type { WireNames } from "./command.js";
import { deleteFile, getFileInfo, initFileUpload, listFiles } from "./files.js";
import { addPrivilegeKey, getPermissionOverview, listPrivilegeKeys } from "./groups.js";
import type { PrivilegeKeyOptions } from "./groups.js";
import { addBan, banClient, listBans, sendChannelMessage, viewLog } from "./moderation.js";
import { addTempPassword, listServerGroups } from "./server.js";
import {
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asClientID,
  asPermissionID,
  asServerGroupID,
  asUID,
} from "../command/ids.js";
import { encodeRequest } from "../command/request.js";
import type { CommandExecutor, CommandOptions, CommandRequest } from "../command/request.js";
import { Codec } from "../enums.js";
import { ErrorCode } from "../errorcode.js";
import { ServerError } from "../errors.js";
import { permissionByID, permissionByName } from "../permission.js";
import { Reason } from "../reason.js";

/**
 * An executor that encodes each request the way the voice client does and
 * records the result, so the assertions below read as what goes on the wire.
 * `execCommand` and `execCommandWithResponse` are the same recorder; the two
 * names keep the assertions readable for commands with and without data.
 */
/**
 * The voice protocol's password rule, base64(sha1(password)), so the wire forms
 * below are what the voice client sends.
 */
const voicePassword = (password: string): string =>
  createHash("sha1").update(password).digest("base64");

const fakeClient = () => {
  const execCommandWithResponse = vi
    .fn<(cmd: string, timeoutMs: number) => Promise<Record<string, string>[]>>()
    .mockResolvedValue([]);
  const client: CommandExecutor = {
    send: (request) => execCommandWithResponse(encodeRequest(request, voicePassword), 10_000),
  };
  return { client, execCommand: execCommandWithResponse, execCommandWithResponse };
};

describe("password handling", () => {
  // The client protocol expects base64(sha1(password)) for channel passwords,
  // unlike raw ServerQuery. Getting this wrong is invisible until a valid
  // password is rejected with 781.
  it("hashes the channel password in clientmove", async () => {
    const { client, execCommand } = fakeClient();
    await moveClient(client, asClientID(7), asChannelID(42n), { password: "7274" });

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
    await listFiles(client, asChannelID(1), "/", { password: "secret" });

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
    await deleteChannel(client, asChannelID(5), { force: true });
    expect(execCommand).toHaveBeenCalledWith("channeldelete cid=5 force=1", 10_000);

    await deleteChannel(client, asChannelID(5));
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

/**
 * An executor that records each request's wire form and the options it was
 * sent with, answering from a queue of row sets or errors.
 */
const recordingClient = (...answers: Array<Record<string, string>[] | Error>) => {
  const sent: string[] = [];
  const options: Array<CommandOptions | undefined> = [];
  const client: CommandExecutor = {
    send: async (request: CommandRequest, commandOptions?: CommandOptions) => {
      sent.push(encodeRequest(request, voicePassword));
      options.push(commandOptions);
      const answer = answers.shift() ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { client, sent, options };
};

const emptyResult = (): ServerError =>
  new ServerError(ErrorCode.DatabaseEmptyResult, "database empty result set");

describe("field tables", () => {
  interface Sample {
    readonly name?: string | undefined;
    readonly count?: number | undefined;
    readonly delayMs?: number | undefined;
  }
  const names: WireNames<Sample> = {
    name: "sample_name",
    count: "sample_count",
    delayMs: ["sample_delay", (ms) => toWireDuration(ms, SECOND)],
  };

  it("must name every field", () => {
    // @ts-expect-error: a field without a wire name does not compile.
    const missing: WireNames<Sample> = { name: "a", count: "b" };
    expect(missing).toBeDefined();
  });

  it("sends the fields that are set, under their wire names, in table order", () => {
    expect(encodeFields({ delayMs: 1500, name: "x", count: 3 }, names)).toEqual([
      ["sample_name", "x"],
      ["sample_count", 3],
      ["sample_delay", 2],
    ]);
  });

  it("omits an unset field and sends an empty string as empty", () => {
    expect(encodeFields({ name: "", count: undefined }, names)).toEqual([["sample_name", ""]]);
  });

  // A JavaScript caller can put anything in an options object. The table, not
  // the object, decides what reaches the wire.
  it("ignores a key the table does not name", () => {
    const options = { name: "x", channel_password: "oops" } as Sample;
    expect(encodeFields(options, names)).toEqual([["sample_name", "x"]]);
  });

  it("does that for the real commands too", async () => {
    const { client, sent } = recordingClient([{ cid: "7" }]);
    await createChannel(client, {
      name: "Room",
      topic: "",
      codec: Codec.OpusVoice,
      deleteDelayMs: 30_000,
      channel_flag_default: true,
    } as Parameters<typeof createChannel>[1]);

    expect(sent[0]).toBe(
      "channelcreate channel_name=Room channel_topic= channel_codec=4 channel_delete_delay=30",
    );
  });

  it("clears a password with an empty string, and leaves it alone when unset", async () => {
    const { client, sent } = recordingClient();
    await editChannel(client, asChannelID(3), { password: "" });
    await editChannel(client, asChannelID(3), { name: "n" });

    expect(sent).toEqual([
      "channeledit cid=3 channel_password=",
      "channeledit cid=3 channel_name=n",
    ]);
  });

  it("names our own client state in camelCase", async () => {
    const { client, sent } = recordingClient();
    await updateClient(client, { nickname: "bot", isAway: true, awayMessage: "" });

    expect(sent[0]).toBe("clientupdate client_nickname=bot client_away=1 client_away_message=");
  });
});

describe("Permission", () => {
  it("is sent as permid or permsid, whichever names it", async () => {
    const { client, sent } = recordingClient();
    await addChannelPermission(client, asChannelID(1), permissionByID(asPermissionID(86)), 50);
    await addChannelPermission(client, asChannelID(1), permissionByName("i_icon_id"), 50);

    expect(sent).toEqual([
      "channeladdperm cid=1 permid=86 permvalue=50",
      "channeladdperm cid=1 permsid=i_icon_id permvalue=50",
    ]);
  });

  it("refuses a permission naming nothing rather than sending neither", () => {
    expect(() => permissionParam({} as never)).toThrow(TypeError);
    expect(() => permissionParam(permissionByName(""))).toThrow(TypeError);
  });

  it("is read back in the form the server sent it", async () => {
    const { client } = recordingClient([
      { permid: "86", permvalue: "50", permnegated: "0", permskip: "1" },
      { permsid: "i_icon_id", permvalue: "-1" },
    ]);
    const entries = await listClientPermissions(client, asClientDBID(1));

    expect(entries).toEqual([
      { permission: { id: 86 }, value: 50, negated: false, skip: true },
      { permission: { name: "i_icon_id" }, value: -1, negated: false, skip: false },
    ]);
  });

  it("asks permoverview for every permission, since it needs one", async () => {
    const { client, sent } = recordingClient([
      { t: "0", id1: "8", id2: "0", p: "25", v: "1", n: "0", s: "0" },
    ]);
    const [entry] = await getPermissionOverview(client, asChannelID(1), asClientDBID(3));

    expect(sent[0]).toBe("permoverview cid=1 cldbid=3 permid=0");
    expect(entry).toEqual({
      target: 0,
      id1: 8n,
      id2: 0n,
      permission: 25,
      value: 1,
      negated: false,
      skip: false,
    });
  });
});

describe("timestamps and durations", () => {
  const at = (raw: string): Date | undefined => date({ t: raw }, "t");

  it("reads 0, absence and garbage as no time, never 1970", () => {
    expect(at("0")).toBeUndefined();
    expect(at("-5")).toBeUndefined();
    expect(at("soon")).toBeUndefined();
    expect(date({}, "t")).toBeUndefined();
  });

  // TS6 sends some times in finer units than TS3's seconds; the magnitude
  // tells them apart.
  it("reads seconds, milliseconds, microseconds and nanoseconds as the same time", () => {
    const when = new Date("2026-10-12T03:35:46Z");
    const seconds = when.getTime() / 1000;
    for (const raw of [
      String(seconds),
      String(seconds * 1000),
      `${seconds * 1000}000`,
      `${seconds * 1000}000000`,
    ]) {
      expect(at(raw)).toEqual(when);
    }
  });

  it("reads a duration in the field's own unit", () => {
    expect(durationMs({ d: "60" }, "d", SECOND)).toBe(60_000);
    expect(durationMs({ d: "250" }, "d", MILLISECOND)).toBe(250);
    expect(durationMs({}, "d", SECOND)).toBe(0);
  });

  it("rounds a duration to the wire unit, never down to 0", () => {
    expect(toWireDuration(1499, SECOND)).toBe(1);
    expect(toWireDuration(1500, SECOND)).toBe(2);
    expect(toWireDuration(0, SECOND)).toBe(0);
    // 0 is "forever" for a ban, so a short ban must not round to it.
    expect(toWireDuration(1, SECOND)).toBe(1);
    expect(() => toWireDuration(-1, SECOND)).toThrow(RangeError);
    expect(() => toWireDuration(Number.NaN, SECOND)).toThrow(RangeError);
  });

  it("parses result rows into Dates and milliseconds", async () => {
    const { client } = recordingClient([
      { banid: "10", name: "probe", created: "1791776586", duration: "60" },
    ]);
    const [ban] = await listBans(client);

    expect(ban?.createdAt).toEqual(new Date(1_791_776_586_000));
    expect(ban?.durationMs).toBe(60_000);
  });
});

describe("bans", () => {
  it("sends a permanent ban without a time, and a short one as a second", async () => {
    const { client, sent } = recordingClient();
    await banClient(client, asClientID(5));
    await banClient(client, asClientID(5), { durationMs: 200, reason: "" });

    expect(sent).toEqual(["banclient clid=5", "banclient clid=5 time=1"]);
  });

  it("refuses a ban that matches nothing, and never sends an empty pattern", async () => {
    const { client, sent } = recordingClient();
    await expect(addBan(client, { ip: "", reason: "x" })).rejects.toThrow(TypeError);
    await addBan(client, { name: "troll", ip: "", uid: asUID(""), durationMs: 60_000 });

    expect(sent).toEqual(["banadd name=troll time=60"]);
  });

  // The voice protocol reports no ban id.
  it("returns undefined when the server reports no id", async () => {
    const { client } = recordingClient([], [{ banid: "11" }]);
    expect(await banClient(client, asClientID(5))).toBeUndefined();
    expect(await banClient(client, asClientID(5))).toBe(11n);
  });
});

describe("kicks", () => {
  it("sends the reason, and no message for an empty one", async () => {
    const { client, sent } = recordingClient();
    await kickClient(client, asClientID(4), Reason.KickServer, { reasonMessage: "bye" });
    await kickClient(client, asClientID(4), Reason.KickChannel, { reasonMessage: "" });

    expect(sent).toEqual([
      "clientkick clid=4 reasonid=5 reasonmsg=bye",
      "clientkick clid=4 reasonid=4",
    ]);
  });

  it("refuses a reason that is not a kick", async () => {
    const { client, sent } = recordingClient();
    // @ts-expect-error: only the two kick reasons compile.
    const ban: KickReason = Reason.KickServerBan;
    expect(ban).toBe(6);
    await expect(
      kickClient(client, asClientID(4), Reason.KickServerBan as unknown as KickReason),
    ).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
  });
});

describe("privilege keys", () => {
  it("encodes the group as tokenid1 and the channel as tokenid2", async () => {
    const { client, sent } = recordingClient([{ token: "a" }], [{ token: "b" }]);
    await addPrivilegeKey(client, { serverGroupID: asServerGroupID(6), description: "" });
    await addPrivilegeKey(client, {
      channelGroupID: asChannelGroupID(5),
      channelID: asChannelID(2),
      description: "mod",
    });

    expect(sent).toEqual([
      "privilegekeyadd tokentype=0 tokenid1=6 tokenid2=0",
      "privilegekeyadd tokentype=1 tokenid1=5 tokenid2=2 tokendescription=mod",
    ]);
  });

  it("refuses a key that is both kinds, or neither", async () => {
    const { client, sent } = recordingClient();
    const both = {
      serverGroupID: asServerGroupID(6),
      channelGroupID: asChannelGroupID(5),
      channelID: asChannelID(2),
    } as unknown as PrivilegeKeyOptions;
    await expect(addPrivilegeKey(client, both)).rejects.toThrow(TypeError);
    await expect(addPrivilegeKey(client, {} as PrivilegeKeyOptions)).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("reads each id into the field its token type gives it", async () => {
    const { client } = recordingClient([
      { token: "a", token_type: "0", token_id1: "6", token_id2: "0", token_created: "0" },
      { token: "b", token_type: "1", token_id1: "5", token_id2: "2", token_created: "1791764164" },
    ]);
    const [server, channel] = await listPrivilegeKeys(client);

    expect(server).toMatchObject({
      serverGroupID: 6n,
      channelGroupID: undefined,
      createdAt: undefined,
    });
    expect(channel).toMatchObject({ serverGroupID: undefined, channelGroupID: 5n, channelID: 2n });
    expect(channel?.createdAt).toEqual(new Date(1_791_764_164_000));
  });
});

describe("other fixes", () => {
  // Each log line is its own row, keyed l; the first row also carries the
  // positions.
  it("reads every log line", async () => {
    const { client, sent } = recordingClient([
      { last_pos: "14982", file_size: "15302", l: "first" },
      { l: "second" },
    ]);
    const page = await viewLog(client, { lines: 2, reverse: true, beginPosition: 0 });

    expect(sent[0]).toBe("logview lines=2 reverse=1 begin_pos=0");
    expect(page).toEqual({ lines: ["first", "second"], lastPosition: 14982, fileSize: 15302 });
  });

  it("sends the caller's temporary password rather than an empty one", async () => {
    const { client, sent } = recordingClient();
    await addTempPassword(client, { password: "pw", description: "d", durationMs: 60_000 });
    await expect(
      addTempPassword(client, { password: "", description: "d", durationMs: 1 }),
    ).rejects.toThrow(TypeError);

    expect(sent).toEqual(["servertemppasswordadd pw=pw desc=d duration=60 tcid=0 tcpw="]);
  });

  it("names no channel in a channel message, since the server ignores one", async () => {
    const { client, sent } = recordingClient();
    await sendChannelMessage(client, "hi");
    expect(sent[0]).toBe("sendtextmessage targetmode=2 msg=hi");
  });

  it("tells directories from files, and reads TS6 times", async () => {
    const { client } = recordingClient(
      [
        { name: "dir", size: "0", datetime: "1791764662000", type: "0" },
        { name: "a.txt", size: "3", datetime: "1791768571000", type: "1" },
      ],
      [{ name: "/a.txt", size: "3", datetime: "1791768571000000000" }],
    );
    const [dir, file] = await listFiles(client, asChannelID(1), "/");
    const info = await getFileInfo(client, asChannelID(1), "/a.txt");

    expect(dir?.isDirectory).toBe(true);
    expect(file?.isDirectory).toBe(false);
    expect(info.modifiedAt).toEqual(file?.modifiedAt);
  });

  it("reads icon ids and channel order with their types", async () => {
    const { client } = recordingClient([
      { cid: "2", channel_order: "1", channel_icon_id: "-1528016466" },
      { cid: "3", channel_order: "2", channel_icon_id: "0" },
    ]);
    const [first, second] = await listChannels(client);

    expect(first?.order).toBe(1n);
    expect(first?.iconID).toBe(2766950830);
    expect(second?.iconID).toBeUndefined();
  });

  it("reads an empty list as empty, not as a refusal", async () => {
    const { client } = recordingClient(emptyResult());
    expect(await listBans(client)).toEqual([]);
  });
});

describe("iterateClientDatabase", () => {
  const page = (...ids: number[]): Record<string, string>[] =>
    ids.map((id) => ({ cldbid: String(id), client_nickname: `c${id}` }));

  const collect = async (iterable: AsyncIterable<{ databaseID: bigint }>): Promise<bigint[]> => {
    const ids: bigint[] = [];
    for await (const entry of iterable) ids.push(entry.databaseID);
    return ids;
  };

  it("walks pages until the server reports 1281", async () => {
    const { client, sent } = recordingClient(page(1, 2), page(3, 4), emptyResult());
    expect(await collect(iterateClientDatabase(client, { pageSize: 2 }))).toEqual([1n, 2n, 3n, 4n]);
    expect(sent).toEqual([
      "clientdblist start=0 duration=2",
      "clientdblist start=2 duration=2",
      "clientdblist start=4 duration=2",
    ]);
  });

  it("stops on a page shorter than an earlier one", async () => {
    const { client, sent } = recordingClient(page(1, 2, 3), page(4));
    expect(await collect(iterateClientDatabase(client, { pageSize: 3 }))).toEqual([1n, 2n, 3n, 4n]);
    expect(sent).toHaveLength(2);
  });

  // The server may cap a page below the size asked for, so a short first page
  // is not yet the end.
  it("asks again after a short first page", async () => {
    const { client, sent } = recordingClient(page(1, 2), page(3, 4), page(5));
    expect(await collect(iterateClientDatabase(client))).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(sent).toEqual([
      "clientdblist start=0 duration=100",
      "clientdblist start=2 duration=100",
      "clientdblist start=4 duration=100",
    ]);
  });

  it("stops when the server ignores start rather than looping on page one", async () => {
    const { client, sent } = recordingClient(page(1, 2), page(1, 2));
    expect(await collect(iterateClientDatabase(client, { pageSize: 2 }))).toEqual([1n, 2n]);
    expect(sent).toHaveLength(2);
  });

  it("throws any other error from the loop", async () => {
    const refusal = new ServerError(ErrorCode.PermissionsClientInsufficient, "insufficient");
    const { client } = recordingClient(page(1, 2), refusal);
    const seen: bigint[] = [];
    await expect(
      (async () => {
        for await (const entry of iterateClientDatabase(client, { pageSize: 2 })) {
          seen.push(entry.databaseID);
        }
      })(),
    ).rejects.toBe(refusal);
    expect(seen).toEqual([1n, 2n]);
  });

  it("gives every page the signal and timeout, but not the page size", async () => {
    const { signal } = new AbortController();
    const { client, options } = recordingClient(page(1), emptyResult());
    await collect(iterateClientDatabase(client, { pageSize: 5, signal, timeout: 1234 }));

    expect(options).toEqual([
      { signal, timeout: 1234 },
      { signal, timeout: 1234 },
    ]);
  });
});

describe("CommandOptions", () => {
  it("reaches send as its signal and timeout", async () => {
    const { signal } = new AbortController();
    const commandOptions = { signal, timeout: 500 };
    const { client, options } = recordingClient();

    await listChannels(client, commandOptions);
    await moveClient(client, asClientID(1), asChannelID(2), { password: "pw", ...commandOptions });
    await createChannel(client, { name: "x" }, commandOptions);
    await listFiles(client, asChannelID(1), "/", { password: "", ...commandOptions });

    // The executor sees the signal and timeout, never a command's own options.
    expect(options).toEqual([commandOptions, commandOptions, commandOptions, commandOptions]);
  });

  it("is undefined when the caller passes none", async () => {
    const { client, options } = recordingClient();
    await listChannels(client);
    expect(options).toEqual([undefined]);
  });
});
