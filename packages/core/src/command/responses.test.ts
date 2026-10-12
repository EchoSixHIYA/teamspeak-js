import { describe, expect, it } from "vitest";
import { responseSpec } from "./responses.js";

describe("responseSpec", () => {
  // The SDK sends privilegekeyadd and privilegekeylist; the tokenadd and
  // tokenlist aliases are gone from its API, and so is their answer shape.
  it("knows the privilege key commands, and not their old token aliases", () => {
    expect(responseSpec("privilegekeyadd")?.notifications).toEqual(["notifytokenadd"]);
    expect(responseSpec("privilegekeylist")?.notifications).toEqual(["notifytokenlist"]);
    expect(responseSpec("tokenadd")).toBeUndefined();
    expect(responseSpec("tokenlist")).toBeUndefined();
  });
});
