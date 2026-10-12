/**
 * What the connected server is, and what that means for the caller.
 *
 * TS3 and TS6 differ in ways that stay invisible until something breaks. The
 * clearest: the server hashes a client's public key with SHA-1 on TS3 and
 * SHA-256 on TS6, so a client that assumes either one computes a
 * `client_unique_identifier` the other server never sends. That was a real bug
 * here, found only by running against TS6.
 *
 * Everything below comes from the handshake — `initserver` carries
 * `virtualserver_version`, the one place the server names itself, along with
 * its name, icon, banner and welcome message — so reading it costs no extra
 * round trip.
 */

import type { IconID } from "@honeybbq/teamspeak-core";
import { parseIconID } from "@honeybbq/teamspeak-core/internal";
import { uidAlgorithmForVersion, type UIDAlgorithm } from "./crypto/identity.js";

/** The server generation a version string belongs to. */
export type ServerFamily = "ts3" | "ts6" | "unknown";

/** What a server said about itself in the handshake. */
export interface ServerCapabilities {
  /** The `virtualserver_version` string, exactly as the server sent it. */
  readonly version: string;
  /** Major version number, or 0 when it could not be parsed. */
  readonly major: number;
  /** Which server generation this is. */
  readonly family: ServerFamily;
  /**
   * The hash the server uses for `client_unique_identifier`.
   *
   * Read from the family rather than offered as a setting: the server decides
   * this, and a client that picks differently never matches.
   */
  readonly uidAlgorithm: UIDAlgorithm;
  /** The virtual server's name (`virtualserver_name`). */
  readonly name: string;
  /**
   * The server's icon (`virtualserver_icon_id`), or `undefined` for none. The
   * server sends the icon's CRC32, sometimes as a negative 32-bit number; this
   * is the unsigned value, which names the icon file.
   */
  readonly iconID: IconID | undefined;
  /** The host banner image's URL (`virtualserver_hostbanner_gfx_url`), if one is set. */
  readonly hostBannerImageURL: string | undefined;
  /** The welcome message shown on connecting (`virtualserver_welcomemessage`). */
  readonly welcomeMessage: string;
}

/**
 * Read what a server says about itself in `initserver`, or a version string
 * alone, such as "6.0.0-beta13.1 [Build: 1]".
 */
export function parseServerCapabilities(
  initserver: string | Readonly<Record<string, string>>,
): ServerCapabilities {
  const params =
    typeof initserver === "string" ? { virtualserver_version: initserver } : initserver;
  const version = params["virtualserver_version"] ?? "";
  const parsed = Number.parseInt(version, 10);
  const major = Number.isNaN(parsed) ? 0 : parsed;

  let family: ServerFamily = "unknown";
  if (major === 3) family = "ts3";
  else if (major >= 6) family = "ts6";

  return {
    version,
    major,
    family,
    uidAlgorithm: uidAlgorithmForVersion(version),
    name: params["virtualserver_name"] ?? "",
    iconID: parseIconID(params["virtualserver_icon_id"]),
    hostBannerImageURL: params["virtualserver_hostbanner_gfx_url"]?.trim() || undefined,
    welcomeMessage: params["virtualserver_welcomemessage"] ?? "",
  };
}

/**
 * Capabilities of a server that has not been connected to yet.
 *
 * The family is honestly `unknown` — nothing has said which server this is —
 * while `uidAlgorithm` stays SHA-1, so behaviour before connecting is exactly
 * what it was before TS6 support existed.
 */
export function unknownServerCapabilities(): ServerCapabilities {
  return parseServerCapabilities("");
}
