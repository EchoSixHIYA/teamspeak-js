import { resolveSrv } from "node:dns/promises";
import { createConnection } from "node:net";
import type { ResolvedAddr } from "../types.js";
import { isIpAddress, joinHostPort, splitHostPort } from "../address.js";
import { abortable } from "../abort.js";

const TS_DNS_DEFAULT_PORT = 41144;
const NICKNAME_LOOKUP_URL = "https://named.myteamspeak.com/lookup";
const CACHE_TTL_MS = 10 * 60 * 1000;
/** How long resolution may take in all; past it, the address is used as given. */
const RESOLVE_BUDGET_MS = 8_000;
/** How long one TSDNS server may take to answer. */
const TSDNS_TIMEOUT_MS = 3_000;

/** How the default resolver resolves. */
export interface ResolverOptions {
  /** Look dot-less names up at named.myteamspeak.com; off by default. */
  readonly resolveNicknames?: boolean | undefined;
}

export class Resolver {
  readonly #cache = new Map<string, ResolvedAddr[]>();
  readonly #resolveNicknames: boolean;

  constructor(options: ResolverOptions = {}) {
    this.#resolveNicknames = options.resolveNicknames ?? false;
  }

  /**
   * Resolve as the TeamSpeak application does: a server nickname (only with
   * `resolveNicknames`), then SRV, then TSDNS, then the address as given. The
   * whole resolution is bounded: past the budget, or when a step fails, the
   * address as given is the answer.
   */
  async resolve(
    inputAddr: string,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<ResolvedAddr[]> {
    if (!inputAddr) throw new Error("empty address");
    const budget = AbortSignal.timeout(RESOLVE_BUDGET_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
    try {
      return await this.#resolve(inputAddr, signal, true);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!budget.aborted) throw error;
      const { host, port } = splitHostPort(inputAddr);
      return [{ addr: joinHostPort(host, port), source: "Direct" }];
    }
  }

  async #resolve(
    inputAddr: string,
    signal: AbortSignal,
    nicknames: boolean,
  ): Promise<ResolvedAddr[]> {
    const cached = this.#getValidCache(inputAddr);
    if (cached) return cached;

    const { host, port } = splitHostPort(inputAddr);

    if (isIpAddress(host)) {
      return [{ addr: joinHostPort(host, port), source: "Direct" }];
    }

    // A dot-less name may be a server nickname, which only the TeamSpeak
    // service can answer: asking it sends the name to a third party, so it is
    // opt-in. Otherwise the name is resolved like any host.
    if (nicknames && this.#resolveNicknames && !host.includes(".") && host !== "localhost") {
      const nickAddr = await resolveNickname(host, signal);
      signal.throwIfAborted();
      if (nickAddr) return this.#resolve(nickAddr, signal, false);
    }

    // SRV _ts3._udp.<host>
    const srvResults = await this.#resolveSRV(host, signal);
    if (srvResults) return this.#setCache(inputAddr, srvResults);

    const domainList = getDomainList(host);

    // TSDNS via SRV _tsdns._tcp.<domain>
    const tsdnsSrv = await this.#resolveTSDNSSRV(domainList, host, signal);
    if (tsdnsSrv) {
      return this.#setCache(inputAddr, [{ addr: tsdnsSrv, source: "TSDNS-SRV" }]);
    }

    // TSDNS direct :41144
    const tsdnsDirect = await this.#resolveTSDNSDirect(domainList, host, signal);
    if (tsdnsDirect) {
      return this.#setCache(inputAddr, [{ addr: tsdnsDirect, source: "TSDNS-Direct" }]);
    }

    signal.throwIfAborted();
    // Plain DNS fallback
    const fallback: ResolvedAddr[] = [{ addr: joinHostPort(host, port), source: "Direct" }];
    return this.#setCache(inputAddr, fallback);
  }

  #getValidCache(inputAddr: string): ResolvedAddr[] | null {
    const cached = this.#cache.get(inputAddr);
    if (!cached || cached.length === 0) return null;
    const first = cached[0]!;
    if (first.expiry !== undefined && Date.now() > first.expiry.getTime()) return null;
    return cached;
  }

  #setCache(key: string, results: ResolvedAddr[]): ResolvedAddr[] {
    const expiry = new Date(Date.now() + CACHE_TTL_MS);
    const withExpiry = results.map((r) => ({ ...r, expiry }));
    this.#cache.set(key, withExpiry);
    return withExpiry;
  }

  async #resolveSRV(host: string, signal?: AbortSignal): Promise<ResolvedAddr[] | null> {
    try {
      const srvs = await abortable(resolveSrv(`_ts3._udp.${host}`), signal);
      if (!srvs || srvs.length === 0) return null;
      return srvs.map((srv) => ({
        addr: joinHostPort(srv.name.replace(/\.$/, ""), String(srv.port)),
        source: "SRV",
      }));
    } catch {
      return null;
    }
  }

  async #resolveTSDNSSRV(
    domains: string[],
    queryHost: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    for (const domain of domains) {
      try {
        const srvs = await abortable(resolveSrv(`_tsdns._tcp.${domain}`), signal);
        if (!srvs || srvs.length === 0) continue;
        for (const srv of srvs) {
          const tsdnsAddr = joinHostPort(srv.name.replace(/\.$/, ""), String(srv.port));
          const result = await queryTSDNS(tsdnsAddr, queryHost, signal);
          if (result) return result;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async #resolveTSDNSDirect(
    domains: string[],
    queryHost: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    // Asked at once rather than in turn, so the probes cost one timeout in
    // all; the most specific domain's answer wins.
    const answers = await Promise.all(
      domains.map((domain) =>
        queryTSDNS(joinHostPort(domain, String(TS_DNS_DEFAULT_PORT)), queryHost, signal),
      ),
    );
    return answers.find((answer) => answer !== null) ?? null;
  }
}

// ---- Helpers ----------------------------------------------------------------

async function resolveNickname(nickname: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const url = new URL(NICKNAME_LOOKUP_URL);
    url.searchParams.set("name", nickname);
    const init: RequestInit = signal ? { signal } : {};
    const resp = await fetch(url.toString(), init);
    if (!resp.ok) return null;
    const text = await resp.text();
    const line = text.split("\n")[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

function queryTSDNS(
  tsdnsAddr: string,
  queryHost: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const [host, portStr] = splitHostPortParts(tsdnsAddr);
  const port = parseInt(portStr, 10);

  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const finish = (answer: string | null): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(answer);
    };
    const onAbort = (): void => finish(null);
    const timeout = setTimeout(() => finish(null), TSDNS_TIMEOUT_MS);

    const socket = createConnection({ host, port, timeout: 2_000 }, () => {
      socket.write(`${queryHost}\n`);
    });

    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        finish(!line || line === "404" || line === "errors" ? null : line);
      }
    });

    socket.on("error", () => finish(null));
    socket.on("timeout", () => finish(null));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function splitHostPortParts(addr: string): [string, string] {
  const { host, port } = splitHostPort(addr);
  return [host, port];
}

function getDomainList(host: string): string[] {
  const parts = host.split(".");
  const list: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    list.push(parts.slice(i).join("."));
  }
  return list.slice(0, 3);
}
