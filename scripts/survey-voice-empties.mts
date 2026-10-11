/**
 * Which commands come back empty over the voice protocol?
 *
 * The server answers `ok` with no data row for a set of commands that
 * ServerQuery answers normally. A client cannot tell that apart from "there is
 * nothing to list" without checking, so this script checks.
 *
 * Prints OK / EMPTY / ERR per command, on TS3 and TS6. See
 * docs/voice-protocol-empty-responses.md for what the results mean.
 *
 *   npx tsx scripts/survey-voice-empties.mts                 # both, localhost
 *   TS3=host:port TS6=host:port npx tsx scripts/survey-voice-empties.mts
 */
import { generateIdentity } from "../src/crypto/identity.js";
import { Client } from "../src/client.js";

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const TARGETS: Array<[string, string]> = [
  ["TS3", process.env["TS3"] ?? "127.0.0.1:9987"],
  ["TS6", process.env["TS6"] ?? "127.0.0.1:9988"],
];

/** Every command suspected of answering empty, with the arguments it needs. */
const COMMANDS = [
  "servergrouplist",
  "channelgrouplist",
  "permissionlist",
  "servergrouppermlist sgid=8",
  "clientgetuidfromclid clid=$clid",
  "clientgetids cluid=$uid",
  "clientgetdbidfromuid cluid=$uid",
  "clientgetnamefromuid cluid=$uid",
  "clientgetnamefromdbid cldbid=$dbid",
  "logview",
  "banlist",
  "channelpermlist cid=1",
  // File transfer negotiation: ftinitupload takes proto and all the rest, and
  // the docs for it are the clearest case of a data-returning command.
  "ftinitupload cid=1 name=/survey.txt cpw= size=4 clientftfid=0 overwrite=1 resume=0 proto=0",
  "ftgetfilelist cid=1 cpw= path=/",
  "ftgetfileinfo cid=1 cpw= name=/survey.txt",
];

/** Commands known to work, so a run that reports everything empty is obvious. */
const CONTROLS = [
  "channellist",
  "clientlist",
  "serverinfo",
  "version",
  "whoami",
  `clientinfo clid=$clid`,
];

interface Outcome {
  tag: "OK" | "EMPTY" | "ERR";
  detail: string;
}

async function run(client: Client, command: string): Promise<Outcome> {
  try {
    const rows = await client.execCommandWithResponse(command, 4_000);
    if (rows.length === 0) return { tag: "EMPTY", detail: "" };
    return { tag: "OK", detail: `${rows.length} rows` };
  } catch (err) {
    const message = (err as Error).message.replace("TeamSpeak server error: ", "");
    return { tag: "ERR", detail: message.slice(0, 44) };
  }
}

async function survey(label: string, addr: string): Promise<void> {
  const client = new Client(generateIdentity(8), addr, "survey-empties", { logger: quiet });

  try {
    await client.connect();
    await client.waitConnected(AbortSignal.timeout(20_000));
  } catch (err) {
    console.log(`--- ${label} (${addr}) --- unreachable: ${(err as Error).message}`);
    return;
  }

  const info = (await run(client, `clientinfo clid=${client.clientID()}`)) as Outcome;
  const me =
    info.tag === "OK"
      ? ((await client.execCommandWithResponse(`clientinfo clid=${client.clientID()}`, 5_000))[0] ??
        {})
      : {};

  const substitute = (command: string): string =>
    command
      .replace("$clid", String(client.clientID()))
      .replace("$uid", me["client_unique_identifier"] ?? "unknown")
      .replace("$dbid", me["client_database_id"] ?? "0");

  const caps = client.serverCapabilities();
  console.log(`--- ${label} (${addr}) version="${caps.version}" family=${caps.family} ---`);

  console.log("  controls (these must not be empty):");
  for (const command of CONTROLS) {
    const { tag, detail } = await run(client, substitute(command));
    console.log(`    ${tag.padEnd(6)} ${substitute(command)}${detail ? `  ${detail}` : ""}`);
  }

  console.log("  suspects:");
  for (const command of COMMANDS) {
    const { tag, detail } = await run(client, substitute(command));
    console.log(`    ${tag.padEnd(6)} ${substitute(command)}${detail ? `  ${detail}` : ""}`);
  }

  await client.disconnect().catch(() => {});
}

for (const [label, addr] of TARGETS) {
  await survey(label, addr);
}
