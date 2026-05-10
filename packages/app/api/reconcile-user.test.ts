import { describe, it, expect, vi, beforeEach } from "vitest";

// §15.x test for /api/reconcile-user. The endpoint has a heavy
// logs-scanning path under the hood, but the request-validation +
// graceful-degradation layer is what catches malformed input
// before any RPC work happens. Coverage focuses on:
//   - method guard (POST-only)
//   - rate limiting
//   - input validation (address, chainId, supported chain set)
//   - no-DB graceful degradation (returns 200 status="no-db" so
//     mount-time call doesn't surface a 500 banner)

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());
const getSupabaseAdminMock = vi.hoisted(() => vi.fn());

vi.mock("./_lib/rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

vi.mock("./_lib/supabase-admin.js", () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

vi.mock("./_lib/addresses.js", () => ({
  ETH_SEPOLIA_ID: 11155111,
  BASE_SEPOLIA_ID: 84532,
  CONTRACTS_BY_CHAIN: {
    11155111: {
      PaymentHub: "0x" + "11".repeat(20),
      GiftMoney: "0x" + "22".repeat(20),
      FHERC20Vault_USDC: "0x" + "33".repeat(20),
    },
    84532: {
      PaymentHub: "0x" + "44".repeat(20),
      GiftMoney: "0x" + "55".repeat(20),
      FHERC20Vault_USDC: "0x" + "66".repeat(20),
    },
  },
  RPC_URLS: {
    11155111: "https://sepolia",
    84532: "https://base-sepolia",
  },
}));

import handler from "./reconcile-user.js";

// All-lowercase 20-byte address bypasses EIP-55 checksum check inside ethers.isAddress.
const VALID_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ETH_SEPOLIA = 11155111;

function makeReq(opts: Partial<{ method: string; body: unknown; headers: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    headers: opts.headers ?? { "x-forwarded-for": "127.0.0.1" },
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
  getSupabaseAdminMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 9, resetSeconds: 60 });
  // Default: no admin client → no-db path so we never enter the heavy
  // logs-scanning block in the validation tests below.
  getSupabaseAdminMock.mockReturnValue(null);
});

describe("/api/reconcile-user — method guard (§15.x)", () => {
  it("rejects non-POST with HTTP 405", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res.captured.status).toBe(405);
    expect(res.captured.body?.error).toBe("Method not allowed");
  });

  it("rejects PUT / DELETE / OPTIONS with HTTP 405", async () => {
    for (const method of ["PUT", "DELETE", "OPTIONS"]) {
      const res = makeRes();
      await handler(makeReq({ method }), res);
      expect(res.captured.status).toBe(405);
    }
  });
});

describe("/api/reconcile-user — rate limiting (§15.x)", () => {
  it("returns 429 when rate limit is exhausted", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 42 });
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(429);
    expect((res.captured.body?.error as string)).toContain("42s");
  });

  it("writes rate-limit headers on every request (incl. accepted)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: ETH_SEPOLIA } }), res);
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
  });

  it("derives client IP from x-forwarded-for (first hop)", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { address: VALID_ADDR, chainId: ETH_SEPOLIA },
        headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("203.0.113.5");
    expect(arg.key).toBe("reconcile");
    expect(arg.max).toBe(10);
    expect(arg.windowMs).toBe(60_000);
  });
});

describe("/api/reconcile-user — body parsing (§15.x)", () => {
  it("parses a stringified JSON body", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: JSON.stringify({ address: VALID_ADDR, chainId: ETH_SEPOLIA }) }),
      res,
    );
    // Reached validation past parsing; with no admin, returns no-db.
    expect(res.captured.body?.status).toBe("no-db");
  });

  it("returns 400 on invalid JSON string body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "{not json" }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invalid JSON body");
  });
});

describe("/api/reconcile-user — address validation (§15.x)", () => {
  it("returns 400 when address is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invalid address");
  });

  it("returns 400 when address is not a string", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: 12345, chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when address fails ethers.isAddress check", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: "not-an-address", chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(400);
  });
});

describe("/api/reconcile-user — chainId validation (§15.x)", () => {
  it("returns 400 when chainId is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR } }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invalid chainId");
  });

  it("returns 400 when chainId is negative", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: -1 } }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when chainId is zero (must be > 0)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 0 } }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 with helpful list when chainId is not supported", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 1 } }), res);
    expect(res.captured.status).toBe(400);
    const errMsg = res.captured.body?.error as string;
    expect(errMsg).toContain("unsupported chainId");
    expect(errMsg).toContain("11155111");
    expect(errMsg).toContain("84532");
  });
});

describe("/api/reconcile-user — no-DB graceful degradation (§15.x)", () => {
  it("returns HTTP 200 status='no-db' when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("no-db");
    expect(res.captured.body?.indexed).toBe(0);
    expect(res.captured.body?.lastBlock).toBeNull();
    expect(res.captured.body?.events).toEqual([]);
  });

  it("supports BOTH ETH Sepolia AND Base Sepolia (both reach no-db gracefully)", async () => {
    const r1 = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 11155111 } }), r1);
    const r2 = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 84532 } }), r2);
    expect(r1.captured.body?.status).toBe("no-db");
    expect(r2.captured.body?.status).toBe("no-db");
  });
});
