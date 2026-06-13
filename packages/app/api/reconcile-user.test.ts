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
  ARB_SEPOLIA_ID: 421614,
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
    421614: {
      PaymentHub: "0x" + "77".repeat(20),
      GiftMoney: "0x" + "88".repeat(20),
      FHERC20Vault_USDC: "0x" + "99".repeat(20),
    },
  },
  RPC_URLS: {
    11155111: "https://sepolia",
    84532: "https://base-sepolia",
    421614: "https://arb-sepolia",
  },
}));

import handler from "./_lib/jobs/reconcile-user.js";

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
    expect(errMsg).toContain("421614");
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

  it("supports ETH Sepolia, Base Sepolia AND Arb Sepolia (all reach no-db gracefully)", async () => {
    const r1 = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 11155111 } }), r1);
    const r2 = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 84532 } }), r2);
    const r3 = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 421614 } }), r3);
    expect(r1.captured.body?.status).toBe("no-db");
    expect(r2.captured.body?.status).toBe("no-db");
    expect(r3.captured.body?.status).toBe("no-db");
  });
});

// §15.x extension: address + chainId validation edges, ipFromHeaders
// extraction, body envelope edges, rate-limit headers on rejection
// paths, no-DB response shape pin.

describe("/api/reconcile-user — address validation edges", () => {
  it("returns 400 for empty-string address", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: "", chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invalid address");
  });

  it("returns 400 for '0x'-only address (too short for isAddress)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: "0x", chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 for null address", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: null, chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(400);
  });

  it("accepts an all-lowercase 40-char hex (no EIP-55 checksum required)", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { address: "0xabcdef0123456789abcdef0123456789abcdef01", chainId: ETH_SEPOLIA } }),
      res,
    );
    // Reached no-db path -> passed validation.
    expect(res.captured.body?.status).toBe("no-db");
  });
});

describe("/api/reconcile-user — chainId validation edges", () => {
  it("returns 400 for non-number chainId (string)", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { address: VALID_ADDR, chainId: "11155111" } }),
      res,
    );
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invalid chainId");
  });

  it("returns 400 for non-number chainId (boolean)", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { address: VALID_ADDR, chainId: true } }),
      res,
    );
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 for null chainId", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { address: VALID_ADDR, chainId: null } }),
      res,
    );
    expect(res.captured.status).toBe(400);
  });

  it("supported-chainId error lists EXACTLY the configured chains (catches list drift)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: 1 } }), res);
    const err = res.captured.body?.error as string;
    expect(err).toContain("11155111");
    expect(err).toContain("84532");
    expect(err).toContain("421614");
    // Mainnet (1) MUST NOT appear in the suggestion list (we don't
    // support it and the operator-facing error shouldn't list it).
    expect(err.split(",").map((s) => s.trim())).not.toContain("1");
  });
});

describe("/api/reconcile-user — ipFromHeaders extraction", () => {
  it("uses single x-forwarded-for verbatim as the rate-limit ip", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { address: VALID_ADDR, chainId: ETH_SEPOLIA },
        headers: { "x-forwarded-for": "192.0.2.7" },
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("192.0.2.7");
  });

  it("array-form x-forwarded-for picks first array entry's first comma element", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { address: VALID_ADDR, chainId: ETH_SEPOLIA },
        headers: { "x-forwarded-for": ["203.0.113.5, 198.51.100.1"] },
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("203.0.113.5");
  });

  it("falls back to 'unknown' when x-forwarded-for header is absent", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { address: VALID_ADDR, chainId: ETH_SEPOLIA },
        headers: {},
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("unknown");
  });
});

describe("/api/reconcile-user — body envelope edges", () => {
  it("returns 400 when body is null (the address validation surfaces first)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: null }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when body is undefined (the body ?? {} fallback still trips invalid-address)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: undefined }), res);
    expect(res.captured.status).toBe(400);
  });

  it("accepts extra fields on the body envelope (forward-compat — no strict-schema reject)", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { address: VALID_ADDR, chainId: ETH_SEPOLIA, extraField: "ignored" },
      }),
      res,
    );
    expect(res.captured.body?.status).toBe("no-db");
  });
});

describe("/api/reconcile-user — rate-limit headers on rejection paths", () => {
  it("writes rate-limit headers BEFORE returning 400 on body-parsing failure", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "{bad json" }), res);
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
    expect(res.captured.status).toBe(400);
  });

  it("writes rate-limit headers BEFORE returning 400 on invalid address", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { address: "not-an-address", chainId: ETH_SEPOLIA } }),
      res,
    );
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
  });

  it("writes rate-limit headers ALSO on the 429 rejection path", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 30 });
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: ETH_SEPOLIA } }), res);
    expect(res.captured.status).toBe(429);
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
  });
});

describe("/api/reconcile-user — no-db response shape (mount-time call must not surface 500)", () => {
  it("no-db response has NO error field (clean 200 — UI doesn't render a banner)", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: ETH_SEPOLIA } }), res);
    // The UI distinguishes "success but no backfill" from "error" by
    // the presence of the error field. A regression that added an
    // error field here would silently make every mount surface a
    // failure banner even on no-db.
    expect("error" in (res.captured.body ?? {})).toBe(false);
    expect(res.captured.body?.status).toBe("no-db");
  });

  it("no-db response has all 4 documented fields (status / indexed / lastBlock / events)", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq({ body: { address: VALID_ADDR, chainId: ETH_SEPOLIA } }), res);
    const body = res.captured.body!;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("indexed");
    expect(body).toHaveProperty("lastBlock");
    expect(body).toHaveProperty("events");
  });
});
