import { describe, expect, it } from "vitest";
import { asIconID, parseIconID } from "./ids.js";

describe("icon ids", () => {
  // The server sends an icon's CRC32 sometimes as a negative 32-bit number;
  // the icon file is named by the unsigned one, so both read the same.
  it("reads a signed and an unsigned id as the same unsigned value", () => {
    expect(parseIconID("-1528016466")).toBe(2766950830);
    expect(parseIconID("2766950830")).toBe(2766950830);
    expect(parseIconID(" 100 ")).toBe(100);
    expect(parseIconID("-1")).toBe(4294967295);
    expect(parseIconID("4294967295")).toBe(4294967295);
  });

  it("reads 0, garbage and out-of-range values as no icon", () => {
    for (const raw of [undefined, "", "0", "x", "1.5", "4294967296", "-2147483649"]) {
      expect(parseIconID(raw)).toBeUndefined();
    }
  });

  it("brands a signed value as its unsigned form", () => {
    expect(asIconID(-1528016466)).toBe(2766950830);
    expect(asIconID(2766950830)).toBe(2766950830);
  });
});
