import { readFile } from "node:fs/promises";
import { MissingDependencyError, QueryAuthError, SshHostKeyError } from "./errors.js";
import { KnownHosts, fingerprintOf, keyTypeOf } from "./knownhosts.js";
import { StreamTransport } from "./stream.js";
import type { QueryStream } from "./stream.js";

/**
 * The part of an SSH client this transport uses: `ssh2`'s `Client` is one, and
 * so is anything else with these methods.
 *
 * Declared here rather than imported from `@types/ssh2`, which a caller
 * without the optional peer dependency does not have: the types are a
 * devDependency and are not published with the package. A later release may
 * widen this, and every new member will be optional, so an implementation
 * written today keeps compiling.
 */
export interface SshClient {
  /**
   * Begin the connection; `ready` is emitted once the handshake is done.
   *
   * `hostVerifier` is asked about the server's key before anything is
   * authenticated, so before the password is sent. It is given the key's wire
   * encoding and returns whether to go on: a client must end the connection
   * when it returns `false`, and must not treat a missing answer as a yes.
   */
  connect(config: {
    host: string;
    port: number;
    username: string;
    password: string;
    readyTimeout: number;
    hostVerifier: (key: Uint8Array) => boolean;
  }): void;
  /** Open a shell channel, or report why it could not be opened. */
  shell(pty: false, callback: (error: Error | undefined, channel: SshChannel) => void): void;
  /** End the connection. */
  end(): void;
  /** Listen for the handshake completing, once. */
  once(event: "ready", listener: () => void): unknown;
  /** Listen for the next failure, once. */
  once(event: "error", listener: (error: Error) => void): unknown;
  /** Listen for each failure. */
  on(event: "error", listener: (error: Error) => void): unknown;
  /** Stop listening for failures. */
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** The channel an SSH client's shell opens: a byte stream, and the errors on it. */
export interface SshChannel extends QueryStream {
  /** Report a failure on the stream, as a socket would: the transport reads it. */
  emit(event: "error", error: Error): unknown;
  /** Listen for the stream closing, once. */
  once(event: "close", listener: () => void): unknown;
}

/**
 * An SSH client this transport uses instead of loading `ssh2` itself: either
 * one that is connected already, or a factory that makes one.
 *
 * A caller that holds its own connected client — authenticated through an
 * agent, a jump host or a key file this transport knows nothing about — hands
 * it over. A factory is asked for one per connection attempt, which a
 * reconnection needs.
 */
export type SshConnection = SshClient | (() => Promise<SshClient>);

/**
 * The key an SSH server presented, as the check a caller supplies sees it.
 *
 * A type of this package's own rather than the SSH library's, so a policy can
 * be written without importing that library.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface SshHostKey {
  /** The host that was dialled, as it was given. */
  readonly host: string;
  /** The port that was dialled. */
  readonly port: number;
  /** The key's algorithm, such as `ssh-ed25519`, as its own encoding names it. */
  readonly keyType: string;
  /** The key's wire encoding: the blob a `known_hosts` line carries in base64. */
  readonly key: Uint8Array;
  /**
   * The key's SHA-256 fingerprint in OpenSSH form, such as `SHA256:HR5y2ZQ…`.
   * It is what `ssh-keygen -lf` and `ssh-keyscan` print, so it can be compared
   * with the one the server's operator published.
   */
  readonly fingerprint: string;
}

/**
 * A caller's check of an SSH server's host key: returns to accept the key and
 * throws to refuse it.
 *
 * Throwing is how a callback with no error channel says no, and the error it
 * throws is kept as the `cause` of the {@link SshHostKeyError} the connection
 * fails with. It runs before the login is sent, and it has to be synchronous
 * and return nothing: a return value, a `false` included, is not an answer this
 * can read, so it refuses the key rather than guess, as does a promise, whose
 * rejection would arrive too late to stop anything.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export type SshHostKeyVerifier = (key: SshHostKey) => void;

/**
 * Where a ServerQuery over SSH listens, and who logs in.
 *
 * The server's host key has to be checked, and there is no default: exactly one
 * of {@link SshOptions.hostKey}, {@link SshOptions.knownHosts} and
 * {@link SshOptions.insecureIgnoreHostKey} has to be given, unless
 * {@link SshOptions.connection} supplies the connection. A query login is a
 * credential, normally `serveradmin`'s, and a client that accepts any key hands
 * it to whatever answers the port.
 */
export interface SshOptions {
  /** The server's host. */
  readonly host: string;
  /** The SSH query port; 10022 by default. */
  readonly port?: number | undefined;
  /** The query login name, such as `serveradmin`. */
  readonly username: string;
  /** The query login's password. */
  readonly password: string;
  /** Abandons the connection attempt. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Your own check of the server's host key; see {@link SshHostKeyVerifier}.
   * Called once per connection attempt, before the login is sent.
   *
   * One of three ways to decide whether the server is the one expected, and
   * the one for a policy that is not a file: a fingerprint from configuration,
   * a pinned key, a lookup somewhere else.
   */
  readonly hostKey?: SshHostKeyVerifier | undefined;
  /**
   * A path to an OpenSSH `known_hosts` file to check the server against, in the
   * format `ssh-keyscan` writes and `ssh-keygen -H` hashes.
   *
   * Read when each connection is attempted, so a reconnection sees the file as
   * it is then, and only from the path given: `~/.ssh/known_hosts` is never
   * assumed, because a library reading the home directory on its own is a
   * surprise. The check is what `ssh` does with `StrictHostKeyChecking=yes`: a
   * host the file does not mention is refused, so is one recorded with another
   * key, and so is a key a `@revoked` line names. Plain, `[host]:port` and
   * hashed entries are read; a line that cannot be read fails the connection
   * rather than being skipped.
   */
  readonly knownHosts?: string | undefined;
  /**
   * Accept whatever key the server presents. Only `true` is a value: this is
   * not a switch to be left `false`, but a decision a call site makes out loud.
   *
   * It gives up the one thing the host key is for. Anyone who can answer the
   * port, on the path or at the address, receives the query login and its
   * password and is indistinguishable from the server. It is for a test or a
   * throwaway server on a network that is already trusted; use
   * {@link SshOptions.knownHosts} otherwise.
   */
  readonly insecureIgnoreHostKey?: true | undefined;
  /**
   * The SSH client to use, or a factory for one; `ssh2` by default.
   *
   * The seam into the transport. Supplying a client that is already connected
   * skips the handshake, so the host, port and credentials here are then only
   * what the caller says they are. Deliberately narrow, so a later release can
   * widen it without breaking an implementation written today.
   *
   * The host key is then checked by whoever made the connection, so none of
   * `hostKey`, `knownHosts` or `insecureIgnoreHostKey` is given with it: an
   * option that nothing would read is refused rather than left to suggest the
   * key was verified.
   */
  readonly connection?: SshConnection | undefined;
}

/** How the host key is to be decided, once the options have been read. */
export type HostKeyPolicy =
  | { readonly kind: "verifier"; readonly verify: SshHostKeyVerifier }
  | { readonly kind: "knownHosts"; readonly path: string }
  | { readonly kind: "insecure" }
  /** The caller supplied the connection, so the key was theirs to check. */
  | { readonly kind: "connection" };

/**
 * Read the trust decision out of the options, or refuse them.
 *
 * Fails closed: with none of the three there is no policy, and this throws
 * rather than choose one. Two is a `TypeError`, since a caller who passed both
 * has not decided which is authoritative. Runs when a client is built as well
 * as when it connects, so a missing decision is heard about before the first
 * attempt.
 */
export function hostKeyPolicy(
  options: Pick<SshOptions, "hostKey" | "knownHosts" | "insecureIgnoreHostKey" | "connection">,
): HostKeyPolicy {
  const { hostKey, knownHosts, connection } = options;
  // Read as `unknown`: the type admits only `true`, and the check is for the
  // caller whose types do not say so.
  const insecureIgnoreHostKey: unknown = options.insecureIgnoreHostKey;
  if (hostKey !== undefined && typeof hostKey !== "function") {
    throw new TypeError("hostKey is a function that throws to refuse a host key");
  }
  if (knownHosts !== undefined && (typeof knownHosts !== "string" || knownHosts === "")) {
    throw new TypeError("knownHosts is the path of a known_hosts file");
  }
  if (insecureIgnoreHostKey !== undefined && insecureIgnoreHostKey !== true) {
    throw new TypeError(
      "insecureIgnoreHostKey is `true` or left out: it is a decision, not a switch to set to false",
    );
  }

  const given: string[] = [];
  if (hostKey !== undefined) given.push("hostKey");
  if (knownHosts !== undefined) given.push("knownHosts");
  if (insecureIgnoreHostKey !== undefined) given.push("insecureIgnoreHostKey");
  if (given.length > 1) {
    throw new TypeError(
      `${given.join(", ")} were given together; exactly one of hostKey, knownHosts and insecureIgnoreHostKey decides whether the host key is accepted`,
    );
  }
  if (connection !== undefined) {
    if (given.length > 0) {
      throw new TypeError(
        `${given[0]} has no effect with connection, which makes the connection itself: its host key is checked by whoever made it`,
      );
    }
    return { kind: "connection" };
  }
  if (hostKey !== undefined) return { kind: "verifier", verify: hostKey };
  if (knownHosts !== undefined) return { kind: "knownHosts", path: knownHosts };
  if (insecureIgnoreHostKey !== undefined) return { kind: "insecure" };
  throw new Error(
    "the SSH host key has to be checked, and none of hostKey, knownHosts or insecureIgnoreHostKey was given: a query login is a credential, normally serveradmin's, and this client will not send it to a host it has not verified",
  );
}

/**
 * `ssh2`, or a `MissingDependencyError` naming it. Loaded on demand: it is an
 * optional peer dependency, so importing it at the top of this module would
 * make it a requirement of the whole entry point — including the TCP and
 * WebQuery transports, which need nothing but Node.
 */
async function loadSsh2(): Promise<{ Client: new () => SshClient }> {
  try {
    return await import("ssh2");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
    ) {
      throw new MissingDependencyError();
    }
    throw error;
  }
}

/**
 * Open a ServerQuery over SSH.
 *
 * SSH logs in itself, so there is no `login` command to send afterwards: the
 * session is already the query account, and only `use` is left.
 *
 * The server's host key is checked first, by whichever of `hostKey`,
 * `knownHosts` and `insecureIgnoreHostKey` was given, and the password is sent
 * only to a server whose key was accepted. With none of them, or with two,
 * this rejects before anything is opened or dialled.
 */
export async function connectSsh(options: SshOptions): Promise<StreamTransport> {
  const { host, port = 10022, username, password, signal, connection } = options;
  const policy = hostKeyPolicy(options);
  signal?.throwIfAborted();
  const verify = await verifierFor(policy, host, port);
  const ssh = await clientFor(connection);
  signal?.throwIfAborted();

  // What the caller's check said, so that the failure ssh2 reports for a
  // refused key can be told from any other and carry the reason.
  let refusal: Error | undefined;

  return new Promise((resolve, reject) => {
    let settled = false;
    const failed = (error: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => {
      ssh.end();
      failed(signal!.reason as Error);
    };
    const onAuthError = (error: Error): void => {
      if (refusal !== undefined) {
        failed(
          new SshHostKeyError(
            host,
            port,
            `the SSH host key of ${host}:${port} was not accepted, so no login was sent: ${refusal.message}`,
            { cause: refusal },
          ),
        );
        return;
      }
      // ssh2 reports a refused credential through `level`, which its types do
      // not name; a wrong password is the one that leaves the client unable to
      // authenticate rather than unable to reach the server.
      const level = (error as { level?: unknown }).level;
      failed(
        level === "client-authentication"
          ? new QueryAuthError(username, `SSH authentication failed for ${username}`, {
              cause: error,
            })
          : error,
      );
    };
    const openShell = (): void => {
      ssh.shell(false, (error, channel) => {
        if (error) {
          ssh.end();
          failed(error);
          return;
        }
        ssh.off("error", onAuthError);
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        // `ssh2` reports a failure after the handshake on the connection, and the
        // stream closes with it.
        ssh.on("error", (failure) => channel.emit("error", failure));
        channel.once("close", () => ssh.end());
        resolve(new StreamTransport(channel, () => ssh.end()));
      });
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (connection !== undefined) {
      // A client the caller handed over is one they say is connected, and one
      // from their own factory is dialled on their terms: neither is connected
      // here, and neither can be a wrong credential this module knows of.
      openShell();
      return;
    }
    ssh.once("error", onAuthError);
    ssh.once("ready", openShell);
    ssh.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 10_000,
      hostVerifier: (blob) => {
        const outcome = decide(verify, host, port, blob);
        if (outcome !== undefined) refusal = outcome;
        return outcome === undefined;
      },
    });
  });
}

/**
 * The check the options chose, ready to run: the caller's own, one over the
 * `known_hosts` file read now, or the one that accepts anything.
 *
 * A file that cannot be read or parsed is a failure to verify, and ends the
 * connection as a refused key does.
 */
async function verifierFor(
  policy: HostKeyPolicy,
  host: string,
  port: number,
): Promise<SshHostKeyVerifier> {
  if (policy.kind === "verifier") return policy.verify;
  // `connection` never reaches a handshake of ours, so for it this is not asked.
  if (policy.kind !== "knownHosts") return () => {};

  let hosts: KnownHosts;
  try {
    hosts = KnownHosts.parse(await readFile(policy.path, "utf8"), policy.path);
  } catch (error) {
    throw new SshHostKeyError(
      host,
      port,
      `the host key of ${host}:${port} cannot be checked: ${(error as Error).message}`,
      { cause: error },
    );
  }
  return (key) => hosts.verify(key);
}

/**
 * Run the check on the key ssh2 found, returning why it was refused, or
 * `undefined` for a key it accepted.
 *
 * Everything that is not a plain return counts as a refusal: a throw, naturally,
 * but also an answer. A check that returns `false` was written in ssh2's
 * convention and means no; one that returns `true` means yes in that
 * convention, and a promise means whatever it later settles to. None of those
 * is the contract, and acting on a guess at which was meant is how a refused key
 * gets through, so each fails closed and says what to write instead.
 */
function decide(
  verify: SshHostKeyVerifier,
  host: string,
  port: number,
  blob: Uint8Array,
): Error | undefined {
  try {
    const key = new Uint8Array(blob);
    const answer: unknown = verify({
      host,
      port,
      keyType: keyTypeOf(key),
      key,
      fingerprint: fingerprintOf(key),
    });
    if (answer === undefined) return undefined;
    // A rejection nobody awaits would otherwise surface as an unhandled one.
    if (typeof (answer as { then?: unknown }).then === "function") {
      void Promise.resolve(answer).catch(() => {});
    }
    return new TypeError(
      "the hostKey check returned a value; it has to return nothing to accept the key and throw to refuse it, and be synchronous",
    );
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The client to talk over: the caller's, their factory's, or a fresh `ssh2`. */
async function clientFor(connection: SshConnection | undefined): Promise<SshClient> {
  if (typeof connection === "function") return connection();
  if (connection !== undefined) return connection;
  const { Client } = await loadSsh2();
  return new Client();
}
