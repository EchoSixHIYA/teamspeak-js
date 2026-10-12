import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import {
  generateIdentity,
  generateIdentitySync,
  parseIdentity,
  getUidFromPublicKey,
  uidAlgorithmForVersion,
} from "./identity.js";

describe("Identity", () => {
  it("generateIdentitySync produces a valid identity at level 8", () => {
    const id = generateIdentitySync(8);
    expect(id.securityLevel()).toBeGreaterThanOrEqual(8);
  });

  it("publicKeyBase64 returns a non-empty string", () => {
    const id = generateIdentitySync(8);
    const pub = id.publicKeyBase64();
    expect(pub.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => Buffer.from(pub, "base64")).not.toThrow();
  });

  it("export / parseIdentity round-trips", () => {
    const id = generateIdentitySync(8);
    const str = id.export();
    const id2 = parseIdentity(str);
    // Same offset
    expect(id2.offset).toBe(id.offset);
    // Same public key
    expect(id2.publicKeyBase64()).toBe(id.publicKeyBase64());
  });

  // toString() used to return the private key, so an identity interpolated
  // into a log line or an error message leaked it.
  it("keeps the private key out of every way it can be printed", () => {
    const id = generateIdentitySync(0);
    const secret = id.export().split(":")[0]!;

    for (const printed of [
      String(id),
      `${id}`,
      JSON.stringify({ id }),
      inspect(id),
      inspect({ nested: id }, { depth: 5 }),
    ]) {
      expect(printed).not.toContain(secret);
      expect(printed).toContain("redacted");
    }
  });

  it("generateIdentity is async and honours its signal", async () => {
    const id = await generateIdentity(4);
    expect(id.securityLevel()).toBeGreaterThanOrEqual(4);

    const reason = new Error("stop");
    await expect(generateIdentity(60, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  });

  it("parseIdentity rejects invalid strings", () => {
    expect(() => parseIdentity("notvalid")).toThrow();
  });

  it("getUidFromPublicKey is SHA1(publicKey) base64", () => {
    const id = generateIdentitySync(8);
    const pub = id.publicKeyBase64();
    const uid = getUidFromPublicKey(pub);
    expect(uid.length).toBeGreaterThan(0);
    // Base64 character set
    expect(uid).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  // The UID hash is not negotiable on the wire: TS3 hashes with SHA-1 and TS6
  // with SHA-256, so a client that assumes one silently computes a UID the
  // other server never sends.
  it("uidAlgorithmForVersion picks SHA-1 for TS3 and SHA-256 for TS6", () => {
    expect(uidAlgorithmForVersion("3.13.8 [Build: 1779874471]")).toBe("sha1");
    expect(uidAlgorithmForVersion("3.0.11 [Build: 1374563791]")).toBe("sha1");
    expect(uidAlgorithmForVersion("6.0.0-beta13.1 [Build: 1790080330]")).toBe("sha256");
    expect(uidAlgorithmForVersion("6.1.0")).toBe("sha256");
    // An unparseable version stays with the TS3 default rather than throwing.
    expect(uidAlgorithmForVersion("")).toBe("sha1");
    expect(uidAlgorithmForVersion("unknown")).toBe("sha1");
  });

  it("getUidFromPublicKey uses the requested algorithm", () => {
    const id = generateIdentitySync(8);
    const pub = id.publicKeyBase64();
    const sha1Uid = getUidFromPublicKey(pub, "sha1");
    const sha256Uid = getUidFromPublicKey(pub, "sha256");
    // 20 bytes and 32 bytes base64-encode to 28 and 44 characters, so the two
    // digests cannot be confused for one another.
    expect(sha1Uid).toHaveLength(28);
    expect(sha256Uid).toHaveLength(44);
    expect(sha1Uid).not.toBe(sha256Uid);
    // The default stays TS3-compatible for existing callers.
    expect(getUidFromPublicKey(pub)).toBe(sha1Uid);
  });
});
