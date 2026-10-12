import {
  type EventMap,
  type ClientOptions,
  type EventMiddleware,
  type AddrResolver,
  type ClientInfo,
  type KickedEvent,
  type Listener,
  type ServerEvent,
  type ServerEventName,
  type Unsubscribe,
  ClientStatus,
} from "./types.js";
import {
  type ChannelID,
  type ClientID,
  type Codec,
  type CommandMiddleware,
  type CommandOptions,
  type UID,
  asChannelID,
  asClientID,
  asUID,
  type Logger,
  ErrorCode,
  Reason,
  TeamspeakError,
  noopLogger,
} from "@honeybbq/teamspeak-core";
import { AlreadyConnectedError, CryptoInitError, RemovedError } from "./errors.js";
import { abortable, abortReason } from "./abort.js";
import { Identity, Crypt, getUidFromPublicKey, type UidAlgorithm } from "./crypto/index.js";
import { Resolver } from "./discovery/resolver.js";
import { PacketHandler } from "./transport/handler.js";
import { PacketType } from "./transport/packet.js";
import type { Packet } from "./transport/packet.js";
import { CommandTracker, appendReturnCode } from "./commands.js";
import { parseServerError } from "@honeybbq/teamspeak-core/internal";
import { uploadFileData, downloadFileData } from "./transfer.js";
import { buildCommandChain, buildEventChain } from "./events.js";
import { processInit1 } from "./handshake/crypt-handshake.js";
import {
  handleHandshakeInitIV,
  handleHandshakeExpand2,
  handleInitServer,
  prepareClientPassword,
} from "./handshake.js";
import { encodeRequest } from "@honeybbq/teamspeak-core";
import type { CommandExecutor, CommandRequest } from "@honeybbq/teamspeak-core";
import { handleNotification } from "./notifications.js";
import { parseCommand } from "@honeybbq/teamspeak-core";
import { CommandThrottle } from "./throttle.js";
import { splitCommandRows, sleep } from "@honeybbq/teamspeak-core/internal";
import { isAutoNicknameMatch } from "./helpers.js";
import type { FileUploadInfo, FileDownloadInfo } from "@honeybbq/teamspeak-core";
import { CommandTimeoutError, NotConnectedError } from "@honeybbq/teamspeak-core";
import { responseSpec } from "@honeybbq/teamspeak-core/internal";
import type { Readable, Writable } from "node:stream";
import type { SocketFactory, FileTransferSocketFactory } from "./types.js";
import { unknownServerCapabilities, type ServerCapabilities } from "./capabilities.js";
import { joinHostPort, splitHostPort } from "./address.js";
import { commandChannel, packetChannel, type CommandTrace } from "./diagnostics.js";
import {
  backoffDelay,
  defaultShouldRetry,
  resolveBackoffPolicy,
  type ReconnectOptions,
} from "./reconnect.js";

export { ClientStatus };

interface ClientInitOptions {
  readonly serverPassword: string;
  readonly defaultChannel: string;
  readonly defaultChannelPassword: string;
}

function normalizeClientInitOptions(options: ClientOptions): ClientInitOptions {
  return {
    serverPassword: options.serverPassword ?? "",
    defaultChannel: options.defaultChannel ?? "",
    defaultChannelPassword: options.defaultChannelPassword ?? "",
  };
}

/** How long a command waits for its answer unless told otherwise. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * How long `disconnect()` waits for the server to acknowledge its goodbye
 * unless told otherwise: the acknowledgement is a courtesy, and a connection
 * that has already died would otherwise hold it for a full command timeout.
 */
const DISCONNECT_TIMEOUT_MS = 1_000;

/** How long each reconnection attempt may take. */
const RECONNECT_ATTEMPT_TIMEOUT_MS = 30_000;

/** One connection attempt, settled once by the handshake or its failure. */
interface ConnectAttempt {
  readonly promise: Promise<void>;
  /**
   * Aborted when the attempt fails, is abandoned, or is interrupted by
   * disconnect(), so the address lookup and the socket being opened for it
   * stop too instead of finishing a connection nobody wants.
   */
  readonly signal: AbortSignal;
  settled: boolean;
  resolve(): void;
  reject(error: unknown): void;
}

function newConnectAttempt(): ConnectAttempt {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The failure is reported to whoever awaits connect(); an attempt nobody
  // awaits any more must not surface as an unhandled rejection.
  promise.catch(() => {});
  const controller = new AbortController();
  const attempt: ConnectAttempt = {
    promise,
    signal: controller.signal,
    settled: false,
    resolve() {
      if (attempt.settled) return;
      attempt.settled = true;
      resolve();
    },
    reject(error) {
      if (attempt.settled) return;
      attempt.settled = true;
      controller.abort(error);
      reject(error);
    },
  };
  return attempt;
}

/**
 * Voice deliveries are dropped while more than this many deliveries of any
 * kind are waiting: audio is fifty packets a second per speaker, and a
 * listener that cannot keep up would otherwise queue it without bound.
 */
const MAX_PENDING_DELIVERIES = 256;

/** How often dropped voice is reported, at most. */
const VOICE_DROP_WARN_INTERVAL_MS = 10_000;

interface Subscription {
  readonly listener: (payload: unknown) => void;
  removed: boolean;
}

/**
 * A TeamSpeak client over the voice protocol.
 *
 * Listeners run one at a time, in the order their events arrived, after the
 * packet that carried them has been handled, so a listener may call the client
 * and await an answer.
 */
export class Client implements CommandExecutor, AsyncDisposable {
  // Internal — accessible from handshake.ts helpers
  /** @internal */ crypt: Crypt;
  /** @internal */ handler: PacketHandler;
  /** @internal */ logger: Logger;
  /** @internal */ nickname: string;
  /** @internal */ clid = 0;
  /**
   * What the server reported about itself in initserver, including the UID
   * hash it uses: TS3 hashes the public key with SHA-1 and TS6 with SHA-256.
   */
  /** @internal */ capabilities: ServerCapabilities = unknownServerCapabilities();

  /** @internal */ uidAlgorithm: UidAlgorithm = "sha1";

  #identity: Identity;
  #addr: string;
  #resolver: AddrResolver;
  #clientInitOptions: ClientInitOptions;
  #socketFactory: SocketFactory | undefined;
  #fileTransferSocketFactory: FileTransferSocketFactory | undefined;
  #reconnectOptions: ReconnectOptions;
  /**
   * Set while a reconnect attempt is in flight, so overlapping failures do not
   * start competing loops.
   */
  #reconnecting = false;
  /** Set by an explicit disconnect(), which must never be undone by a retry. */
  #stopped = false;
  /** Cuts short the reconnect loop's wait, on disconnect(). */
  #stopReconnecting: AbortController | undefined;
  #status: ClientStatus = ClientStatus.Disconnected;
  #throttle = new CommandThrottle();
  #cmdTrack = new CommandTracker(() => this.clid);
  #clients = new Map<number, ClientInfo>();
  #attempt: ConnectAttempt = newConnectAttempt();

  #listeners = new Map<keyof EventMap, Subscription[]>();
  /** Deliveries waiting for their turn; see #emit. */
  #queue: Array<() => void> = [];
  #draining = false;
  #voiceDropped = 0;
  #voiceDropWarnedAt = -Infinity;

  #eventMiddlewares: readonly EventMiddleware[];
  #finalCmdHandler: (cmd: string) => Promise<void>;
  #eventChain: (event: ServerEvent) => void;

  constructor(identity: Identity, addr: string, nickname: string, options: ClientOptions = {}) {
    this.#identity = identity;
    this.#addr = addr;
    this.nickname = nickname;
    this.logger = options.logger ?? noopLogger;
    this.#resolver = options.resolver ?? new Resolver(this.logger);
    this.#clientInitOptions = normalizeClientInitOptions(options);
    this.#socketFactory = options.socketFactory;
    this.#fileTransferSocketFactory = options.fileTransferSocketFactory;
    this.#reconnectOptions = options.reconnect ?? {};

    this.crypt = new Crypt(identity);
    this.handler = this.#newHandler();

    // Built once: the chains are read on every command and event, and
    // changing them while those run would make the behaviour depend on timing.
    const cmdMiddlewares: readonly CommandMiddleware[] = options.commandMiddleware ?? [];
    this.#eventMiddlewares = options.eventMiddleware ?? [];
    this.#finalCmdHandler = buildCommandChain([...cmdMiddlewares], async (cmd) => {
      this.handler.sendPacket(PacketType.Command, Buffer.from(cmd), 0);
    });
    this.#eventChain = buildEventChain([...this.#eventMiddlewares], (event) =>
      this.#deliver(event.name, event.payload),
    );
  }

  /** Where the client is in its connection's life. */
  get status(): ClientStatus {
    return this.#status;
  }

  /** @internal */
  getClientInitOptions(): Readonly<{
    serverPassword: string;
    defaultChannel: string;
    defaultChannelPassword: string;
  }> {
    return this.#clientInitOptions;
  }

  // ---- Connection -----------------------------------------------------------

  /**
   * Connect to the server. Resolves once the handshake completes.
   *
   * A failed attempt rejects with its cause, such as the server's error for a
   * rejected password. Aborting `signal` abandons the attempt and rejects with
   * the signal's reason. The signal bounds only the connecting: once this
   * resolves, the connection lasts until `disconnect()` or a drop.
   * `connect()` does not retry; the `reconnect` option only retries a
   * connection that drops after it was established.
   */
  async connect(options: { readonly signal?: AbortSignal | undefined } = {}): Promise<void> {
    const { signal } = options;
    signal?.throwIfAborted();
    if (this.#status !== ClientStatus.Disconnected) throw new AlreadyConnectedError();
    this.#stopped = false;

    this.#resetForConnect();
    this.#status = ClientStatus.Connecting;
    const attempt = this.#attempt;

    // The handshake may complete just as the signal fires, in which case
    // #failConnection leaves the session alone and the caller gets the
    // connection it made rather than one it would believe had failed.
    const onAbort = (): void => this.#failConnection(abortReason(signal!));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        const targetAddr = await this.#resolveAddr(attempt.signal);
        if (!attempt.settled) {
          this.logger.info("connecting to server", { address: targetAddr });
          await this.handler.connect(targetAddr, attempt.signal);
        }
      } catch (error) {
        // Without this the client stays Connecting and every later connect()
        // fails with AlreadyConnectedError.
        this.#failConnection(error);
      }
      await attempt.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Leave the server and close the connection.
   *
   * Says goodbye first, waiting for the server's acknowledgement until `signal`
   * aborts, or for a second. The connection is closed either way. A
   * `connect()` still waiting for its handshake rejects with a
   * NotConnectedError, and so do the commands still waiting for an answer.
   * Does nothing on a client that is not connected.
   */
  async disconnect(options: { readonly signal?: AbortSignal | undefined } = {}): Promise<void> {
    // Recorded before anything else: a dropped socket during the goodbye below
    // must not be mistaken for an outage worth retrying.
    this.#stopped = true;
    this.#stopReconnecting?.abort();

    if (this.#status === ClientStatus.Disconnected) return;

    const wasConnected = this.#status === ClientStatus.Connected;
    this.#status = ClientStatus.Disconnected;
    this.#attempt.reject(new NotConnectedError());

    this.logger.info("disconnecting from server");

    if (wasConnected) {
      try {
        await this.#exec("clientdisconnect reasonmsg=Shutdown", {
          signal: options.signal,
          timeout: DISCONNECT_TIMEOUT_MS,
        });
      } catch {
        // A courtesy; the connection closes regardless.
      }
    }

    this.handler.close();
    this.#cmdTrack.reset(new NotConnectedError());
    // Announced here; #handleConnectionClosed stays quiet once the status is
    // already Disconnected, so listeners hear about it once.
    this.#emit("disconnected", undefined);
  }

  /** `await using client = …` disconnects when the scope ends. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.disconnect();
  }

  // ---- Commands ------------------------------------------------------------

  /**
   * Send a raw command line and return the rows that answer it: the escape
   * hatch for a command the typed functions do not cover. The line is sent as
   * given, so its values must already be escaped and any channel password
   * already hashed.
   */
  exec(command: string, options: CommandOptions = {}): Promise<Record<string, string>[]> {
    return this.#exec(command, options);
  }

  /**
   * Send a raw command line without waiting for an answer, for the few
   * commands the server answers with nothing at all.
   *
   * Commands are paced by a flood throttle; aborting `signal` while this waits
   * for its turn rejects with the signal's reason and sends nothing. Rejects
   * with a NotConnectedError when there is no connection to send on.
   */
  async execNoWait(
    command: string,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    const { signal } = options;
    signal?.throwIfAborted();
    if (!this.handler.isOpen) throw new NotConnectedError();
    await this.#throttle.wait(signal);
    if (!this.handler.isOpen) throw new NotConnectedError();
    await this.#finalCmdHandler(command);
  }

  /**
   * Send a typed command; this is the CommandExecutor the typed commands run on.
   *
   * Channel passwords are hashed here because that is this protocol's rule:
   * the voice protocol expects `base64(sha1(password))`, where ServerQuery
   * takes the password itself.
   */
  send(request: CommandRequest, options: CommandOptions = {}): Promise<Record<string, string>[]> {
    return this.#exec(encodeRequest(request, prepareClientPassword), options);
  }

  #exec(command: string, options: CommandOptions): Promise<Record<string, string>[]> {
    if (!commandChannel.hasSubscribers) return this.#execUntraced(command, options);
    const trace: CommandTrace = { command: parseCommand(command)?.name ?? "", client: this };
    return commandChannel.tracePromise(() => this.#execUntraced(command, options), trace);
  }

  async #execUntraced(command: string, options: CommandOptions): Promise<Record<string, string>[]> {
    const { signal, timeout = DEFAULT_COMMAND_TIMEOUT_MS } = options;
    signal?.throwIfAborted();
    // A command sent on no socket used to vanish and surface 10 seconds later
    // as a timeout, which reads like a slow server rather than a usage error.
    if (!this.handler.isOpen) throw new NotConnectedError();

    // Which notifications answer this command, and — for answers that arrive
    // after the `error` — the request field they echo back.
    const parsed = parseCommand(command);
    const spec = responseSpec(parsed?.name ?? "");
    const key = spec?.correlated?.key;
    const correlation = key === undefined ? undefined : parsed?.params[key];

    const [rc, answered] = this.#cmdTrack.register(spec, correlation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    // Started before the throttle: the timeout bounds the whole command, its
    // wait for a turn included, and so does the signal.
    const givenUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CommandTimeoutError(parsed?.name ?? command)), timeout);
      onAbort = () => reject(abortReason(signal!));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    givenUp.catch(() => {});
    const throttleAbort = new AbortController();
    try {
      const withRc = appendReturnCode(command, rc);
      await Promise.race([this.#throttle.wait(throttleAbort.signal), givenUp]);
      if (!this.handler.isOpen) throw new NotConnectedError();
      await this.#finalCmdHandler(withRc);

      const result = await Promise.race([answered, givenUp]);
      if (result.err) throw result.err;
      return result.data;
    } finally {
      // A command given up while it waited for its turn gives the turn back.
      throttleAbort.abort();
      // Cleared, not left to fire: a pending timer keeps the process alive for
      // the full timeout after the last command has long been answered.
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.#cmdTrack.unregister(rc);
    }
  }

  // ---- Events --------------------------------------------------------------

  /** Listen for an event. Returns a function that removes the listener. */
  on<K extends keyof EventMap>(event: K, listener: Listener<K>): Unsubscribe {
    const subscription: Subscription = {
      listener: listener as (payload: unknown) => void,
      removed: false,
    };
    // A new array rather than an edit in place: a delivery may be iterating
    // over the old one.
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), subscription]);

    const unsubscribe = (): void => {
      if (subscription.removed) return;
      subscription.removed = true;
      const list = this.#listeners.get(event) ?? [];
      this.#listeners.set(
        event,
        list.filter((s) => s !== subscription),
      );
    };
    return Object.assign(unsubscribe, { [Symbol.dispose]: unsubscribe });
  }

  /** Listen for the next occurrence of an event only. */
  once<K extends keyof EventMap>(event: K, listener: Listener<K>): Unsubscribe {
    const unsubscribe = this.on(event, ((payload: EventMap[K]) => {
      unsubscribe();
      (listener as (payload: EventMap[K]) => void)(payload);
    }) as Listener<K>);
    return unsubscribe;
  }

  /**
   * An event as an async iterator, for `for await`:
   *
   * ```ts
   * for await (const message of client.events("textMessage", { signal })) { … }
   * ```
   *
   * Events that arrive while the loop body runs are buffered, so none is
   * missed — except voice, of which at most 256 frames are buffered; the rest
   * are dropped, as for a listener that falls behind. Iteration ends when
   * `signal` aborts, when the loop exits early (`break`, `return`, a throw),
   * and — for every event but `disconnected` — when the client disconnects.
   * An abort stops listening at once and discards whatever is buffered.
   */
  events<K extends keyof EventMap>(
    event: K,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): AsyncIterableIterator<EventMap[K]> {
    const { signal } = options;
    const buffered: Array<EventMap[K]> = [];
    let wake: (() => void) | undefined;
    let ended = false;

    const stopListening = this.on(event, ((payload: EventMap[K]) => {
      if (ended) return;
      if (event === "voiceData" && buffered.length >= MAX_PENDING_DELIVERIES) {
        this.#dropVoice();
        return;
      }
      buffered.push(payload);
      wake?.();
    }) as Listener<K>);
    // Ends after what is already buffered, which arrived before the disconnect.
    const stopOnDisconnect =
      event === "disconnected"
        ? undefined
        : this.on("disconnected", () => {
            ended = true;
            stopListening();
            wake?.();
          });
    const cleanup = (): void => {
      ended = true;
      stopListening();
      stopOnDisconnect?.();
      signal?.removeEventListener("abort", abort);
      wake?.();
    };
    const abort = (): void => {
      buffered.length = 0;
      cleanup();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const iterator: AsyncIterableIterator<EventMap[K]> = {
      async next(): Promise<IteratorResult<EventMap[K]>> {
        while (buffered.length === 0 && !ended) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
        if (buffered.length > 0) return { value: buffered.shift()!, done: false };
        cleanup();
        return { value: undefined, done: true };
      },
      async return(): Promise<IteratorResult<EventMap[K]>> {
        buffered.length = 0;
        cleanup();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  // ---- API shorthand -------------------------------------------------------

  /** This client's id on the server, assigned in the handshake; 0 before it. */
  clientID(): ClientID {
    return asClientID(this.clid);
  }

  /**
   * What the connected server is: version, generation, and the uid hash it
   * uses. Populated from `initserver`; before connecting it reads as TS3.
   */
  serverCapabilities(): ServerCapabilities {
    return this.capabilities;
  }

  /**
   * Our own `client_unique_identifier`, hashed with the algorithm the connected
   * server uses.
   *
   * TS3 uses SHA-1 and TS6 SHA-256, so this reads the algorithm learned during
   * initserver rather than assuming one. Comparing a hard-coded SHA-1 UID to a
   * TS6 server silently never matches.
   */
  uniqueIdentifier(): UID {
    return asUID(getUidFromPublicKey(this.#identity.publicKeyBase64(), this.uidAlgorithm));
  }

  /** The channel this client is in, as it last learned; 0 before connecting. */
  channelID(): ChannelID {
    return this.#clients.get(this.clid)?.channelID ?? asChannelID(0n);
  }

  /**
   * Send Opus voice directly to specific clients, bypassing channel routing.
   * Throws a NotConnectedError when there is no connection to send on.
   */
  sendWhisper(data: Uint8Array, targetClientIDs: readonly ClientID[], codec: Codec): void {
    if (!this.handler.isOpen) throw new NotConnectedError();
    this.handler.sendWhisperPacket(data, [...targetClientIDs], codec);
  }

  /**
   * Send one encoded audio frame to the channel this client is in. Throws a
   * NotConnectedError when there is no connection to send on.
   */
  sendVoice(data: Uint8Array, codec: Codec): void {
    if (!this.handler.isOpen) throw new NotConnectedError();
    this.handler.sendVoicePacket(data, codec);
  }

  // ---- File Transfer -------------------------------------------------------

  /**
   * Upload `data` over a negotiated transfer, through the client's
   * `fileTransferSocketFactory` if it has one.
   */
  uploadFileData(
    host: string,
    info: FileUploadInfo,
    data: Readable,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    return uploadFileData(host, info, data, {
      ...options,
      socketFactory: this.#fileTransferSocketFactory,
    });
  }

  /**
   * Download a negotiated transfer into `dest`, through the client's
   * `fileTransferSocketFactory` if it has one.
   */
  downloadFileData(
    host: string,
    info: FileDownloadInfo,
    dest: Writable,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    return downloadFileData(host, info, dest, {
      ...options,
      socketFactory: this.#fileTransferSocketFactory,
    });
  }

  // ---- Internal (package-visible) ------------------------------------------

  /** @internal */
  _markConnected(): void {
    // Only the attempt in progress can complete: never one that disconnect()
    // or a failure has already ended.
    if (this.#status !== ClientStatus.Connecting || this.#attempt.settled) return;
    this.#status = ClientStatus.Connected;
    this.#attempt.resolve();
    this.#emit("connected", undefined);
  }

  // ---- Private -------------------------------------------------------------

  #newHandler(): PacketHandler {
    const handler = new PacketHandler(this.crypt, this.logger, this.#socketFactory);
    // Each callback checks that its handler is still the current one: a
    // packet or close reported late by one a later connect() already replaced
    // must not reach, or tear down, the new connection.
    handler.onPacket = (p) => {
      if (handler === this.handler) this.#handlePacket(p);
    };
    handler.onClosed = (err) => {
      if (handler === this.handler) this.#handleConnectionClosed(err);
    };
    handler.onReceiveError = (error) => {
      if (handler === this.handler) this.#handleReceiveError(error);
    };
    return handler;
  }

  #resetForConnect(): void {
    this.handler.close();
    this.crypt = new Crypt(this.#identity);
    this.handler = this.#newHandler();
    this.#attempt = newConnectAttempt();
    this.#cmdTrack.reset(new NotConnectedError());
    this.#clients.clear();
    this.clid = 0;
    this.uidAlgorithm = "sha1";
    this.capabilities = unknownServerCapabilities();
  }

  async #resolveAddr(signal: AbortSignal | undefined): Promise<string> {
    // Parsed, not tested for a colon: an IPv6 literal has colons and no port.
    const { host, port } = splitHostPort(this.#addr);
    const fallback = joinHostPort(host, port);
    try {
      // Raced against the signal: a resolver that ignores it must still not
      // hold up an attempt that has been given up.
      const resolved = await abortable(this.#resolver.resolve(this.#addr, signal), signal);
      return resolved[0]?.addr ?? fallback;
    } catch (error) {
      signal?.throwIfAborted();
      this.logger.warn("address resolution failed, falling back to direct", {
        error: String(error),
      });
      return fallback;
    }
  }

  /**
   * A datagram from the server could not be handled. During the handshake that
   * is the connection failing, reported as a CryptoInitError with the cause;
   * once connected, one bad packet is not worth the session, so it is dropped.
   */
  #handleReceiveError(error: unknown): void {
    if (this.#status !== ClientStatus.Connected) {
      this.#failConnection(
        error instanceof CryptoInitError
          ? error
          : new CryptoInitError("the handshake failed on a malformed packet", { cause: error }),
      );
      return;
    }
    this.logger.debug("dropped a malformed packet", { error: String(error) });
  }

  #handlePacket(p: Packet): void {
    const pType = p.typeFlagged & 0x0f;
    if (pType === 8 /* Init1 */) {
      if (this.crypt.cryptoInitComplete) return;
      const response = processInit1(this.crypt, p.data);
      if (response) {
        this.handler.sendPacket(PacketType.Init1, response, 0);
      }
      return;
    }

    if ((pType === 0 /* Voice */ || pType === 1) /* VoiceWhisper */ && p.data.length > 5) {
      this.#handleVoicePacket(p.data);
      return;
    }

    if ((pType === 2 /* Command */ || pType === 3) /* CommandLow */ && p.data.length > 0) {
      this.#handleCommandLines(Buffer.from(p.data).toString("utf8"));
    }
  }

  /**
   * Parse an incoming S2C voice packet.
   * Format: [VId: u16] [CId: u16] [Codec: u8] [Data: var]
   */
  #handleVoicePacket(payload: Uint8Array): void {
    // Audio arrives fifty times a second per speaker; build no event nobody
    // will see.
    if (!this.#listeners.get("voiceData")?.length && this.#eventMiddlewares.length === 0) return;
    if (this.#queue.length > MAX_PENDING_DELIVERIES) {
      this.#dropVoice();
      return;
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const clientId = view.getUint16(2, false);
    if (clientId === this.clid) return;

    // Copied: the packet's buffer is reused once this returns, and a listener
    // runs later.
    const data = payload.slice(5);
    this.#emitServerEvent({
      name: "voiceData",
      payload: { clientID: asClientID(clientId), codec: payload[4]! as Codec, data },
    });
  }

  #handleCommandLines(s: string): void {
    if (!s) return;
    const lines = s.split("\0").join("\n").split("\n");
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed) continue;
      for (const row of splitCommandRows(trimmed)) {
        this.#handleCommandStr(row);
      }
    }
  }

  #handleCommandStr(s: string): void {
    const cmd = parseCommand(s);
    if (!cmd) return;
    if (packetChannel.hasSubscribers) packetChannel.publish({ command: cmd.name, client: this });

    // No name means a response row: the server sends data without echoing the
    // command, so the row belongs to whichever command is awaiting a result.
    if (cmd.name === "") {
      if (Object.keys(cmd.params).length > 0) this.#cmdTrack.buffer(cmd.params);
      return;
    }

    // `channellistfinished` ends the server's welcome sequence. It carries no
    // data of its own, so it is the only reliable marker: the guard used to
    // trip on our own notifycliententerview, which the server sends *in the
    // middle* of the sequence — the channellist rows after it were then
    // buffered as if they were the response to the caller's first command,
    // which is how a channellist could come back with duplicate and empty rows.
    if (cmd.name === "channellistfinished") {
      this.#cmdTrack.signalWelcomeComplete();
      return;
    }

    if (cmd.name.startsWith("notify")) {
      // Some commands are answered by a notification instead of data rows;
      // it still goes on to be dispatched as an event, since the same
      // notification also arrives unprompted.
      if (this.#cmdTrack.expects(cmd.name)) {
        this.#cmdTrack.buffer(cmd.params, cmd.name);
        this.#cmdTrack.offerCorrelated(cmd.name, cmd.params);
      }
      const result = handleNotification(cmd, this.clid, this.#clients, this.nickname);
      this.#processNotificationResult(result);
      if (this.#listeners.get("notification")?.length || this.#eventMiddlewares.length > 0) {
        this.#emitServerEvent({
          name: "notification",
          payload: { name: cmd.name, params: { ...cmd.params } },
        });
      }
      return;
    }

    switch (cmd.name) {
      // The handshake's steps happen once: repeated after crypto init, they
      // could only re-key or re-announce a session that is already set up.
      case "clientinitiv":
        if (!this.crypt.cryptoInitComplete) handleHandshakeInitIV(this, cmd.params);
        break;
      case "initivexpand2":
        if (!this.crypt.cryptoInitComplete) handleHandshakeExpand2(this, cmd.params);
        break;
      case "initserver":
        if (this.#status === ClientStatus.Connecting) handleInitServer(this, cmd.params);
        break;
      case "error":
        this.#handleError(cmd.params);
        break;
      default:
        // A named command the SDK does not model. Held under its own name, so
        // it answers a command only if that command declared it — not merely by
        // arriving while one is in flight.
        this.#cmdTrack.buffer(cmd.params, cmd.name);
        break;
    }
  }

  #handleError(params: Record<string, string>): void {
    const { err, rc } = parseServerError(params);
    if (rc !== null) {
      this.#cmdTrack.resolve(rc, err);
    } else {
      // No return_code: server is acknowledging an unsolicited command
      // (welcome-sequence channellist, no-RC commands like clientupdate, etc.).
      // Discard any rows buffered since the last resolved command.
      this.#cmdTrack.discardBuffer();
    }

    // A server error before the welcome sequence finished is the connection
    // failure itself — a rejected password, or an invalid clientinit parameter.
    // Report it as the cause instead of leaving the caller with a bare timeout.
    if (err && this.#status !== ClientStatus.Connected) {
      this.#failConnection(err);
      return;
    }

    if (err?.code === ErrorCode.ConnectFailedBanned) {
      this.logger.warn("banned by the server, closing the connection");
      setImmediate(() => this.disconnect().catch(() => {}));
    }
  }

  #processNotificationResult(result: import("./notifications.js").NotificationResult): void {
    switch (result.kind) {
      case "clientEnter": {
        const info = result.info;
        // Identify self by the clid initserver already assigned rather than by
        // nickname: any other client whose nickname happens to be "<our
        // nick><digits>" — which is how the server renames a client whose
        // nickname was taken — would otherwise be mistaken for us, poisoning
        // every outgoing packet header with a foreign clientID until the server
        // drops the connection for command-resend timeout.
        //
        // This no longer marks the end of the welcome sequence: the server
        // sends more welcome data after it, and `channellistfinished` is the
        // real terminator.
        if (info.id !== 0 && info.id === this.clid) {
          // Carries the rename the server applied if our nickname was taken.
          this.nickname = info.nickname;
        } else if (
          info.id !== 0 &&
          this.clid === 0 &&
          isAutoNicknameMatch(this.nickname, info.nickname)
        ) {
          // initserver carried no aclid, so the welcome enter is the only way
          // to learn our clid. Gated on clid still being unknown so a later
          // lookalike can never hijack an established session.
          this.clid = info.id;
          this.handler.setClientID(info.id);
          this.nickname = info.nickname;
        }
        this.#emitServerEvent({ name: "clientEnter", payload: info });
        break;
      }
      case "clientLeave": {
        const event = result.event;
        this.#emitServerEvent({ name: "clientLeave", payload: event });
        if (!result.isSelf) break;
        if (event.reason === Reason.KickServer || event.reason === Reason.KickServerBan) {
          this.#emit("kicked", kickedEvent(event));
        }
        this.#removedByServer(
          new RemovedError(event.reason, event.reasonMessage, event.invokerName),
        );
        break;
      }
      case "clientMoved":
        this.#emitServerEvent({ name: "clientMoved", payload: result.event });
        // A channel kick moves the client to the default channel; it arrives
        // as a move, not as leaving view, which is where it used to be looked
        // for.
        if (result.event.id === this.clid && result.event.reason === Reason.KickChannel) {
          this.#emit(
            "kicked",
            kickedEvent({ ...result.event, reasonMessage: result.reasonMessage }),
          );
        }
        break;
      case "textMessage":
        this.#emitServerEvent({ name: "textMessage", payload: result.message });
        break;
      case "poked":
        this.#emitServerEvent({ name: "poked", payload: result.event });
        break;
    }
  }

  /**
   * End a session the server has ended. The server stops answering a client it
   * has removed, so waiting for the transport to notice reported the end a
   * minute late, without its cause, and with the client claiming to be
   * connected meanwhile.
   */
  #removedByServer(cause: Error): void {
    this.#handleConnectionClosed(cause);
    this.handler.close();
  }

  /** Count a dropped voice delivery, and report the drops now and then. */
  #dropVoice(): void {
    this.#voiceDropped++;
    const now = Date.now();
    if (now - this.#voiceDropWarnedAt < VOICE_DROP_WARN_INTERVAL_MS) return;
    this.#voiceDropWarnedAt = now;
    this.logger.warn("voice dropped: listeners are not keeping up", {
      dropped: this.#voiceDropped,
    });
  }

  /** Queue a server event, through the event middleware. */
  #emitServerEvent(event: ServerEvent): void {
    this.#enqueue(() => this.#eventChain(event));
  }

  /** Queue a lifecycle event, which middleware does not see. */
  #emit<K extends Exclude<keyof EventMap, ServerEventName>>(event: K, payload: EventMap[K]): void {
    this.#enqueue(() => this.#deliver(event, payload));
  }

  #deliver<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const subscription of this.#listeners.get(event) ?? []) {
      // Checked at delivery: a listener removed while its event was queued
      // does not get it.
      if (!subscription.removed) subscription.listener(payload);
    }
  }

  /**
   * Run deliveries one at a time, in order, once the packet being handled is
   * done with. A listener that throws does so as an uncaught exception, as it
   * would from an EventEmitter, and the deliveries behind it still run.
   */
  #enqueue(delivery: () => void): void {
    this.#queue.push(delivery);
    if (this.#draining) return;
    this.#draining = true;
    setImmediate(this.#drain);
  }

  #drain = (): void => {
    try {
      while (this.#queue.length > 0) this.#queue.shift()!();
    } finally {
      if (this.#queue.length > 0) setImmediate(this.#drain);
      else this.#draining = false;
    }
  };

  #handleConnectionClosed(err: Error | null): void {
    if (this.#status === ClientStatus.Disconnected) return;
    // Nothing in flight can be answered any more; failing it now, with the
    // reason, beats every caller timing out one by one.
    this.#cmdTrack.reset(new NotConnectedError(err ? { cause: err } : undefined));
    if (this.#status !== ClientStatus.Connected) {
      // The socket closed before the handshake finished, so this is a failed
      // connection attempt rather than a disconnect of a live session.
      this.#failConnection(
        err ?? new TeamspeakError("connection closed before the TeamSpeak handshake completed"),
      );
      return;
    }
    this.#status = ClientStatus.Disconnected;
    // Never undefined for a drop: undefined means disconnect() only.
    const cause = err ?? new TeamspeakError("connection closed");

    // Announced first, then retried: a caller watching `disconnected` should
    // hear about the drop even when a reconnect is already on its way, because
    // a silent recovery hides an outage.
    this.#emit("disconnected", cause);
    this.#scheduleReconnect(cause).catch((error: unknown) => {
      this.logger.error("reconnecting failed", { error: String(error) });
    });
  }

  /**
   * Retry a dropped connection according to the reconnect policy.
   *
   * Never runs after an explicit disconnect, and never more than one at a time:
   * two failures in quick succession would otherwise start competing loops, and
   * a loop shorter than the server's antiflood window bans the IP rather than
   * reconnecting it.
   */
  async #scheduleReconnect(err: Error): Promise<void> {
    const options = this.#reconnectOptions;
    if (!options.enabled || this.#stopped || this.#reconnecting) return;

    const policy = resolveBackoffPolicy(options);
    const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

    this.#reconnecting = true;

    const stop = new AbortController();
    this.#stopReconnecting = stop;
    try {
      for (let attempt = 1; policy.maxAttempts === 0 || attempt <= policy.maxAttempts; attempt++) {
        if (this.#stopped) return;
        let retry: boolean;
        try {
          retry = shouldRetry(err, attempt);
        } catch (error) {
          this.logger.error("shouldRetry threw; not reconnecting", { error: String(error) });
          return;
        }
        if (!retry) {
          this.logger.info("not retrying", { attempt, reason: err.message });
          return;
        }

        const delay = backoffDelay(policy, attempt);
        this.logger.info("reconnecting", { attempt, delayMs: delay });
        // A timer that keeps the process alive: an application that does
        // nothing but stay connected would otherwise exit during the wait.
        await sleep(delay, stop.signal);
        if (this.#stopped) return;

        try {
          await this.connect({ signal: AbortSignal.timeout(RECONNECT_ATTEMPT_TIMEOUT_MS) });
          this.logger.info("reconnected", { attempt });
          return;
        } catch (retryErr) {
          err = retryErr instanceof Error ? retryErr : new TeamspeakError(String(retryErr));
        }
      }
      this.logger.warn("reconnect attempts exhausted", { attempts: policy.maxAttempts });
    } finally {
      this.#reconnecting = false;
      if (this.#stopReconnecting === stop) this.#stopReconnecting = undefined;
    }
  }

  /**
   * A connection attempt has failed for good: settle it with the cause, and
   * tear the connection down. Does nothing once the handshake has completed,
   * so it cannot end a live session.
   *
   * Without this, a handshake the server rejects (a wrong password, say, which
   * the server answers with an error instead of closing the socket) surfaces
   * only as the caller's own timeout, and the client stays in `Connecting`
   * forever without ever emitting `disconnected`.
   */
  #failConnection(error: unknown): void {
    if (this.#status === ClientStatus.Connected) return;
    this.#attempt.reject(error);

    if (this.#status === ClientStatus.Disconnected) return;
    this.#status = ClientStatus.Disconnected;
    this.handler.close();
    this.#emit("disconnected", error instanceof Error ? error : new TeamspeakError(String(error)));
  }
}

function kickedEvent(event: {
  readonly reason: number;
  readonly reasonMessage: string;
  readonly invokerName: string;
  readonly invokerUID: UID;
  readonly invokerID: ClientID;
}): KickedEvent {
  return {
    reason: event.reason,
    reasonMessage: event.reasonMessage,
    invokerName: event.invokerName,
    invokerUID: event.invokerUID,
    invokerID: event.invokerID,
  };
}
