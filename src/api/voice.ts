/**
 * Commands only the voice protocol has.
 *
 * ServerQuery has no subscriptions — a query client hears every channel's
 * events once it registers for them — and no `channelgetdescription`, since its
 * `channelinfo` already carries the description. These run on the voice
 * client alone, which is why they take one rather than any CommandExecutor.
 */

import type { Client } from "../client.js";
import type { ChannelID } from "../command/ids.js";

/** The channel's description, which `listChannels` omits for bandwidth. */
export async function getChannelDescription(client: Client, cid: ChannelID): Promise<string> {
  const rows = await client.send({ command: "channelgetdescription", params: [["cid", cid]] });
  return rows[0]?.["channel_description"] ?? "";
}

/**
 * Subscribe to a channel: receive its clients' events and voice without
 * joining it.
 */
export async function subscribeChannel(client: Client, cid: ChannelID): Promise<void> {
  await client.send({ command: "channelsubscribe", params: [["cid", cid]] });
}

export async function unsubscribeChannel(client: Client, cid: ChannelID): Promise<void> {
  await client.send({ command: "channelunsubscribe", params: [["cid", cid]] });
}

export async function subscribeAllChannels(client: Client): Promise<void> {
  await client.send({ command: "channelsubscribeall" });
}

export async function unsubscribeAllChannels(client: Client): Promise<void> {
  await client.send({ command: "channelunsubscribeall" });
}
