import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for /api/faucet/usdc. The 3-layer rate-limit (per-IP +
// per-address-hourly + per-address-daily, Plan §7.2) is the defense
// against patient-attacker abuse. The scope label in the 429 response
// is what drives the frontend's error copy ("daily cap, try tomorrow"
// vs "try again in a minute") — flipping any label silently degrades
// the user feedback.

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());
const getContractsMock = vi.hoisted(() => vi.fn());

vi.mock("../_lib/rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

vi.mock("../_lib/addresses.js", () => ({
  getContracts: getContractsMock,
  ETH_SEPOLIA_ID: 11155111,
  BASE_SEPOLIA_ID: 84532,
  ARB_SEPOLIA_ID: 421614,
}));

import handler from "./usdc.js";

const VALID_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAUCET_BODY = { address: VALID_ADDR, chainId: 11155111 };

function makeReq(opts: Partial<{ method: string; body: unknown; headers: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    headers: opts.headers ?? { "x-forwarded-for": "203.0.113.5" },
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

const OK = { ok: true, remaining: 1, resetSeconds: 60 };
const DENY = { ok: false, remaining: 0, resetSeconds: 60 };

beforeEach(() => {
  checkRateLimitMock.mockReset();
  writeRateLimitHeadersMock.mockReset();
  getContractsMock.mockReset();
  // Default: all 3 tiers OK so we reach the relayer-key check.
  checkRateLimitMock.mockResolvedValue(OK);
  delete process.env.RELAYER_PRIVATE_KEY;
});

afterEach(() => {
  delete process.env.RELAYER_PRIVATE_KEY;
});

describe("/api/faucet/usdc — method guard (§15.x)", () => {
  it("rejects non-POST with 405 + Allow header", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.captured.status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});

describe("/api/faucet/usdc — input validation (§15.x)", () => {
  it("returns 400 on null body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: null }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("Invalid body");
  });

  it("returns 400 when address is malformed", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: "not-an-addr", chainId: 11155111 } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("address");
  });

  it("returns 400 on unsupported chainId", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 1 } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("not supported");
  });

  it("accepts ETH Sepolia + Base Sepolia + Arb Sepolia past chainId check", async () => {
    // No RELAYER_PRIVATE_KEY -> 503 on all three, proving we passed chainId.
    for (const chainId of [11155111, 84532, 421614]) {
      const res = makeRes();
      await handler(makeReq({ body: { address: VALID_ADDR, chainId } }), res);
      expect(res.captured.status).toBe(503);
    }
  });
});

describe("/api/faucet/usdc — 3-layer rate limit (§15.x, Plan §7.2)", () => {
  it("returns 429 scope='ip' when per-IP layer fires first", async () => {
    checkRateLimitMock.mockResolvedValueOnce(DENY); // IP layer denies
    const res = makeRes();
    await handler(makeReq({ body: FAUCET_BODY }), res);
    expect(res.captured.status).toBe(429);
    expect(res.captured.body?.scope).toBe("ip");
  });

  it("returns 429 scope='address' when per-address-hourly layer fires", async () => {
    // IP OK, address-hour DENY.
    checkRateLimitMock
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(DENY);
    const res = makeRes();
    await handler(makeReq({ body: FAUCET_BODY }), res);
    expect(res.captured.status).toBe(429);
    expect(res.captured.body?.scope).toBe("address");
  });

  it("returns 429 scope='address-day' when per-address-daily layer fires (patient-attacker guard)", async () => {
    // IP OK, address-hour OK, address-day DENY.
    checkRateLimitMock
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(DENY);
    const res = makeRes();
    await handler(makeReq({ body: FAUCET_BODY }), res);
    expect(res.captured.status).toBe(429);
    expect(res.captured.body?.scope).toBe("address-day");
  });

  it("uses correct key/max/window for each layer", async () => {
    const res = makeRes();
    await handler(makeReq({ body: FAUCET_BODY }), res);

    expect(checkRateLimitMock).toHaveBeenCalledTimes(3);

    const [ipCall, addrCall, dayCall] = checkRateLimitMock.mock.calls.map((c) => c[0]);

    // Layer 1: per-IP, 30/hr.
    expect(ipCall.key).toBe("faucet-usdc");
    expect(ipCall.max).toBe(30);
    expect(ipCall.windowMs).toBe(3_600_000);
    expect(ipCall.ip).toBe("203.0.113.5"); // from x-forwarded-for first hop

    // Layer 2: per-address, 5/hr (uses lowercase address as the ip key).
    expect(addrCall.key).toBe("faucet-usdc-addr");
    expect(addrCall.max).toBe(5);
    expect(addrCall.windowMs).toBe(3_600_000);
    expect(addrCall.ip).toBe(VALID_ADDR.toLowerCase());

    // Layer 3: per-address-daily, 24/day.
    expect(dayCall.key).toBe("faucet-usdc-addr-day");
    expect(dayCall.max).toBe(24);
    expect(dayCall.windowMs).toBe(86_400_000);
    expect(dayCall.ip).toBe(VALID_ADDR.toLowerCase());
  });

  it("writes rate-limit headers on accepted requests too (visible quota for UI)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: FAUCET_BODY }), res);
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
  });

  it("lowercases the address before keying the per-address limiter", async () => {
    // Mixed case: keep "0x" lowercase (isHexAddress regex requires it),
    // uppercase the body. The limiter key must still be all-lowercase.
    const mixedCase = "0x" + VALID_ADDR.slice(2).toUpperCase();
    const res = makeRes();
    await handler(
      makeReq({ body: { address: mixedCase, chainId: 11155111 } }),
      res,
    );
    const addrCall = checkRateLimitMock.mock.calls[1][0];
    expect(addrCall.ip).toBe(VALID_ADDR.toLowerCase());
  });
});

describe("/api/faucet/usdc — pre-flight (§15.x)", () => {
  it("returns 503 when RELAYER_PRIVATE_KEY is unset", async () => {
    const res = makeRes();
    await handler(makeReq({ body: FAUCET_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("RELAYER_PRIVATE_KEY");
  });

  it("returns 503 when getContracts() returns null for the chain", async () => {
    process.env.RELAYER_PRIVATE_KEY = "0x" + "11".repeat(32);
    getContractsMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq({ body: FAUCET_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("no contracts configured");
  });
});
