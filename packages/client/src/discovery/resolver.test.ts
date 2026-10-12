import { afterEach, describe, expect, it, vi } from "vitest";
import { Resolver } from "./resolver.js";

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
