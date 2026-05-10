import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { faucetUsdc } from "./faucet-client";

// §15.x lib test for the /api/faucet/usdc client wrapper. The
// response-shape mapping is the load-bearing contract: 429 must
// surface as `rate_limited` with the scope so the UI can show the
// right help text; non-2xx must produce a clean error string;
// network failures must not crash the caller.

const ARGS = { address: "0xabc", chainId: 11155111 };

function mockFetch(response: { status: number; body?: unknown } | "throw") {
  return vi.fn(async () => {
    if (response === "throw") throw new Error("network down");
    const status = response.status;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body ?? {},
    } as unknown as Response;
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch({ status: 200, body: {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("faucetUsdc", () => {
  it("returns ok=true with hash + amount on success", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: 200,
        body: { hash: "0xdead", amount: "100000000" },
      }),
    );
    const out = await faucetUsdc(ARGS);
    expect(out).toEqual({ ok: true, hash: "0xdead", amount: "100000000" });
  });

  it("maps 429 to ok=false + rate_limited error + scope", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: 429, body: { scope: "ip" } }),
    );
    const out = await faucetUsdc(ARGS);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("rate_limited");
    expect(out.rateLimitScope).toBe("ip");
  });

  it("preserves the address scope when 429 carries it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: 429, body: { scope: "address" } }),
    );
    const out = await faucetUsdc(ARGS);
    expect(out.rateLimitScope).toBe("address");
  });

  it("returns the server's error string on non-2xx with body.error", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: 400, body: { error: "bad chain" } }),
    );
    const out = await faucetUsdc(ARGS);
    expect(out).toEqual({ ok: false, error: "bad chain" });
  });

  it("falls back to HTTP <status> on non-2xx without an error field", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 500, body: {} }));
    const out = await faucetUsdc(ARGS);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("HTTP 500");
  });

  it("survives a thrown fetch (network down) and returns the message", async () => {
    vi.stubGlobal("fetch", mockFetch("throw"));
    const out = await faucetUsdc(ARGS);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("network down");
  });

  it("survives a non-JSON response body via the .catch fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("malformed json");
        },
      })) as unknown as typeof fetch,
    );
    const out = await faucetUsdc(ARGS);
    // Body parse fails, falls back to {} so we still report ok=true
    // with no hash/amount instead of throwing.
    expect(out.ok).toBe(true);
    expect(out.hash).toBeUndefined();
  });
});
