import { describe, expect, it } from "vitest";
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
