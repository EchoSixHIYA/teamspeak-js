import { describe, it, expect } from "vitest";
import {
  isAutoNicknameMatch,
  splitCommandRows,
  parseUint64,
  parseUint16,
  parseInt10,
} from "./helpers.js";

describe("isAutoNicknameMatch", () => {
  it("exact match", () => {
    expect(isAutoNicknameMatch("Alice", "Alice")).toBe(true);
  });

  it("match with numeric suffix", () => {
    expect(isAutoNicknameMatch("Alice", "Alice123")).toBe(true);
    expect(isAutoNicknameMatch("Alice", "Alice1")).toBe(true);
  });

  it("no match with non-numeric suffix", () => {
    expect(isAutoNicknameMatch("Alice", "AliceX")).toBe(false);
    expect(isAutoNicknameMatch("Alice", "Bob")).toBe(false);
  });
});

describe("splitCommandRows", () => {
  it("returns single-element array for commands without pipe", () => {
    expect(splitCommandRows("error id=0 msg=ok")).toEqual(["error id=0 msg=ok"]);
  });

  it("expands pipe-separated rows", () => {
    const rows = splitCommandRows("clientlist clid=1 cid=5|clid=2 cid=6");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe("clientlist clid=1 cid=5");
    expect(rows[1]).toBe("clientlist clid=2 cid=6");
  });

  it("inherits omitted fields from the previous row", () => {
    const rows = splitCommandRows(
      "notifycliententerview cfid=0 ctid=1 reasonid=2 clid=7 client_nickname=Alice|clid=8 client_nickname=Bob",
    );

    expect(rows).toEqual([
      "notifycliententerview cfid=0 ctid=1 reasonid=2 clid=7 client_nickname=Alice",
      "notifycliententerview cfid=0 ctid=1 reasonid=2 clid=8 client_nickname=Bob",
    ]);
  });

  it("preserves explicitly changed fields and escaped values", () => {
    const rows = splitCommandRows(
      "clientlist cid=1 client_nickname=Alice\\sspeaker|cid=2 client_nickname=Bob\\pAdmin",
    );

    expect(rows).toEqual([
      "clientlist cid=1 client_nickname=Alice\\sspeaker",
      "clientlist cid=2 client_nickname=Bob\\pAdmin",
    ]);
  });

  // Response rows carry no name. Treating the first field as one copied it onto
  // every row, and a batch with no space in it was never split at all.
  it("splits a nameless batch without inventing a name", () => {
    expect(splitCommandRows("clid=1 cid=5|clid=2 cid=6")).toEqual(["clid=1 cid=5", "clid=2 cid=6"]);
  });

  it("splits one-field rows", () => {
    expect(splitCommandRows("cldbid=1|cldbid=2|cldbid=3")).toEqual([
      "cldbid=1",
      "cldbid=2",
      "cldbid=3",
    ]);
  });

  it("inherits omitted fields in nameless rows too", () => {
    expect(splitCommandRows("cid=1 name=a|name=b")).toEqual(["cid=1 name=a", "cid=1 name=b"]);
  });

  it("returns original for command with no space", () => {
    expect(splitCommandRows("ping")).toEqual(["ping"]);
  });
});

describe("parse helpers", () => {
  it("parseUint64", () => {
    expect(parseUint64("12345")).toBe(12345n);
    expect(parseUint64("")).toBe(0n);
    expect(parseUint64("abc")).toBe(0n);
  });

  it("parseUint16", () => {
    expect(parseUint16("65535")).toBe(65535);
    expect(parseUint16("0")).toBe(0);
    expect(parseUint16("abc")).toBe(0);
  });

  it("parseInt10", () => {
    expect(parseInt10("42")).toBe(42);
    expect(parseInt10("-5")).toBe(-5);
    expect(parseInt10("x")).toBe(0);
  });
});
