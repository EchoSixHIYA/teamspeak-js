import { describe, expect, it } from "vitest";
import {
  applyChannelNotification,
  cloneDirectorySnapshot,
  parseDirectoryChannel,
  parseDirectoryClient,
} from "./directory.js";

describe("directory parsing", () => {
  it("keeps values already decoded by the command parser unchanged", () => {
    expect(
      parseDirectoryChannel({
        cid: "42",
        pid: "1",
        channel_name: "Lobby Room",
        channel_topic: "A|B",
      }),
    ).toEqual({
      id: 42n,
      parentID: 1n,
      name: "Lobby Room",
      description: "A|B",
    });
  });

  it("parses extended client state from channelclientlist", () => {
    expect(
      parseDirectoryClient({
        clid: "7",
        cid: "42",
        client_nickname: "Alice",
        client_unique_identifier: "uid",
        client_servergroups: "6,9",
        client_type: "0",
        client_away: "1",
        client_away_message: "busy",
        client_input_muted: "1",
        client_output_muted: "0",
        client_is_channel_commander: "1",
      }),
    ).toEqual({
      id: 7,
      nickname: "Alice",
      uid: "uid",
      channelID: 42n,
      type: 0,
      serverGroups: ["6", "9"],
      away: true,
      awayMessage: "busy",
      inputMuted: true,
      outputMuted: false,
      channelCommander: true,
    });
  });

  it("updates the channel map from channel notifications", () => {
    const channels = new Map([
      [
        1n,
        {
          id: 1n,
          parentID: 0n,
          name: "Lobby",
          description: "old",
        },
      ],
    ]);

    expect(
      applyChannelNotification(
        "notifychanneledited",
        {
          cid: "1",
          channel_name: "New Lobby",
          channel_topic: "new",
        },
        channels,
      ),
    ).toBe(true);
    expect(channels.get(1n)).toEqual({
      id: 1n,
      parentID: 0n,
      name: "New Lobby",
      description: "new",
    });

    expect(applyChannelNotification("notifychanneldeleted", { cid: "1" }, channels)).toBe(true);
    expect(channels.size).toBe(0);
  });

  it("clones snapshots so consumers cannot mutate SDK state", () => {
    const clients = new Map([
      [
        7,
        {
          id: 7,
          nickname: "Alice",
          uid: "uid",
          channelID: 1n,
          type: 0,
          serverGroups: ["6"],
        },
      ],
    ]);
    const snapshot = cloneDirectorySnapshot(new Map(), clients);

    snapshot.clients[0]!.serverGroups.push("9");
    expect(clients.get(7)!.serverGroups).toEqual(["6"]);
  });
});
