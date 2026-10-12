import {
  CommandTimeoutError,
  NotConnectedError,
  TeamspeakError,
  encodeRequest,
  parseCommand,
  type CommandExecutor,
  type CommandOptions,
  type CommandRequest,
} from "@honeybbq/teamspeak-core";
import { parseServerError, splitCommandRows } from "@honeybbq/teamspeak-core/internal";
import type { QueryTransport } from "./transport.js";

/** How long a command waits for its answer unless told otherwise. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

interface Pending {
  readonly rows: Record<string, string>[];
  resolve(rows: Record<string, string>[]): void;
  reject(error: unknown): void;
}

/**
 * A ServerQuery client: runs the typed commands from
 * `@honeybbq/teamspeak-core` over a {@link QueryTransport}.
 *
 * ServerQuery answers one command at a time, in order: data lines, then an
 * `error` line that ends the answer. So commands are queued and sent one after
 * another, which also keeps the server's flood protection from seeing a burst.
 * Notifications (`notify…`) can arrive at any point and are not part of an
 * answer.
 *
 * A skeleton: connecting, `login`/`use` and notification events are to come.
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
  send(request: CommandRequest, options: CommandOptions = {}): Promise<Record<string, string>[]> {
    return this.exec(
      encodeRequest(request, (password) => password),
      options,
    );
  }

  /** Send a raw command line and return the rows that answer it. */
  exec(line: string, options: CommandOptions = {}): Promise<Record<string, string>[]> {
    const run = this.#queue.then(() => this.#execNow(line, options));
    // The queue moves on whatever this command's outcome.
    this.#queue = run.catch(() => {});
    return run;
  }

  /** End the connection. Commands still waiting fail with a NotConnectedError. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new NotConnectedError());
    await this.#transport.close();
  }

  async #execNow(line: string, options: CommandOptions): Promise<Record<string, string>[]> {
    const { signal, timeout = DEFAULT_COMMAND_TIMEOUT_MS } = options;
    signal?.throwIfAborted();
    if (this.#closed) throw new NotConnectedError();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const answered = new Promise<Record<string, string>[]>((resolve, reject) => {
      this.#pending = { rows: [], resolve, reject };
      timer = setTimeout(
        () => reject(new CommandTimeoutError(parseCommand(line)?.name ?? line)),
        timeout,
      );
      onAbort = () => reject(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    let sent = false;
    try {
      await this.#transport.send(line);
      sent = true;
      return await answered;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (this.#pending !== null) {
        this.#pending = null;
        if (sent) this.#abandoned++;
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
      if (err) pending.reject(err);
      else pending.resolve(pending.rows);
      return;
    }
    if (cmd.name.startsWith("notify")) {
      // Events are to come; a notification is never part of an answer.
      return;
    }
    if (this.#abandoned > 0) return;
    // A data line, possibly several rows separated by "|".
    for (const row of splitCommandRows(trimmed)) {
      const parsed = parseCommand(row);
      if (parsed) this.#pending?.rows.push(parsed.params);
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
