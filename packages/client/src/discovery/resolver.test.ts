import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { MAX_DISCOVERY_RESPONSE, Resolver, queryTSDNS, resolveNickname } from "./resolver.js";

afterEach(() => vi.restoreAllMocks());

describe("Resolver", () => {
  it("does not send a dot-less name to the nickname service unless asked", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("10.0.0.1:9987"));

    const plain = await new Resolver().resolve("mybox:9987");
    expect(fetch).not.toHaveBeenCalled();
    expect(plain[0]?.addr).toBe("mybox:9987");

    const looked = await new Resolver({ resolveNicknames: true }).resolve("mybox");
    expect(fetch).toHaveBeenCalledOnce();
    expect(looked[0]?.addr).toBe("10.0.0.1:9987");
  });

  it("answers an IP address directly", async () => {
    const answer = await new Resolver().resolve("127.0.0.1:9988");
    expect(answer).toEqual([{ addr: "127.0.0.1:9988", source: "Direct" }]);
  });
});

describe("discovery reads", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  /** A TSDNS server that answers every query with `answer`, then keeps sending `flood`. */
  async function tsdns(answer: string, flood = ""): Promise<string> {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.write(answer);
      if (!flood) return;
      const timer = setInterval(() => socket.write(flood), 1);
      socket.on("close", () => clearInterval(timer));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return `127.0.0.1:${port}`;
  }

  it("takes a TSDNS server's one-line answer", async () => {
    expect(await queryTSDNS(await tsdns("10.0.0.1:9987\n"), "ts.example")).toBe("10.0.0.1:9987");
  });

  it(`gives up on a TSDNS server that sends ${MAX_DISCOVERY_RESPONSE} bytes without a line`, async () => {
    const started = Date.now();
    const addr = await tsdns("", "x".repeat(1024));
    expect(await queryTSDNS(addr, "ts.example")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it(`reads at most ${MAX_DISCOVERY_RESPONSE} bytes of the nickname service's answer`, async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024).fill(0x61));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(endless));

    const answer = await resolveNickname("mybox");
    expect(answer).toHaveLength(MAX_DISCOVERY_RESPONSE);
    expect(pulled).toBeLessThan(4 * MAX_DISCOVERY_RESPONSE);
  });
});
