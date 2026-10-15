import { MissingDependencyError, QueryAuthError } from "./errors.js";
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
  /** Begin the connection; `ready` is emitted once the handshake is done. */
  connect(config: {
    host: string;
    port: number;
    username: string;
    password: string;
    readyTimeout: number;
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

/** Where a ServerQuery over SSH listens, and who logs in. */
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
   * The SSH client to use, or a factory for one; `ssh2` by default.
   *
   * The seam into the transport. Supplying a client that is already connected
   * skips the handshake, so the host, port and credentials here are then only
   * what the caller says they are. Deliberately narrow, so a later release can
   * widen it without breaking an implementation written today.
   */
  readonly connection?: SshConnection | undefined;
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
 * session is already the query account, and only `use` is left. The host key
 * is not checked.
 */
export async function connectSsh(options: SshOptions): Promise<StreamTransport> {
  const { host, port = 10022, username, password, signal, connection } = options;
  signal?.throwIfAborted();
  const ssh = await clientFor(connection);
  signal?.throwIfAborted();

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
    ssh.connect({ host, port, username, password, readyTimeout: 10_000 });
  });
}

/** The client to talk over: the caller's, their factory's, or a fresh `ssh2`. */
async function clientFor(connection: SshConnection | undefined): Promise<SshClient> {
  if (typeof connection === "function") return connection();
  if (connection !== undefined) return connection;
  const { Client } = await loadSsh2();
  return new Client();
}
