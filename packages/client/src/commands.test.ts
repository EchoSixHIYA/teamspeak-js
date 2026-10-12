import { describe, expect, it } from "vitest";
import { CommandTracker, appendReturnCode } from "./commands.js";
import { responseSpec } from "@honeybbq/teamspeak-core/internal";
import { NotConnectedError, ServerError } from "@honeybbq/teamspeak-core";

/** A tracker past the welcome sequence, as it is once a session is up. */
function ready(ownClientID = 0): CommandTracker {
  const t = new CommandTracker(() => ownClientID);
  t.signalWelcomeComplete();
  return t;
}

describe("CommandTracker", () => {
  it("gives nameless rows to the command whose error follows them", async () => {
    const t = ready();
    const [rc, done] = t.register();
    t.buffer({ cid: "1" });
    t.buffer({ cid: "2" });
    t.resolve(rc, null);

    expect((await done).data).toEqual([{ cid: "1" }, { cid: "2" }]);
  });

  // The server answers in order, so the rows before error 1 are command 1's —
  // whatever order the two were registered in. The Go client used to hand
  // them to the newest pending command instead.
  it("keeps two in-flight answers apart", async () => {
    const t = ready();
    const [first, firstDone] = t.register();
    const [second, secondDone] = t.register();

    t.buffer({ cid: "1" });
    t.resolve(first, null);
    t.buffer({ clid: "7" });
    t.resolve(second, null);

    expect((await firstDone).data).toEqual([{ cid: "1" }]);
    expect((await secondDone).data).toEqual([{ clid: "7" }]);
  });

  it("takes a declared notification as the command's data", async () => {
    const t = ready();
    const [rc, done] = t.register(responseSpec("servergrouplist"));
    t.buffer({ sgid: "6", name: "Server Admin" }, "notifyservergrouplist");
    t.resolve(rc, null);

    expect((await done).data).toEqual([{ sgid: "6", name: "Server Admin" }]);
  });

  // An event that happens to arrive between a command and its answer is not
  // the answer.
  it("leaves undeclared notifications out", async () => {
    const t = ready();
    const [rc, done] = t.register(responseSpec("servergrouplist"));
    t.buffer({ clid: "3", ctid: "2" }, "notifyclientmoved");
    t.resolve(rc, null);

    expect((await done).data).toEqual([]);
  });

  it("keeps only the rows this client invoked when the spec says so", async () => {
    const t = ready(5);
    const [rc, done] = t.register(responseSpec("channelcreate"));
    t.buffer({ cid: "8", invokerid: "9" }, "notifychannelcreated");
    t.buffer({ cid: "9", invokerid: "5" }, "notifychannelcreated");
    t.resolve(rc, null);

    expect((await done).data).toEqual([{ cid: "9", invokerid: "5" }]);
  });

  it("drops rows sent before the welcome sequence ends", async () => {
    const t = new CommandTracker();
    const [rc, done] = t.register();
    t.buffer({ cid: "0" });
    t.resolve(rc, null);

    expect((await done).data).toEqual([]);
  });

  describe("answers that follow the error", () => {
    const upload = responseSpec("ftinitupload");

    it("waits for the answer the error promised", async () => {
      const t = ready();
      const [rc, done] = t.register(upload, "4");
      let settled = false;
      void done.then(() => (settled = true));

      t.resolve(rc, null);
      await Promise.resolve();
      expect(settled).toBe(false);

      t.offerCorrelated("notifystartupload", { clientftfid: "4", ftkey: "k", port: "30033" });
      expect((await done).data).toEqual([{ clientftfid: "4", ftkey: "k", port: "30033" }]);
    });

    it("accepts the answer when it beats the error", async () => {
      const t = ready();
      const [rc, done] = t.register(upload, "4");
      t.offerCorrelated("notifystartupload", { clientftfid: "4", ftkey: "k" });
      t.resolve(rc, null);

      expect((await done).data).toEqual([{ clientftfid: "4", ftkey: "k" }]);
    });

    it("ignores an answer for another transfer", async () => {
      const t = ready();
      const [rc, done] = t.register(upload, "4");
      t.resolve(rc, null);
      t.offerCorrelated("notifystartupload", { clientftfid: "5", ftkey: "other" });
      t.offerCorrelated("notifystartupload", { clientftfid: "4", ftkey: "mine" });

      expect((await done).data).toEqual([{ clientftfid: "4", ftkey: "mine" }]);
    });

    // The voice protocol answers a refused upload with `error id=0` and then a
    // status notification; reporting that as success with no key is how the
    // refusal used to vanish.
    it("turns a failure status into a server error", async () => {
      const t = ready();
      const [rc, done] = t.register(upload, "4");
      t.resolve(rc, null);
      t.offerCorrelated("notifystatusfiletransfer", {
        clientftfid: "4",
        status: "2568",
        msg: "insufficient client permissions",
      });

      const { err } = await done;
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).id).toBe("2568");
    });
  });

  it("fails every in-flight command on reset", async () => {
    const t = ready();
    const [, first] = t.register();
    const [, second] = t.register();
    const cause = new NotConnectedError();
    t.reset(cause);

    expect((await first).err).toBe(cause);
    expect((await second).err).toBe(cause);
  });
});

describe("appendReturnCode", () => {
  it("appends the tracker's code", () => {
    expect(appendReturnCode("clientlist", 3)).toBe("clientlist return_code=3");
  });

  // A message body is escaped into one parameter, so text that merely contains
  // "return_code=" is not a return_code. It used to suppress the real one.
  it("is not fooled by a value containing the text", () => {
    expect(appendReturnCode("sendtextmessage targetmode=3 msg=see\\sreturn_code=9", 3)).toBe(
      "sendtextmessage targetmode=3 msg=see\\sreturn_code=9 return_code=3",
    );
  });

  it("refuses a command that brings its own", () => {
    expect(() => appendReturnCode("clientlist return_code=9", 3)).toThrow(TypeError);
  });
});
