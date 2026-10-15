import type { ServerID, TeamspeakError } from "@honeybbq/teamspeak";
import {
  CommandTimeoutError,
  NotConnectedError,
  ServerError,
  type CommandExecutor,
  type CommandOptions,
  type CommandRequest,
  type NotificationEvent,
} from "@honeybbq/teamspeak";
import {
  buildCommandOrdered,
  encodeRequest,
  parseCommand,
  parseServerError,
} from "../core/internal.js";
import type { QueryTransport } from "./transport.js";

/** How long a command waits for its answer unless told otherwise. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

interface Pending {
  readonly command: string;
  readonly rows: Array<Record<string, string>>;
  resolve(rows: Array<Record<string, string>>): void;
  reject(error: unknown): void;
}

/**
 * A ServerQuery client: runs the typed commands from
 * `@honeybbq/teamspeak` over a {@link QueryTransport}.
 *
 * ServerQuery answers one command at a time, in order: data lines, then an
 * `error` line that ends the answer. So commands are queued and sent one after
 * another, which also keeps the server's flood protection from seeing a burst.
 * Notifications (`notify…`) can arrive at any point and are not part of an
 * answer.
 *
 * A skeleton: connecting is the transport's job (`connectTcp`, `connectSsh`,
 * `WebQueryTransport`), and events reach {@link QueryClient.onNotification}
 * as the server sent them, not yet as the core's typed events.
 *
 * @experimental
 */
export class QueryClient implements CommandExecutor {
  #transport: QueryTransport;
  #pending: Pending | null = null;
  /**
   * Answers still to come for commands that gave up waiting. ServerQuery has
   * no return_code, only order, so each is read and discarded when it arrives
   * rather than taken for the next command's.
   */
  #abandoned = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #listeners = new Set<(event: NotificationEvent) => void>();

  constructor(transport: QueryTransport) {
    this.#transport = transport;
    transport.onLine = (line) => this.#handleLine(line);
    transport.onClose = (error) => this.#handleClose(error);
  }

  /**
   * Send a typed command. Passwords go as they are: ServerQuery takes the
   * password itself and hashes it server-side, where the voice protocol wants
   * the hash.
   */
  send(
    request: CommandRequest,
    options: CommandOptions = {},
  ): Promise<Array<Record<string, string>>> {
    return this.exec(
      encodeRequest(request, (password) => password),
      options,
    );
  }

  /** Send a raw command line and return the rows that answer it. */
  exec(line: string, options: CommandOptions = {}): Promise<Array<Record<string, string>>> {
    const run = this.#queue.then(() => this.#execNow(line, options));
    // The queue moves on whatever this command's outcome.
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Log in with a query account. Over WebQuery the api key does this, and the
   * server refuses the command; over SSH the session is logged in already.
   */
  async login(name: string, password: string, options: CommandOptions = {}): Promise<void> {
    await this.exec(
      buildCommandOrdered("login", [
        ["client_login_name", name],
        ["client_login_password", password],
      ]),
      options,
    );
  }

  /**
   * Select the virtual server the following commands address, by id or by
   * voice port. `nickname` names the query client on it.
   */
  async use(
    server: { readonly id: ServerID | number } | { readonly port: number },
    options: CommandOptions & { readonly nickname?: string | undefined } = {},
  ): Promise<void> {
    await this.exec(
      buildCommandOrdered("use", [
        "id" in server ? ["sid", String(server.id)] : ["port", String(server.port)],
        ...(options.nickname === undefined
          ? []
          : ([["client_nickname", options.nickname]] as const)),
      ]),
      options,
    );
  }

  /**
   * Ask the server for the notifications of one category: `server`, `channel`
   * (for one channel, or `0` for all), `textserver`, `textchannel`,
   * `textprivate`, and on TeamSpeak 6 `bans`. They reach
   * {@link QueryClient.onNotification}.
   */
  async registerNotifications(
    event: string,
    channelID?: bigint | number,
    options: CommandOptions = {},
  ): Promise<void> {
    await this.exec(
      buildCommandOrdered("servernotifyregister", [
        ["event", event],
        ...(channelID === undefined ? [] : ([["id", String(channelID)]] as const)),
      ]),
      options,
    );
  }

  /**
   * Listen for the notifications the server sends, as it sent them: one call
   * per row, with the name (`notifytextmessage`) and the unescaped fields.
   * Returns a function that removes the listener.
   */
  onNotification(listener: (event: NotificationEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** End the connection. Commands still waiting fail with a NotConnectedError. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new NotConnectedError());
    await this.#transport.close();
  }

  async #execNow(line: string, options: CommandOptions): Promise<Array<Record<string, string>>> {
    const { signal, timeout = DEFAULT_COMMAND_TIMEOUT_MS } = options;
    signal?.throwIfAborted();
    if (this.#closed) throw new NotConnectedError();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const answered = new Promise<Array<Record<string, string>>>((resolve, reject) => {
      this.#pending = { command: parseCommand(line)?.name ?? "", rows: [], resolve, reject };
      timer = setTimeout(
        () => reject(new CommandTimeoutError(parseCommand(line)?.name ?? "")),
        timeout,
      );
      onAbort = () => reject(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The answer may settle while the transport is still sending, as it does
    // when a send carries the whole round trip (WebQuery); a failure of the
    // send first would otherwise leave this rejection unhandled.
    answered.catch(() => {});
    const sending = { failed: false };
    let abandonedByUs = false;
    const send = this.#transport.send(line).then(
      () => {},
      (error: unknown) => {
        // A send that fails after the command gave up will not be answered.
        if (abandonedByUs) this.#abandoned--;
        sending.failed = true;
        throw error;
      },
    );
    try {
      await Promise.race([send, answered]);
      return await answered;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (this.#pending !== null) {
        this.#pending = null;
        if (!sending.failed) {
          this.#abandoned++;
          abandonedByUs = true;
        }
      }
    }
  }

  #handleLine(line: string): void {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) return;
    const cmd = parseCommand(trimmed);
    if (!cmd) return;

    if (cmd.name === "error") {
      if (this.#abandoned > 0) {
        this.#abandoned--;
        return;
      }
      const pending = this.#pending;
      this.#pending = null;
      if (!pending) return;
      const { err } = parseServerError(cmd.params);
      const refusal = err ?? transferRefusal(pending.command, pending.rows);
      if (refusal) pending.reject(refusal);
      else pending.resolve(pending.rows);
      return;
    }
    if (cmd.name.startsWith("notify")) {
      // A notification is never part of an answer.
      for (const row of splitRows(trimmed)) {
        const parsed = parseCommand(row);
        if (parsed) this.#notify({ name: cmd.name, params: parsed.params });
      }
      return;
    }
    if (this.#abandoned > 0) return;
    for (const row of splitRows(trimmed)) {
      const parsed = parseCommand(row);
      if (parsed) this.#pending?.rows.push(parsed.params);
    }
  }

  #notify(event: NotificationEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure is its own; it must not break the answer being read.
      }
    }
  }

  #handleClose(error: Error | undefined): void {
    this.#closed = true;
    this.#fail(new NotConnectedError(error ? { cause: error } : undefined));
  }

  #fail(error: TeamspeakError): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(error);
  }
}

/**
 * The rows of a line, which ServerQuery separates with `|`.
 *
 * Every row carries all its fields, so rows are not completed from the row
 * before as the voice protocol's are; a `|` inside a value is escaped (`\p`),
 * so splitting on it is exact. A notification's name is repeated on each row.
 */
function splitRows(line: string): string[] {
  const space = line.indexOf(" ");
  const head = space < 0 ? line : line.slice(0, space);
  const named = /^[A-Za-z0-9]+$/.test(head);
  const rest = named ? (space < 0 ? "" : line.slice(space + 1)) : line;
  const prefix = named ? `${head} ` : "";
  return rest
    .split("|")
    .filter((row) => row !== "")
    .map((row) => prefix + row);
}

/**
 * The refusal a file transfer negotiation reports inside a successful answer.
 *
 * `ftinitupload` and `ftinitdownload` answer `error id=0` even when they
 * refuse, and say so in the row instead: `clientftfid=2 status=2058
 * msg=file\sis\sin\suse`, with no `ftkey`. Left as it is, the typed command
 * would find no key and report that the server sent no data, losing the
 * reason; this turns the row into the server error it is.
 */
function transferRefusal(
  command: string,
  rows: ReadonlyArray<Record<string, string>>,
): ServerError | undefined {
  if (command !== "ftinitupload" && command !== "ftinitdownload") return undefined;
  const row = rows[0];
  if (row === undefined || row["ftkey"] !== undefined) return undefined;
  const status = Number(row["status"]);
  if (!Number.isInteger(status) || status === 0) return undefined;
  return new ServerError(status, row["msg"] ?? "");
}
