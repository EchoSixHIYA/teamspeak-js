import { describe, expect, it } from "vitest";
import { mergeSections, readSection, renderBody } from "./release-notes.mts";

const client = `# @honeybbq/teamspeak-client

## 1.0.0-beta.2

### Major Changes

- aaaaaaa: Shared breaking change.
- bbbbbbb: Client only.

  A second paragraph.

### Patch Changes

- ccccccc: Same text, different bump.
- Updated dependencies [aaaaaaa]
- Updated dependencies [ccccccc]
  - @honeybbq/teamspeak-core@1.0.0-beta.2

## 1.0.0-beta.1

### Patch Changes

- 1111111: Old.
`;

const core = `# @honeybbq/teamspeak-core

## 1.0.0-beta.2

### Major Changes

- aaaaaaa: Shared breaking change.
- ccccccc: Same text, different bump.

### Minor Changes

- ddddddd: Core only.

### Patch Changes

- eeeeeee: Core fix.

## 1.0.0-beta.1

### Patch Changes

- 1111111: Old.
`;

describe("readSection", () => {
  it("strips the hash prefix, keeps paragraphs, and stops at the next version", () => {
    const section = readSection(client, "1.0.0-beta.2", "client");
    expect(section.get("Major Changes")).toEqual([
      "- Shared breaking change.",
      "- Client only.\n\n  A second paragraph.",
    ]);
    expect(section.get("Patch Changes")).toEqual(["- Same text, different bump."]);
  });

  it("drops the dependency-update entries and their nested lines", () => {
    const text = [...readSection(client, "1.0.0-beta.2", "client").values()].flat().join("\n");
    expect(text).not.toContain("Updated dependencies");
    expect(text).not.toContain("teamspeak-core@");
  });

  it("throws when the version has no section", () => {
    expect(() => readSection(client, "1.0.0-beta.9", "client")).toThrow(
      /no section "## 1.0.0-beta.9"/,
    );
  });

  it("throws when the section has no entries", () => {
    expect(() => readSection("## 1.0.0\n\n", "1.0.0", "core")).toThrow(/no entries/);
  });

  it("does not match a version that only starts the same", () => {
    expect(() => readSection(client, "1.0.0-beta", "client")).toThrow();
  });
});

describe("mergeSections", () => {
  const merged = mergeSections(
    readSection(client, "1.0.0-beta.2", "client"),
    readSection(core, "1.0.0-beta.2", "core"),
  );

  it("lists an entry present in both packages once", () => {
    const all = [...merged.values()].flat();
    expect(all.filter((e) => e === "- Shared breaking change.")).toHaveLength(1);
  });

  it("lists an entry once even when the packages bump it differently", () => {
    const all = [...merged.values()].flat();
    expect(all.filter((e) => e === "- Same text, different bump.")).toHaveLength(1);
    expect(merged.get("Major Changes")).toContain("- Same text, different bump.");
    expect(merged.get("Patch Changes")).not.toContain("- Same text, different bump.");
  });

  it("adds core-only entries to the matching group", () => {
    expect(merged.get("Minor Changes")).toEqual(["- Core only."]);
    expect(merged.get("Patch Changes")).toEqual(["- Core fix."]);
  });

  it("keeps the groups in changesets' order", () => {
    expect([...merged.keys()]).toEqual(["Major Changes", "Minor Changes", "Patch Changes"]);
  });
});

describe("renderBody", () => {
  it("starts with the install line and has no hash or dependency lines", () => {
    const merged = mergeSections(
      readSection(client, "1.0.0-beta.2", "client"),
      readSection(core, "1.0.0-beta.2", "core"),
    );
    const body = renderBody("1.0.0-beta.2", merged);
    expect(
      body.startsWith(
        "Install:\n\n```sh\nnpm install @honeybbq/teamspeak-client@1.0.0-beta.2\n```\n\n### Major Changes",
      ),
    ).toBe(true);
    expect(body).not.toMatch(/^- [0-9a-f]{7}: /m);
    expect(body).not.toContain("Updated dependencies");
  });
});
