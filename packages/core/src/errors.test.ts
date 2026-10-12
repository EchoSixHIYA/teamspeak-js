import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "./errorcode.js";
import { ServerError, parseServerError } from "./errors.js";

describe("parseServerError", () => {
  it("reads the code and the refusal's details", () => {
    const { err, rc } = parseServerError({
      id: "2568",
      msg: "insufficient client permissions",
      failed_permid: "236",
      extra_msg: "detail",
      return_code: "7",
    });
    expect(err).toBeInstanceOf(ServerError);
    expect(err?.code).toBe(ErrorCode.PermissionsClientInsufficient);
    expect(err?.failedPermissionID).toBe(236);
    expect(err?.extraMessage).toBe("detail");
    expect(rc).toBe(7);
  });

  it("treats id=0 as success", () => {
    expect(parseServerError({ id: "0", msg: "ok" }).err).toBeNull();
  });

  // An error line that does not say what went wrong has still not said that
  // nothing did.
  it("reports an error line without an id as Undefined", () => {
    expect(parseServerError({ msg: "no id" }).err?.code).toBe(ErrorCode.Undefined);
  });
});

describe("instanceof across copies of the package", () => {
  it("matches by kind, up the chain, and only with the brand", async () => {
    const core = await import("./errors.js");
    // A second installed copy: the same module, loaded again.
    vi.resetModules();
    const other = await import("./errors.js");
    expect(other.ServerError).not.toBe(core.ServerError);

    const refused = new other.ServerError(1, "x");
    expect(refused instanceof core.ServerError).toBe(true);
    expect(refused instanceof core.TeamspeakError).toBe(true);
    expect(refused instanceof core.NotConnectedError).toBe(false);
    expect(new core.NotConnectedError() instanceof other.NotConnectedError).toBe(true);

    class ServerError extends Error {}
    expect(new ServerError() instanceof core.ServerError).toBe(false);
    expect((null as unknown as object) instanceof core.TeamspeakError).toBe(false);
  });
});

describe("exported tables", () => {
  it("are frozen, so no caller can change them for every other", async () => {
    const core = await import("../src/index.js");
    for (const table of [
      core.ErrorCode,
      core.Reason,
      core.Codec,
      core.GroupType,
      core.noopLogger,
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
    }
    expect(() => {
      (core.ErrorCode as { OK: number }).OK = 5;
    }).toThrow(TypeError);
  });
});
