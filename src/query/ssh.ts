import { MissingDependencyError, QueryAuthError } from "./errors.js";
import { StreamTransport } from "./stream.js";
import type { QueryStream } from "./stream.js";

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
}

/**
 * The part of `ssh2` this transport uses. Typed here rather than imported from
 * `@types/ssh2`, which a caller without the optional peer dependency does not
 * have: the types are a devDependency and are not published with the package.
 */
interface SshModule {
  Client: new () => SshClient;
}

interface SshChannel extends QueryStream {
  /** Report a failure on the stream, as a socket would: the transport reads it. */
  emit(event: "error", error: Error): unknown;
  /** Listen for the stream closing, once. */
  once(event: "close", listener: () => void): unknown;
}

interface SshClient {
  connect(config: {
    host: string;
    port: number;
    username: string;
    password: string;
    readyTimeout: number;
  }): void;
  shell(pty: false, callback: (error: Error | undefined, channel: SshChannel) => void): void;
  end(): void;
  once(event: "ready", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * `ssh2`, or a `MissingDependencyError` naming it. Loaded on demand: it is an
 * optional peer dependency, so importing it at the top of this module would
 * make it a requirement of the whole entry point — including the TCP and
 * WebQuery transports, which need nothing but Node.
 */
async function loadSsh2(): Promise<SshModule> {
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
  const { host, port = 10022, username, password, signal } = options;
  signal?.throwIfAborted();
  const { Client } = await loadSsh2();

  return new Promise((resolve, reject) => {
    const ssh = new Client();
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
    ssh.once("error", onAuthError);
    ssh.once("ready", () => {
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
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    ssh.connect({ host, port, username, password, readyTimeout: 10_000 });
  });
}
