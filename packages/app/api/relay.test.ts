import { describe, it, expect, vi, beforeEach } from "vitest";

// §15.x test for /api/relay's request-validation layer. The selector
// allowlist (0xb61d27f6 = execute, 0x47e1da2a = executeBatch) is the
// security boundary that decides what the relayer is willing to
// sponsor. A regression that widened this allowlist would silently
// turn the relayer into a free-tx oracle for any payload signed by
// a passkey. Test the validation paths exhaustively before any
// signer / provider work happens.

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());
const getSignerMock = vi.hoisted(() => vi.fn());

vi.mock("./_lib/rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

vi.mock("./_lib/signer.js", () => ({
  getSigner: getSignerMock,
}));

import handler from "./relay.js";

const VALID_SENDER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXECUTE_SEL = "0xb61d27f6";
const EXECUTE_BATCH_SEL = "0x47e1da2a";
// 64-char hex (32 bytes) for accountGasLimits + gasFees.
const ZERO_32 = "0x" + "00".repeat(32);

const VALID_USEROP = {
  sender: VALID_SENDER,
  nonce: "0",
  initCode: "0x",
  callData: EXECUTE_SEL + "00".repeat(64),
  accountGasLimits: ZERO_32,
  preVerificationGas: "0",
  gasFees: ZERO_32,
  paymasterAndData: "0x",
  signature: "0x" + "ab".repeat(65),
};

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
  getSignerMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 9, resetSeconds: 60 });
  // Force getSigner to throw so we stop right after validation passes —
  // tests focus on the validation layer, not the on-chain submission.
  getSignerMock.mockImplementation(() => {
    throw new Error("RELAYER_PRIVATE_KEY not configured");
  });
});

describe("/api/relay — method guard (§15.x)", () => {
  it("rejects non-POST with HTTP 405", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.captured.status).toBe(405);
    expect(res.captured.body?.error).toBe("method not allowed");
  });
});

describe("/api/relay — rate limit (§15.x)", () => {
  it("returns 429 when rate limit exhausted", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 30 });
    const res = makeRes();
    await handler(makeReq({ body: { chainId: 11155111, userOp: VALID_USEROP } }), res);
    expect(res.captured.status).toBe(429);
    expect((res.captured.body?.error as string)).toContain("30s");
  });

  it("writes rate-limit headers + uses correct key/max/window", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { chainId: 11155111, userOp: VALID_USEROP } }), res);
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.key).toBe("relay");
    expect(arg.max).toBe(10);
    expect(arg.windowMs).toBe(60_000);
  });
});

describe("/api/relay — body parsing (§15.x)", () => {
  it("returns 400 on invalid JSON string body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "{not json" }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invalid JSON body");
  });

  it("parses a stringified JSON body and reaches downstream validation", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: JSON.stringify({ chainId: 999, userOp: VALID_USEROP }) }),
      res,
    );
    // chainId=999 is unsupported -> 400 with supported list.
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("unsupported chainId");
  });
});

describe("/api/relay — chainId + userOp envelope (§15.x)", () => {
  it("returns 400 when chainId is not a number", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { chainId: "11155111", userOp: VALID_USEROP } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("unsupported chainId");
  });

  it("returns 400 for unsupported chainId with helpful supported list", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { chainId: 1, userOp: VALID_USEROP } }), res);
    const err = res.captured.body?.error as string;
    expect(err).toContain("11155111");
    expect(err).toContain("84532");
  });

  it("returns 400 when userOp is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { chainId: 11155111 } }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("userOp missing from body");
  });

  it("accepts both supported chainIds (11155111 + 84532) past chainId validation", async () => {
    for (const chainId of [11155111, 84532]) {
      const res = makeRes();
      await handler(makeReq({ body: { chainId, userOp: VALID_USEROP } }), res);
      // Past chainId check; getSigner throw lands as 500.
      expect(res.captured.status).toBe(500);
    }
  });
});

describe("/api/relay — validateUserOp (§15.x security boundary)", () => {
  function call(userOpPatch: Partial<typeof VALID_USEROP>) {
    const res = makeRes();
    const userOp = { ...VALID_USEROP, ...userOpPatch };
    return handler(makeReq({ body: { chainId: 11155111, userOp } }), res).then(() => res);
  }

  it("rejects invalid sender address (non-checksum/non-hex)", async () => {
    const res = await call({ sender: "not-an-address" });
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invalid sender address");
  });

  it("rejects invalid nonce that can't be parsed as BigInt", async () => {
    const res = await call({ nonce: "not-a-number" });
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invalid nonce");
  });

  it("rejects non-hex callData", async () => {
    const res = await call({ callData: "plain text" });
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("callData must be hex");
  });

  it("rejects callData that is too short to even contain a selector", async () => {
    const res = await call({ callData: "0x12" });
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("callData too short");
  });

  it("rejects missing / malformed signature", async () => {
    const res = await call({ signature: "0x" });
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("signature missing or malformed");
  });

  it("rejects accountGasLimits that isn't exactly 32 bytes (66 hex chars)", async () => {
    const res = await call({ accountGasLimits: "0x" + "00".repeat(16) });
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("accountGasLimits");
  });

  it("rejects gasFees that isn't exactly 32 bytes", async () => {
    const res = await call({ gasFees: "0x" + "00".repeat(16) });
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("gasFees");
  });

  it("rejects an unknown selector (security boundary)", async () => {
    // 0xdeadbeef is NOT execute / executeBatch.
    const res = await call({ callData: "0xdeadbeef" + "00".repeat(60) });
    expect(res.captured.status).toBe(400);
    const err = res.captured.body?.error as string;
    expect(err).toContain("only sponsors execute / executeBatch");
    expect(err).toContain("0xdeadbeef");
  });

  it("ACCEPTS execute selector (0xb61d27f6) past validation", async () => {
    const res = await call({ callData: EXECUTE_SEL + "00".repeat(60) });
    // getSigner throws -> 500. The point is we didn't 400 in validation.
    expect(res.captured.status).toBe(500);
  });

  it("ACCEPTS executeBatch selector (0x47e1da2a) past validation", async () => {
    const res = await call({ callData: EXECUTE_BATCH_SEL + "00".repeat(60) });
    expect(res.captured.status).toBe(500);
  });

  it("selector comparison is case-insensitive (uppercase selector body doesn't bypass)", async () => {
    // Source explicitly lowercases the selector before compare. Keep
    // the "0x" prefix lowercase because ethers.isHexString rejects "0X".
    const upperBody = EXECUTE_SEL.slice(2).toUpperCase();
    const res = await call({ callData: "0x" + upperBody + "00".repeat(60) });
    expect(res.captured.status).toBe(500); // past validation
  });
});

// §15.x extension: ipFromHeaders extraction + body envelope edges +
// rate-limit-key construction + chainId-missing path. The IP is the
// rate-limit key — a regression in extraction would either let every
// caller share one bucket (DOS amplification) OR fail to find an IP
// and route every request through the "unknown" bucket (same effect).

describe("/api/relay — ipFromHeaders extraction (rate-limit key)", () => {
  it("uses single-value x-forwarded-for verbatim as the rate-limit key", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { chainId: 11155111, userOp: VALID_USEROP },
        headers: { "x-forwarded-for": "192.0.2.42" },
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("192.0.2.42");
  });

  it("picks the FIRST IP from a comma-separated x-forwarded-for chain (CDN client IP, not edge)", async () => {
    // CDNs chain forwarded-for as "client, edge1, edge2". The client
    // IP (first) is the rate-limit subject; using a downstream proxy
    // IP would lump every CDN customer into one bucket.
    const res = makeRes();
    await handler(
      makeReq({
        body: { chainId: 11155111, userOp: VALID_USEROP },
        headers: { "x-forwarded-for": "203.0.113.5, 198.51.100.10, 192.0.2.1" },
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("203.0.113.5");
  });

  it("trims surrounding whitespace from the picked IP", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { chainId: 11155111, userOp: VALID_USEROP },
        headers: { "x-forwarded-for": "  192.0.2.42  , 10.0.0.1" },
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("192.0.2.42");
  });

  it("handles array-valued x-forwarded-for (Node IncomingMessage form)", async () => {
    // When the header appears multiple times, Node concatenates them
    // into a string[]. The source picks the first array entry and
    // splits ITS comma-chain.
    const res = makeRes();
    await handler(
      makeReq({
        body: { chainId: 11155111, userOp: VALID_USEROP },
        headers: { "x-forwarded-for": ["203.0.113.7, 198.51.100.20"] },
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("203.0.113.7");
  });

  it("falls back to 'unknown' when x-forwarded-for is absent (still rate-limit, just one shared bucket)", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { chainId: 11155111, userOp: VALID_USEROP },
        headers: {}, // no x-forwarded-for
      }),
      res,
    );
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.ip).toBe("unknown");
  });
});

describe("/api/relay — body envelope edges", () => {
  it("returns 400 when body is missing entirely (no userOp envelope)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: undefined }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when body is null", async () => {
    const res = makeRes();
    await handler(makeReq({ body: null }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when chainId is missing from body (must be a supported number)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { userOp: VALID_USEROP } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("unsupported chainId");
  });

  it("accepts extra fields on the body envelope (extra keys ignored, no schema-extra rejection)", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { chainId: 11155111, userOp: VALID_USEROP, extra: "ignored" },
      }),
      res,
    );
    // Past validation -> getSigner throws -> 500. Proves the extra
    // field didn't trip an over-eager schema rejection.
    expect(res.captured.status).toBe(500);
  });
});

describe("/api/relay — rate-limit headers on rejection paths", () => {
  it("writes rate-limit headers BEFORE returning 400 on body-parsing failure", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "{bad json" }), res);
    // Rate limit was checked + headers were written even though
    // body-parsing failed downstream.
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
    expect(res.captured.status).toBe(400);
  });

  it("writes rate-limit headers BEFORE returning 400 on unsupported chainId", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { chainId: 1, userOp: VALID_USEROP } }), res);
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
    expect(res.captured.status).toBe(400);
  });

  it("writes rate-limit headers ALSO on the 429 rejection path (so clients see Retry-After + X-RateLimit-*)", async () => {
    // The source writes headers BEFORE the ok-check branch, so even
    // when the rate limit rejects, the client receives the canonical
    // RateLimit-* headers + Retry-After (computed from resetSeconds).
    // A regression that moved the header write inside the ok-true
    // branch would leave 429-throttled clients without the headers
    // they rely on for backoff.
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 30 });
    const res = makeRes();
    await handler(
      makeReq({ body: { chainId: 11155111, userOp: VALID_USEROP } }),
      res,
    );
    expect(res.captured.status).toBe(429);
    expect(writeRateLimitHeadersMock).toHaveBeenCalled();
  });
});

describe("/api/relay — validateUserOp signature length edge", () => {
  function call(userOpPatch: Partial<typeof VALID_USEROP>) {
    const res = makeRes();
    const userOp = { ...VALID_USEROP, ...userOpPatch };
    return handler(makeReq({ body: { chainId: 11155111, userOp } }), res).then(() => res);
  }

  it("rejects signature shorter than 4 chars (0x + at least 2 hex digits required)", async () => {
    // The source check is `signature.length < 4` AFTER isHexString.
    // "0x" alone is length=2 -> rejected. "0xab" is length=4 -> NOT
    // rejected by this check (passes through, fails further downstream).
    const res = await call({ signature: "0x" });
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("signature missing or malformed");
  });

  it("accepts signature of exactly 4 chars (the boundary — 0x + 2 hex digits)", async () => {
    const res = await call({ signature: "0xab" });
    // Past the validateUserOp gate; getSigner throws -> 500.
    expect(res.captured.status).toBe(500);
  });
});
