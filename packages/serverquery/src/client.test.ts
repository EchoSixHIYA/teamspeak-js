import { describe, expect, it } from "vitest";
import {
  CommandTimeoutError,
  ErrorCode,
  NotConnectedError,
  ServerError,
  createChannel,
  listChannels,
} from "./index.js";
import { QueryClient } from "./client.js";
import type { QueryTransport } from "./transport.js";

/** A transport that records what is sent and lets the test answer. */
class FakeTransport implements QueryTransport {
  sent: string[] = [];
  onLine: ((line: string) => void) | null = null;
  onClose: ((error: Error | undefined) => void) | null = null;
  #waiters: Array<() => void> = [];

  async send(line: string): Promise<void> {
    this.sent.push(line);
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  async close(): Promise<void> {
    this.onClose?.(undefined);
  }

  /** Wait until n commands have been sent. */
  async sentCount(n: number): Promise<void> {
    while (this.sent.length < n) await new Promise<void>((r) => this.#waiters.push(r));
  }

  receive(...lines: string[]): void {
    for (const line of lines) this.onLine?.(line);
  }
}

describe("QueryClient", () => {
  it("runs the typed commands, with the rows before the error as the answer", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const channels = listChannels(client);
    await transport.sentCount(1);
    transport.receive(
      "cid=1 pid=0 channel_order=0 channel_name=Lobby|cid=2 pid=0 channel_order=1 channel_name=Two",
      "error id=0 msg=ok",
    );

    expect((await channels).map((c) => c.name)).toEqual(["Lobby", "Two"]);
    expect(transport.sent[0]).toMatch(/^channellist/);
  });

  // ServerQuery takes the password itself; the voice protocol wants the hash.
  it("sends a channel password as it is", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const created = createChannel(client, { channel_name: "Room", channel_password: "hunter2" });
    await transport.sentCount(1);
    transport.receive("cid=7", "error id=0 msg=ok");
    await created;

    expect(transport.sent[0]).toContain("channel_password=hunter2");
  });

  it("rejects with the server's error", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const answered = client.exec("channeldelete cid=9");
    await transport.sentCount(1);
    transport.receive("error id=768 msg=invalid\\schannelID");

    await expect(answered).rejects.toBeInstanceOf(ServerError);
    await expect(answered).rejects.toMatchObject({ code: ErrorCode.ChannelInvalidID });
  });

  it("sends one command at a time, in order", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const first = client.exec("first");
    const second = client.exec("second");
    await transport.sentCount(1);
    expect(transport.sent).toEqual(["first"]);

    transport.receive("a=1", "error id=0 msg=ok");
    await transport.sentCount(2);
    transport.receive("b=2", "error id=0 msg=ok");

    expect(await first).toEqual([{ a: "1" }]);
    expect(await second).toEqual([{ b: "2" }]);
  });

  // With no return_code, a late answer would otherwise be taken for the next
  // command's.
  it("discards the answer of a command that gave up waiting", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const slow = client.exec("slow", { timeout: 10 });
    await expect(slow).rejects.toBeInstanceOf(CommandTimeoutError);

    const next = client.exec("next");
    await transport.sentCount(2);
    transport.receive("late=1", "error id=0 msg=ok", "mine=1", "error id=0 msg=ok");

    expect(await next).toEqual([{ mine: "1" }]);
  });

  it("does not mistake a notification for part of an answer", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const answered = client.exec("whoami");
    await transport.sentCount(1);
    transport.receive("notifytextmessage targetmode=3 msg=hi", "client_id=1", "error id=0 msg=ok");

    expect(await answered).toEqual([{ client_id: "1" }]);
  });

  it("fails what is waiting when the connection ends", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const answered = client.exec("whoami");
    await transport.sentCount(1);
    transport.onClose?.(new Error("reset"));

    await expect(answered).rejects.toBeInstanceOf(NotConnectedError);
    await expect(client.exec("whoami")).rejects.toBeInstanceOf(NotConnectedError);
  });
});
