import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for /api/oracle/quote. The audit Top-28 #6 fix is the
// load-bearing security boundary: rate-limit-module failure must
// fail CLOSED in production (503), and the token allowlist gate
// must reject anything not in ALLOWED_PAY_TOKENS even when payAmountIn
// is well-formed. A regression that flipped fail-CLOSED back to
// fail-OPEN would silently turn this into a free signing oracle.

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());

vi.mock("../_lib/rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

import handler from "./quote.js";

const VALID_PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_HUB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// TestUSDC on Sepolia from ALLOWED_PAY_TOKENS.
const ALLOWED_TOKEN_SEPOLIA = "0x16369cd4b9533795dcdc0d67db3e4c621ef97d68";
const DENIED_TOKEN = "0x" + "cd".repeat(20);

// 32-byte hex private key (NOT real, NEVER use). Deterministic so we can
// recover the signing address if needed.
const ORACLE_KEY = "0x" + "11".repeat(32);

const VALID_BODY = {
  payer: VALID_PAYER,
  invoiceId: "42",
  payToken: ALLOWED_TOKEN_SEPOLIA,
  payAmountIn: "1000000",
  chainId: 11155111,
  businessHub: VALID_HUB,
};

function makeReq(opts: Partial<{ method: string; body: unknown; headers: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    headers: opts.headers ?? { "x-forwarded-for": "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function makeRes() {
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  return {
    captured,
    setHeader: vi.fn(),
    status(s: number) {
      captured.status = s;
      return this;
    },
    json(b: Record<string, unknown>) {
      captured.body = b;
      return this;
    },
  };
}

beforeEach(() => {
  checkRateLimitMock.mockReset();
  writeRateLimitHeadersMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 59, resetSeconds: 3600 });
  delete process.env.ORACLE_PRIVATE_KEY;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  // Silence the happy-path "signed quote" log line.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.ORACLE_PRIVATE_KEY;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  vi.restoreAllMocks();
});

describe("/api/oracle/quote — method guard (§15.x)", () => {
  it("rejects non-POST with HTTP 405 + Allow header", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.captured.status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});

describe("/api/oracle/quote — input validation (§15.x)", () => {
  it("returns 400 when body is null/undefined", async () => {
    const res = makeRes();
    await handler(makeReq({ body: null }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("Invalid body");
  });

  it("returns 400 when payer is not a 0x-40-char hex string", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, payer: "not-an-addr" } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("payer");
  });

  it("returns 400 when payToken is not a 0x-40-char hex string", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, payToken: "0x" } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("payToken");
  });

  it("returns 400 when businessHub is malformed", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, businessHub: "0x123" } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("businessHub");
  });

  it("returns 400 when chainId is not in the supported set", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, chainId: 1 } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("11155111");
    expect((res.captured.body?.error as string)).toContain("84532");
  });

  it("returns 400 when payAmountIn can't be parsed as BigInt", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, payAmountIn: "not a number" } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("bigint");
  });

  it("returns 400 when payAmountIn is zero", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, payAmountIn: "0" } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("positive");
  });

  it("returns 400 when payAmountIn is negative", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, payAmountIn: "-1" } }), res);
    expect(res.captured.status).toBe(400);
  });
});

describe("/api/oracle/quote — rate limit + audit Top-28 #6 (§15.x)", () => {
  it("returns 429 with scope='ip' when rate limit exceeded", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 60 });
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(429);
    expect(res.captured.body?.scope).toBe("ip");
  });

  it("uses correct key=oracle-quote / max=60 / window=1hr", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.key).toBe("oracle-quote");
    expect(arg.max).toBe(60);
    expect(arg.windowMs).toBe(3_600_000);
  });

  it("FAIL-CLOSED in production: returns 503 when rate-limit module crashes (NODE_ENV=production)", async () => {
    process.env.NODE_ENV = "production";
    checkRateLimitMock.mockRejectedValue(new Error("KV unreachable"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect(res.captured.body?.error).toBe("rate_limit_unavailable");
  });

  it("FAIL-CLOSED in production: returns 503 when VERCEL_ENV=production", async () => {
    process.env.VERCEL_ENV = "production";
    checkRateLimitMock.mockRejectedValue(new Error("KV unreachable"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
  });

  it("FAIL-OPEN in dev: rate-limit crash does NOT block when NODE_ENV is not 'production'", async () => {
    // No ORACLE_PRIVATE_KEY -> later branch returns 503 with a different
    // error. Just verify we DID NOT short-circuit at the rate-limit
    // catch with rate_limit_unavailable.
    process.env.NODE_ENV = "development";
    checkRateLimitMock.mockRejectedValue(new Error("KV unreachable"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.body?.error).not.toBe("rate_limit_unavailable");
  });
});

describe("/api/oracle/quote — allowlist gate (§15.x)", () => {
  it("returns 422 when payToken is NOT in ALLOWED_PAY_TOKENS for this chain", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, payToken: DENIED_TOKEN } }), res);
    expect(res.captured.status).toBe(422);
    expect((res.captured.body?.error as string)).toContain("allowlist");
  });

  it("returns 422 when the allowlist entry exists but for a DIFFERENT chain", async () => {
    // The Sepolia TestUSDC address is allowlisted for chainId 11155111
    // only; using it with chainId 84532 must NOT slip through.
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, chainId: 84532, payToken: ALLOWED_TOKEN_SEPOLIA } }),
      res,
    );
    expect(res.captured.status).toBe(422);
  });
});

describe("/api/oracle/quote — ORACLE_PRIVATE_KEY validation (§15.x)", () => {
  it("returns 503 when ORACLE_PRIVATE_KEY is unset", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("ORACLE_PRIVATE_KEY env var unset");
  });

  it("returns 503 when ORACLE_PRIVATE_KEY is malformed (wrong length)", async () => {
    process.env.ORACLE_PRIVATE_KEY = "0x123";
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("malformed");
  });
});

describe("/api/oracle/quote — happy path signing (§15.x)", () => {
  it("returns expectedUsdcOut + ratePpm + expiresAt + nonce + signature on a valid 1:1 stable quote", async () => {
    process.env.ORACLE_PRIVATE_KEY = ORACLE_KEY;
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(200);
    const out = res.captured.body!;
    expect(out.expectedUsdcOut).toBe("1000000"); // 1:1 with ratePpm=1e6
    expect(out.ratePpm).toBe("1000000");
    expect(typeof out.expiresAt).toBe("number");
    expect((out.expiresAt as number) > Math.floor(Date.now() / 1000)).toBe(true);
    expect((out.nonce as string)).toMatch(/^0x[0-9a-f]{64}$/);
    expect((out.signature as string)).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("expiresAt is ~5 minutes (300s) in the future", async () => {
    process.env.ORACLE_PRIVATE_KEY = ORACLE_KEY;
    const before = Math.floor(Date.now() / 1000);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    const ttl = (res.captured.body!.expiresAt as number) - before;
    expect(ttl).toBeGreaterThanOrEqual(299);
    expect(ttl).toBeLessThanOrEqual(301);
  });

  it("nonce is 32 fresh random bytes (no two calls share a nonce)", async () => {
    process.env.ORACLE_PRIVATE_KEY = ORACLE_KEY;
    const r1 = makeRes();
    const r2 = makeRes();
    await handler(makeReq({ body: VALID_BODY }), r1);
    await handler(makeReq({ body: VALID_BODY }), r2);
    expect(r1.captured.body?.nonce).not.toBe(r2.captured.body?.nonce);
  });
});
