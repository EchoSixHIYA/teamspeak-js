/**
 * Fails when the public API of a published package differs from the report
 * committed under its etc/ folder, and shows the difference.
 *
 * API Extractor does the comparing: run without --local, it refuses to update
 * the report. It says only that the report changed, though, so this prints
 * the diff of the committed report against the one it just made, for both
 * packages rather than the first that fails. Run `pnpm build` first, or use
 * `pnpm api:check`, which does.
 */

import { spawnSync } from "node:child_process";

// The published packages. serverquery is private and has no report.
const packages = ["core", "client"];

let failed = false;
for (const name of packages) {
  const dir = `packages/${name}`;
  const report = `teamspeak-${name}.api.md`;
  const run = spawnSync("api-extractor", ["run", "-c", `${dir}/api-extractor.json`], {
    stdio: "inherit",
  });
  if (run.status === 0) continue;

  failed = true;
  console.error(`\n@honeybbq/teamspeak-${name}: the public API differs from ${dir}/etc/${report}`);
  spawnSync("diff", ["-u", `${dir}/etc/${report}`, `${dir}/temp/${report}`], { stdio: "inherit" });
}

if (failed) {
  console.error("\nIf the change is deliberate, run `pnpm api:report` and commit the reports.");
  process.exit(1);
}
