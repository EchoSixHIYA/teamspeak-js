import { Client as SshClient } from "ssh2";
import { StreamTransport } from "./stream.js";

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
}

/**
 * Open a ServerQuery over SSH.
 *
 * SSH logs in itself, so there is no `login` command to send afterwards: the
 * session is already the query account, and only `use` is left. The host key
 * is not checked.
 */
export function connectSsh(options: SshOptions): Promise<StreamTransport> {
  const { host, port = 10022, username, password } = options;
  return new Promise((resolve, reject) => {
    const ssh = new SshClient();
    ssh.once("error", reject);
    ssh.once("ready", () => {
      ssh.shell(false, (error, channel) => {
        if (error) {
          ssh.end();
          reject(error);
          return;
        }
        ssh.off("error", reject);
        // `ssh2` reports a failure after the handshake on the connection, and the
        // stream closes with it.
        ssh.on("error", (failure) => channel.emit("error", failure));
        channel.once("close", () => ssh.end());
        resolve(new StreamTransport(channel, () => ssh.end()));
      });
    });
    ssh.connect({ host, port, username, password, readyTimeout: 10_000 });
  });
}
