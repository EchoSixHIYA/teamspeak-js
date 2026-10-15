import { describe, expect, it } from "vitest";
import { QueryClient } from "./index.js";
import {
  CommandTimeoutError,
  ErrorCode,
  NotConnectedError,
  ServerError,
  asClientDBID,
  createChannel,
  iterateClientDatabase,
  listBans,
  listChannels,
} from "@honeybbq/teamspeak";
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

    const created = createChannel(client, { name: "Room", password: "hunter2" });
    await transport.sentCount(1);
    transport.receive("cid=7", "error id=0 msg=ok");
    await created;

    expect(transport.sent[0]).toContain("channel_password=hunter2");
  });

  it("walks a paged command until the server reports the end", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const seen: bigint[] = [];
    const walk = (async () => {
      for await (const entry of iterateClientDatabase(client, { pageSize: 2 })) {
        seen.push(entry.databaseID);
      }
    })();
    await transport.sentCount(1);
    transport.receive("cldbid=1 client_nickname=a|cldbid=2 client_nickname=b", "error id=0 msg=ok");
    await transport.sentCount(2);
    transport.receive("cldbid=3 client_nickname=c|cldbid=4 client_nickname=d", "error id=0 msg=ok");
    await transport.sentCount(3);
    transport.receive("error id=1281 msg=database\\sempty\\sresult\\sset");
    await walk;

    expect(seen).toEqual([1n, 2n, 3n, 4n].map(asClientDBID));
    expect(transport.sent).toEqual([
      "clientdblist start=0 duration=2",
      "clientdblist start=2 duration=2",
      "clientdblist start=4 duration=2",
    ]);
  });

  // The server answers an empty list with 1281 rather than with no rows.
  it("reads an empty list as empty, not as a refusal", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const bans = listBans(client);
    await transport.sentCount(1);
    transport.receive("error id=1281 msg=database\\sempty\\sresult\\sset");

    expect(await bans).toEqual([]);
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

  it("logs in and selects a server with the query's own syntax", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);

    const login = client.login("serveradmin", "pa ss");
    await transport.sentCount(1);
    transport.receive("error id=0 msg=ok");
    await login;
    const used = client.use({ id: 1 }, { nickname: "probe bot" });
    await transport.sentCount(2);
    transport.receive("error id=0 msg=ok");
    await used;
    const byPort = client.use({ port: 9987 });
    await transport.sentCount(3);
    transport.receive("error id=0 msg=ok");
    await byPort;

    expect(transport.sent).toEqual([
      "login client_login_name=serveradmin client_login_password=pa\\sss",
      "use sid=1 client_nickname=probe\\sbot",
      "use port=9987",
    ]);
  });

  it("registers for a notification category", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);
    const registered = client.registerNotifications("channel", 0);
    await transport.sentCount(1);
    transport.receive("error id=0 msg=ok");
    await registered;
    expect(transport.sent).toEqual(["servernotifyregister event=channel id=0"]);
  });

  it("hands each notification row to the listeners, unescaped", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);
    const seen: unknown[] = [];
    const stop = client.onNotification((e) => seen.push(e));

    transport.receive(
      "notifycliententerview clid=5 client_nickname=a\\sb|clid=6 client_nickname=c",
      "notifytextmessage targetmode=1 msg=hi",
    );
    stop();
    transport.receive("notifytextmessage msg=ignored");

    expect(seen).toEqual([
      { name: "notifycliententerview", params: { clid: "5", client_nickname: "a b" } },
      { name: "notifycliententerview", params: { clid: "6", client_nickname: "c" } },
      { name: "notifytextmessage", params: { targetmode: "1", msg: "hi" } },
    ]);
  });

  // The voice protocol leaves out the fields a row repeats; ServerQuery never
  // does, so a row that lacks one must stay without it.
  it("does not complete a row from the row before it", async () => {
    const transport = new FakeTransport();
    const client = new QueryClient(transport);
    const answered = client.exec("x");
    await transport.sentCount(1);
    transport.receive("a=1 b=2|a=3", "error id=0 msg=ok");
    expect(await answered).toEqual([{ a: "1", b: "2" }, { a: "3" }]);
  });

  it("does not take the late answer of a slow send for the next command's", async () => {
    // A transport whose send carries the whole round trip.
    class SlowTransport extends FakeTransport {
      override async send(line: string): Promise<void> {
        this.sent.push(line);
        if (line === "slow") {
          await new Promise((r) => setTimeout(r, 30));
          this.receive("late=1", "error id=0 msg=ok");
        }
      }
    }
    const transport = new SlowTransport();
    const client = new QueryClient(transport);

    await expect(client.exec("slow", { timeout: 5 })).rejects.toBeInstanceOf(CommandTimeoutError);
    const next = client.exec("next");
    await new Promise((r) => setTimeout(r, 50));
    transport.receive("mine=1", "error id=0 msg=ok");

    expect(await next).toEqual([{ mine: "1" }]);
  });

  it("rejects with the transport's error when a send fails, and expects no answer", async () => {
    class FailingTransport extends FakeTransport {
      fail = true;
      override async send(line: string): Promise<void> {
        this.sent.push(line);
        if (this.fail) {
          this.fail = false;
          throw new Error("http 502");
        }
      }
    }
    const transport = new FailingTransport();
    const client = new QueryClient(transport);
    await expect(client.exec("a")).rejects.toThrow("http 502");
    const next = client.exec("b");
    await new Promise((r) => setTimeout(r, 10));
    transport.receive("ok=1", "error id=0 msg=ok");
    expect(await next).toEqual([{ ok: "1" }]);
  });
});
