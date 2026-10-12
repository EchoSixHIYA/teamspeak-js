import {
  type EventMap,
  type ClientOptions,
  type CommandMiddleware,
  type EventMiddleware,
  type Logger,
  type AddrResolver,
  type ClientInfo,
  ClientStatus,
  consoleLogger,
} from "./types.js";
import { AlreadyConnectedError } from "./errors.js";
import { Identity, Crypt, getUidFromPublicKey, type UidAlgorithm } from "./crypto/index.js";
import { Resolver } from "./discovery/resolver.js";
import { PacketHandler } from "./transport/handler.js";
import { PacketType } from "./transport/packet.js";
import type { Packet } from "./transport/packet.js";
import { CommandTracker, appendReturnCode, parseServerError } from "./commands.js";
import { uploadFileData, downloadFileData } from "./transfer.js";
import { buildCommandChain, buildEventChain } from "./events.js";
import { processInit1 } from "./handshake/crypt-handshake.js";
import {
  handleHandshakeInitIV,
  handleHandshakeExpand2,
  handleInitServer,
  prepareClientPassword,
} from "./handshake.js";
import { encodeRequest } from "./command/request.js";
import type { CommandExecutor, CommandRequest } from "./command/request.js";
import { handleNotification } from "./notifications.js";
import { parseCommand } from "./command/parser.js";
import { CommandThrottle } from "./throttle.js";
import { splitCommandRows, isAutoNicknameMatch, sleep } from "./helpers.js";
import type { FileUploadInfo, FileDownloadInfo } from "./types.js";
import { CommandTimeoutError, NotConnectedError } from "./errors.js";
import { responseSpec } from "./command/responses.js";
import type { Readable, Writable } from "node:stream";
import type { SocketFactory, FileTransferSocketFactory } from "./types.js";
import { unknownServerCapabilities, type ServerCapabilities } from "./capabilities.js";
import {
  backoffDelay,
  isPermanentFailure,
  resolveBackoffPolicy,
  type ReconnectOptions,
} from "./reconnect.js";

export { ClientStatus };

export interface ClientState {
  status: ClientStatus;
  clid: number;
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (arg: any) => void;

export class Client implements CommandExecutor {
  // Internal — accessible from handshake.ts helpers
  /** @internal */ crypt: Crypt;
  /** @internal */ handler: PacketHandler;
  /** @internal */ logger: Logger;
  /** @internal */ nickname: string;
  /** @internal */ clid = 0;
  /**
   * The UID hash the connected server uses, learned from `virtualserver_version`
   * during initserver. TS3 hashes the public key with SHA-1 and TS6 with
   * SHA-256, so anything comparing our UID to the server's needs this.
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
  #status: ClientStatus = ClientStatus.Disconnected;
  #throttle = new CommandThrottle();
  #cmdTrack = new CommandTracker(() => this.clid);
  #clients = new Map<number, ClientInfo>();
  #connectedResolvers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  #connectionError: Error | null = null;

  // Event handler lists
  #textMsgHandlers: Array<(msg: import("./types.js").TextMessage) => void> = [];
  #clientEnterHandlers: Array<(info: ClientInfo) => void> = [];
  #clientLeaveHandlers: Array<(evt: import("./types.js").ClientLeftViewEvent) => void> = [];
  #clientMoveHandlers: Array<(evt: import("./types.js").ClientMovedEvent) => void> = [];
  #pokedHandlers: Array<(evt: import("./types.js").PokeEvent) => void> = [];
  #voiceDataHandlers: Array<(data: import("./types.js").VoiceData) => void> = [];
  #connectedHandlers: Array<() => void> = [];
  #disconnectedHandlers: Array<(err: Error | undefined) => void> = [];
  #kickedHandlers: Array<(msg: string) => void> = [];

  // Middleware
  #cmdMiddlewares: CommandMiddleware[] = [];
  #eventMiddlewares: EventMiddleware[] = [];
  #finalCmdHandler: (cmd: string) => Promise<void>;
  #finalEvtHandler: (evt: EventMap[keyof EventMap]) => void;

  constructor(identity: Identity, addr: string, nickname: string, options: ClientOptions = {}) {
    this.#identity = identity;
    this.#addr = addr;
    this.nickname = nickname;
    this.logger = options.logger ?? consoleLogger;
    this.#resolver = options.resolver ?? new Resolver(this.logger);
    this.#clientInitOptions = normalizeClientInitOptions(options);
    this.#socketFactory = options.socketFactory;
    this.#fileTransferSocketFactory = options.fileTransferSocketFactory;
    this.#reconnectOptions = options.reconnect ?? {};

    this.crypt = new Crypt(identity);
    this.handler = new PacketHandler(this.crypt, this.logger, this.#socketFactory);
    this.handler.onPacket = (p) => this.#handlePacket(p);
    this.handler.onClosed = (err) => this.#handleConnectionClosed(err);

    if (options.commandMiddleware) {
      this.#cmdMiddlewares.push(...options.commandMiddleware);
    }
    if (options.eventMiddleware) {
      this.#eventMiddlewares.push(...options.eventMiddleware);
    }

    this.#finalCmdHandler = this.#buildCmdHandler();
    this.#finalEvtHandler = this.#buildEvtHandler();
  }

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

  async connect(): Promise<void> {
    this.#stopped = false;

    if (this.#status !== ClientStatus.Disconnected) {
      throw new AlreadyConnectedError();
    }

    this.#resetForConnect();
    this.#status = ClientStatus.Connecting;

    const targetAddr = await this.#resolveAddr();
    this.logger.info("connecting to server", { address: targetAddr });
    await this.handler.connect(targetAddr);
  }

  async disconnect(): Promise<void> {
    // Recorded before anything else: a dropped socket during the shutdown
    // command below must not be mistaken for an outage worth retrying.
    this.#stopped = true;

    if (this.#status === ClientStatus.Disconnected) return;

    const wasConnected = this.#status === ClientStatus.Connected;
    this.#status = ClientStatus.Disconnected;

    this.logger.info("disconnecting from server");

    if (wasConnected) {
      try {
        await this.execCommand("clientdisconnect reasonmsg=Shutdown", 1000);
      } catch {
        // best-effort
      }
    }

    this.handler.close();
    this.#cmdTrack.reset(new NotConnectedError());
    const handlers = this.#disconnectedHandlers.slice();
    for (const h of handlers) setImmediate(() => h(undefined));
  }

  waitConnected(signal?: AbortSignal): Promise<void> {
    if (this.#status === ClientStatus.Connected) return Promise.resolve();
    if (this.#connectionError) return Promise.reject(this.#connectionError);
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        const index = this.#connectedResolvers.indexOf(waiter);
        if (index >= 0) this.#connectedResolvers.splice(index, 1);
        const reason: unknown = signal?.reason;
        waiter.reject(
          reason instanceof Error ? reason : new Error(String(reason ?? "Connection wait aborted")),
        );
      };
      this.#connectedResolvers.push(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ---- Commands ------------------------------------------------------------

  async sendCommandNoWait(cmd: string): Promise<void> {
    await this.#throttle.wait();
    await this.#finalCmdHandler(cmd);
  }

  /**
   * Send a typed command; this is the CommandExecutor the typed commands run on.
   *
   * Channel passwords are hashed here because that is this protocol's rule:
   * the voice protocol expects `base64(sha1(password))`, where ServerQuery
   * takes the password itself.
   */
  send(request: CommandRequest): Promise<Record<string, string>[]> {
    return this.execCommandWithResponse(encodeRequest(request, prepareClientPassword));
  }

  async execCommand(cmd: string, timeoutMs = 10_000): Promise<void> {
    await this.execCommandWithResponse(cmd, timeoutMs);
  }

  async execCommandWithResponse(
    cmd: string,
    timeoutMs = 10_000,
  ): Promise<Record<string, string>[]> {
    // A command sent on no socket used to vanish and surface 10 seconds later
    // as a timeout, which reads like a slow server rather than a usage error.
    if (!this.handler.isOpen) throw new NotConnectedError();

    // Which notifications answer this command, and — for answers that arrive
    // after the `error` — the request field they echo back.
    const parsed = parseCommand(cmd);
    const spec = responseSpec(parsed?.name ?? "");
    const key = spec?.correlated?.key;
    const correlation = key === undefined ? undefined : parsed?.params[key];

    const [rc, promise] = this.#cmdTrack.register(spec, correlation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const withRc = appendReturnCode(cmd, rc);
      await this.#throttle.wait();
      await this.#finalCmdHandler(withRc);

      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CommandTimeoutError(cmd)), timeoutMs);
        }),
      ]);
      if (result.err) throw result.err;
      return result.data;
    } finally {
      // Cleared, not left to fire: a pending timer keeps the process alive for
      // the full timeout after the last command has long been answered.
      clearTimeout(timer);
      this.#cmdTrack.unregister(rc);
    }
  }

  // ---- Events --------------------------------------------------------------

  on<K extends keyof EventMap>(
    event: K,
    handler: EventMap[K] extends void ? () => void : (payload: EventMap[K]) => void,
  ): this {
    switch (event) {
      case "textMessage":
        this.#textMsgHandlers.push(handler as AnyHandler);
        break;
      case "clientEnter":
        this.#clientEnterHandlers.push(handler as AnyHandler);
        break;
      case "clientLeave":
        this.#clientLeaveHandlers.push(handler as AnyHandler);
        break;
      case "clientMoved":
        this.#clientMoveHandlers.push(handler as AnyHandler);
        break;
      case "poked":
        this.#pokedHandlers.push(handler as AnyHandler);
        break;
      case "voiceData":
        this.#voiceDataHandlers.push(handler as AnyHandler);
        break;
      case "connected":
        this.#connectedHandlers.push(handler as () => void);
        break;
      case "disconnected":
        this.#disconnectedHandlers.push(handler as AnyHandler);
        break;
      case "kicked":
        this.#kickedHandlers.push(handler as AnyHandler);
        break;
    }
    return this;
  }

  useCommandMiddleware(...mw: CommandMiddleware[]): this {
    this.#cmdMiddlewares.push(...mw);
    this.#finalCmdHandler = this.#buildCmdHandler();
    return this;
  }

  useEventMiddleware(...mw: EventMiddleware[]): this {
    this.#eventMiddlewares.push(...mw);
    this.#finalEvtHandler = this.#buildEvtHandler();
    return this;
  }

  // ---- API shorthand -------------------------------------------------------

  clientID(): number {
    return this.clid;
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
  uniqueIdentifier(): string {
    return getUidFromPublicKey(this.#identity.publicKeyBase64(), this.uidAlgorithm);
  }

  channelID(): bigint {
    const info = this.#clients.get(this.clid);
    return info?.channelID ?? 0n;
  }

  /** Send Opus voice directly to specific clients, bypassing channel routing. */
  sendWhisper(data: Uint8Array, targetClientIds: number[], codec: number): void {
    this.handler.sendWhisperPacket(data, targetClientIds, codec);
  }

  sendVoice(data: Uint8Array, codec: number): void {
    this.handler.sendVoicePacket(data, codec);
  }

  // ---- File Transfer -------------------------------------------------------

  uploadFileData(host: string, info: FileUploadInfo, data: Readable): Promise<void> {
    return uploadFileData(host, info, data, this.#fileTransferSocketFactory);
  }

  downloadFileData(host: string, info: FileDownloadInfo, dest: Writable): Promise<void> {
    return downloadFileData(host, info, dest, this.#fileTransferSocketFactory);
  }

  // ---- Internal (package-visible) ------------------------------------------

  /** @internal */
  _markConnected(): void {
    this.#status = ClientStatus.Connected;
    this.#connectionError = null;
    for (const waiter of this.#connectedResolvers) waiter.resolve();
    this.#connectedResolvers = [];
    const handlers = this.#connectedHandlers.slice();
    for (const h of handlers) setImmediate(() => h());
  }

  // ---- Private -------------------------------------------------------------

  #resetForConnect(): void {
    // Waiters are deliberately left in place: connect() resets first, so a
    // caller that registered waitConnected() before calling connect() must
    // still be resolved by the handshake that follows. Clear only the error
    // carried over from a previous attempt.
    this.#connectionError = null;
    this.handler.close();
    this.crypt = new Crypt(this.#identity);
    this.handler = new PacketHandler(this.crypt, this.logger, this.#socketFactory);
    this.handler.onPacket = (p) => this.#handlePacket(p);
    this.handler.onClosed = (err) => this.#handleConnectionClosed(err);
    this.#cmdTrack.reset(new NotConnectedError());
    this.#clients.clear();
    this.clid = 0;
    this.#finalCmdHandler = this.#buildCmdHandler();
  }

  async #resolveAddr(): Promise<string> {
    const addrWithPort = this.#addr.includes(":") ? this.#addr : `${this.#addr}:9987`;
    try {
      const resolved = await this.#resolver.resolve(this.#addr);
      return resolved[0]?.addr ?? addrWithPort;
    } catch {
      return addrWithPort;
    }
  }

  #handlePacket(p: Packet): void {
    this.#handlePacketSync(p);
  }

  #handlePacketSync(p: Packet): void {
    const pType = p.typeFlagged & 0x0f;
    if (pType === 8 /* Init1 */) {
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
      const text = Buffer.from(p.data).toString("utf8");
      if (process.env["TEAMSPEAK_TRACE_RAW"]) process.stderr.write(`S2C ${JSON.stringify(text)}\n`);
      this.#handleCommandLines(text);
    }
  }

  /**
   * Parse an incoming S2C voice packet.
   * Format: [VId: u16] [CId: u16] [Codec: u8] [Data: var]
   */
  #handleVoicePacket(payload: Uint8Array): void {
    if (this.#voiceDataHandlers.length === 0) return;

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const clientId = view.getUint16(2, false);
    if (clientId === this.clid) return;

    const codec = payload[4]!;
    const data = payload.subarray(5);

    const voiceData: import("./types.js").VoiceData = { clientId, codec, data };
    for (const h of this.#voiceDataHandlers) setImmediate(() => h(voiceData));
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
      this.#processNotificationResult(result, cmd.params);
      return;
    }

    switch (cmd.name) {
      case "clientinitiv":
        handleHandshakeInitIV(this, cmd.params);
        break;
      case "initivexpand2":
        handleHandshakeExpand2(this, cmd.params);
        break;
      case "initserver":
        handleInitServer(this, cmd.params);
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

    const id = params["id"] ?? "0";
    if (id === "3329") {
      setImmediate(() => this.disconnect().catch(() => {}));
    }
  }

  #processNotificationResult(
    result: import("./notifications.js").NotificationResult,
    _params: Record<string, string>,
  ): void {
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
        this.#dispatchEvent("clientEnter", info);
        break;
      }
      case "clientLeave": {
        this.#dispatchEvent("clientLeave", result.event);
        if (result.isSelf && (result.event.reasonID === 4 || result.event.reasonID === 5)) {
          const msg = result.event.reasonMsg;
          for (const h of this.#kickedHandlers) setImmediate(() => h(msg));
        }
        break;
      }
      case "clientMoved":
        this.#dispatchEvent("clientMoved", result.event);
        break;
      case "textMessage":
        this.#dispatchEvent("textMessage", result.message);
        break;
      case "poked":
        this.#dispatchEvent("poked", result.event);
        break;
    }
  }

  #dispatchEvent<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.#finalEvtHandler(payload as EventMap[keyof EventMap]);
  }

  #dispatchEventDirect<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    switch (event) {
      case "textMessage":
        for (const h of this.#textMsgHandlers)
          setImmediate(() => h(payload as import("./types.js").TextMessage));
        break;
      case "clientEnter":
        for (const h of this.#clientEnterHandlers) setImmediate(() => h(payload as ClientInfo));
        break;
      case "clientLeave":
        for (const h of this.#clientLeaveHandlers)
          setImmediate(() => h(payload as import("./types.js").ClientLeftViewEvent));
        break;
      case "clientMoved":
        for (const h of this.#clientMoveHandlers)
          setImmediate(() => h(payload as import("./types.js").ClientMovedEvent));
        break;
      case "poked":
        for (const h of this.#pokedHandlers)
          setImmediate(() => h(payload as import("./types.js").PokeEvent));
        break;
    }
  }

  #handleConnectionClosed(err: Error | null): void {
    if (this.#status === ClientStatus.Disconnected) return;
    // Nothing in flight can be answered any more; failing it now, with the
    // reason, beats every caller timing out one by one.
    this.#cmdTrack.reset(new NotConnectedError(err ? { cause: err } : undefined));
    if (this.#status !== ClientStatus.Connected) {
      // The socket closed before the handshake finished, so this is a failed
      // connection attempt rather than a disconnect of a live session.
      this.#failConnection(
        err ?? new Error("Connection closed before the TeamSpeak handshake completed"),
      );
      return;
    }
    this.#status = ClientStatus.Disconnected;
    const handlers = this.#disconnectedHandlers.slice();
    for (const h of handlers) setImmediate(() => h(err ?? undefined));

    // Announced first, then retried: a caller watching `disconnected` should
    // hear about the drop even when a reconnect is already on its way, because
    // a silent recovery hides an outage.
    void this.#scheduleReconnect(err ?? undefined);
  }

  /**
   * Retry a dropped connection according to the reconnect policy.
   *
   * Never runs after an explicit disconnect, and never more than one at a time:
   * two failures in quick succession would otherwise start competing loops, and
   * a loop shorter than the server's antiflood window bans the IP rather than
   * reconnecting it.
   */
  async #scheduleReconnect(err: Error | undefined): Promise<void> {
    const options = this.#reconnectOptions;
    if (!options.enabled || this.#stopped || this.#reconnecting) return;

    const policy = resolveBackoffPolicy(options);
    const shouldRetry =
      options.shouldRetry ?? ((error: Error | undefined) => !isPermanentFailure(error));

    this.#reconnecting = true;

    try {
      for (let attempt = 1; policy.maxAttempts === 0 || attempt <= policy.maxAttempts; attempt++) {
        if (this.#stopped) return;
        if (!shouldRetry(err, attempt)) {
          this.logger.info("not retrying", { attempt, reason: err?.message });
          return;
        }

        const delay = backoffDelay(policy, attempt);
        this.logger.info("reconnecting", { attempt, delayMs: delay });
        await sleep(delay, () => this.#stopped);
        if (this.#stopped) return;

        try {
          await this.connect();
          await this.waitConnected();
          this.logger.info("reconnected", { attempt });
          return;
        } catch (retryErr) {
          err = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          // A refusal on the retry is as permanent as one on the first attempt.
          if (isPermanentFailure(err) && options.shouldRetry === undefined) {
            this.logger.info("reconnect refused", {
              attempt,
              reason: err.message,
              name: err.name,
              id: (err as { id?: string }).id,
            });
            return;
          }
        }
      }
      this.logger.warn("reconnect attempts exhausted", { attempts: policy.maxAttempts });
    } finally {
      this.#reconnecting = false;
    }
  }

  /**
   * A connection attempt has failed for good. Record why, release anyone
   * waiting on `waitConnected`, and tear the connection down.
   *
   * Without this, a handshake the server rejects (a wrong password, say, which
   * the server answers with an error instead of closing the socket) surfaces
   * only as the caller's own timeout, and the client stays in `Connecting`
   * forever without ever emitting `disconnected`.
   */
  #failConnection(error: Error): void {
    this.#connectionError = error;
    const waiters = this.#connectedResolvers.splice(0);
    for (const waiter of waiters) waiter.reject(error);

    if (this.#status === ClientStatus.Disconnected) return;
    this.#status = ClientStatus.Disconnected;
    this.handler.close();
    const handlers = this.#disconnectedHandlers.slice();
    for (const h of handlers) setImmediate(() => h(error));
  }

  #buildCmdHandler(): (cmd: string) => Promise<void> {
    const base = async (cmd: string): Promise<void> => {
      this.handler.sendPacket(PacketType.Command, Buffer.from(cmd), 0);
    };
    return buildCommandChain(this.#cmdMiddlewares, base);
  }

  #buildEvtHandler(): (evt: EventMap[keyof EventMap]) => void {
    const base = (evt: EventMap[keyof EventMap]): void => {
      // Determine which event type this is by checking the shape
      if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "invokerName" in evt &&
        "message" in evt &&
        "targetMode" in evt
      ) {
        this.#dispatchEventDirect("textMessage", evt as EventMap["textMessage"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "invokerName" in evt &&
        "message" in evt &&
        !("targetMode" in evt)
      ) {
        this.#dispatchEventDirect("poked", evt as EventMap["poked"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "id" in evt &&
        "uid" in evt
      ) {
        this.#dispatchEventDirect("clientEnter", evt as EventMap["clientEnter"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "id" in evt &&
        "reasonID" in evt &&
        "targetChannelID" in evt
      ) {
        this.#dispatchEventDirect("clientMoved", evt as EventMap["clientMoved"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "id" in evt &&
        "reasonID" in evt
      ) {
        this.#dispatchEventDirect("clientLeave", evt as EventMap["clientLeave"]);
      }
    };
    return buildEventChain(this.#eventMiddlewares, base);
  }
}
