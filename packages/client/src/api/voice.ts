/**
 * Commands only the voice protocol has.
 *
 * ServerQuery has no subscriptions — a query client hears every channel's
 * events once it registers for them — and no `channelgetdescription`, since its
 * `channelinfo` already carries the description. These run on the voice
 * client alone, which is why they take one rather than any CommandExecutor.
 */

import type { Client } from "../client.js";
import type { ChannelID, CommandOptions } from "@honeybbq/teamspeak-core";

/** The channel's description, which `listChannels` omits for bandwidth. */
export async function getChannelDescription(
  client: Client,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<string> {
  const rows = await client.send(
    { command: "channelgetdescription", params: [["cid", cid]] },
    options,
  );
  return rows[0]?.["channel_description"] ?? "";
}

/**
 * Subscribe to a channel: receive its clients' events and voice without
 * joining it.
 */
export async function subscribeChannel(
  client: Client,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<void> {
  await client.send({ command: "channelsubscribe", params: [["cid", cid]] }, options);
}

/** Stop receiving a subscribed channel's events and voice. */
export async function unsubscribeChannel(
  client: Client,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<void> {
  await client.send({ command: "channelunsubscribe", params: [["cid", cid]] }, options);
}

/** Subscribe to every channel on the server. */
export async function subscribeAllChannels(
  client: Client,
  options?: CommandOptions,
): Promise<void> {
  await client.send({ command: "channelsubscribeall" }, options);
}

/** Unsubscribe from every channel on the server. */
export async function unsubscribeAllChannels(
  client: Client,
  options?: CommandOptions,
): Promise<void> {
  await client.send({ command: "channelunsubscribeall" }, options);
}
