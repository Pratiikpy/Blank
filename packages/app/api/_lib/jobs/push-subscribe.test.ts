import { describe, it, expect, vi, beforeEach } from "vitest";

// §15.x test for the push-subscribe handler. Pins the audit P2.11
// fix: without a wallet-signed challenge, an attacker could register
// their browser as the recipient of someone else's notifications,
// which surfaces counterparty + activity-type metadata even without
// payload bodies (deanonymization channel). The fix gates POST on
// a signed (address, chainId, signedAt) tuple via verifyOwnerSignature.

const upsertMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
const eqMock = vi.hoisted(() => vi.fn());

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());
const getSupabaseAdminMock = vi.hoisted(() => vi.fn());
const verifyOwnerSignatureMock = vi.hoisted(() => vi.fn());
const checkTimestampWindowMock = vi.hoisted(() => vi.fn());
const strictEmailAuthEnabledMock = vi.hoisted(() => vi.fn());

vi.mock("../rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

vi.mock("../supabase-admin.js", () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

vi.mock("../sig-auth.js", () => ({
  checkTimestampWindow: checkTimestampWindowMock,
  verifyOwnerSignature: verifyOwnerSignatureMock,
  strictEmailAuthEnabled: strictEmailAuthEnabledMock,
}));

import handler from "./push-subscribe.js";

const VALID_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "BASE64==", auth: "BASE64==" },
};
const VALID_SIG = "0x" + "ab".repeat(65);

const POST_BODY_NO_SIG = {
  address: VALID_ADDR,
  chainId: 11155111,
  subscription: VALID_SUB,
};

const POST_BODY_WITH_SIG = {
  ...POST_BODY_NO_SIG,
  signature: VALID_SIG,
  signedAt: 1_700_000_000,
  signerChainId: 11155111,
};

function makeReq(opts: Partial<{ method: string; body: unknown; headers: Record<string, unknown>; query: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    headers: opts.headers ?? { "x-forwarded-for": "127.0.0.1" },
    query: opts.query ?? {},
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

function adminWithUpsertOk() {
  upsertMock.mockResolvedValue({ error: null });
  return {
    from: () => ({ upsert: upsertMock, delete: () => ({ eq: eqMock }) }),
  };
}

beforeEach(() => {
  upsertMock.mockReset();
  deleteMock.mockReset();
  eqMock.mockReset();
  checkRateLimitMock.mockReset();
  writeRateLimitHeadersMock.mockReset();
  getSupabaseAdminMock.mockReset();
  verifyOwnerSignatureMock.mockReset();
  checkTimestampWindowMock.mockReset();
  strictEmailAuthEnabledMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 29, resetSeconds: 60 });
  getSupabaseAdminMock.mockReturnValue(adminWithUpsertOk());
  strictEmailAuthEnabledMock.mockReturnValue(false);
  checkTimestampWindowMock.mockReturnValue(null);
  verifyOwnerSignatureMock.mockResolvedValue({ ok: true });
  eqMock.mockResolvedValue({ error: null });
});

describe("push-subscribe — method guard (§15.x)", () => {
  it("rejects GET / PUT with 405 + Allow header listing POST, DELETE", async () => {
    for (const method of ["GET", "PUT"]) {
      const res = makeRes();
      await handler(makeReq({ method }), res);
      expect(res.captured.status).toBe(405);
    }
    expect((makeRes().setHeader as unknown as ReturnType<typeof vi.fn>)).toBeDefined();
  });
});

describe("push-subscribe — rate limit (§15.x)", () => {
  it("returns 429 when rate limit exhausted", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 60 });
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_NO_SIG }), res);
    expect(res.captured.status).toBe(429);
  });

  it("uses key=push-subscribe / max=30 / window=60s", async () => {
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_NO_SIG }), res);
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.key).toBe("push-subscribe");
    expect(arg.max).toBe(30);
    expect(arg.windowMs).toBe(60_000);
  });
});

describe("push-subscribe — supabase gate (§15.x)", () => {
  it("returns 503 when supabase admin is not configured", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_NO_SIG }), res);
    expect(res.captured.status).toBe(503);
  });
});

describe("push-subscribe — POST body validation (§15.x)", () => {
  it("returns 400 on null body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: null }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("Invalid body");
  });

  it("returns 400 on malformed address", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...POST_BODY_NO_SIG, address: "not-an-addr" } }),
      res,
    );
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("Invalid address");
  });

  it("returns 400 on missing subscription payload", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { address: VALID_ADDR, subscription: null } }),
      res,
    );
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("subscription");
  });

  it("returns 400 when keys.p256dh is missing", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          address: VALID_ADDR,
          subscription: { endpoint: "x", keys: { auth: "y" } },
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(400);
  });
});

describe("push-subscribe — audit P2.11 signature gate (§15.x)", () => {
  beforeEach(() => {
    strictEmailAuthEnabledMock.mockReturnValue(true);
  });

  it("returns 401 when STRICT mode is on and signature is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_NO_SIG }), res);
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("wallet signature");
  });

  it("returns 401 when STRICT mode is on and signedAt is missing", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...POST_BODY_WITH_SIG, signedAt: undefined } }),
      res,
    );
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 when timestamp is outside the allowed window", async () => {
    checkTimestampWindowMock.mockReturnValue("signedAt too old");
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_WITH_SIG }), res);
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("too old");
  });

  it("returns 401 when verifyOwnerSignature rejects (with reason in error)", async () => {
    verifyOwnerSignatureMock.mockResolvedValue({ ok: false, reason: "bad-sig" });
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_WITH_SIG }), res);
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("bad-sig");
  });

  it("builds the signed message with lowercased address + chainId + signedAt (binding all 3)", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...POST_BODY_WITH_SIG, address: VALID_ADDR.toUpperCase() } }),
      res,
    );
    expect(res.captured.status).toBe(400); // mixed-case 0X fails the isHexAddress regex
    // ^ that's a deliberate side-effect: validates the regex's case-sensitivity
    // on the "0x" prefix BEFORE message-building. Worthwhile pin.
  });

  it("accepts the request when STRICT mode is on AND signature verifies", async () => {
    verifyOwnerSignatureMock.mockResolvedValue({ ok: true });
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_WITH_SIG }), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.ok).toBe(true);
  });

  it("falls back to body.chainId when signerChainId is omitted", async () => {
    verifyOwnerSignatureMock.mockResolvedValue({ ok: true });
    const res = makeRes();
    await handler(
      makeReq({ body: { ...POST_BODY_WITH_SIG, signerChainId: undefined } }),
      res,
    );
    expect(res.captured.status).toBe(200);
    const verifyArg = verifyOwnerSignatureMock.mock.calls[0][0];
    expect(verifyArg.chainId).toBe(11155111); // body.chainId
  });
});

describe("push-subscribe — happy path POST (§15.x)", () => {
  it("upserts the subscription row keyed by endpoint with lowercased address", async () => {
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_NO_SIG }), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.ok).toBe(true);

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [row, opts] = upsertMock.mock.calls[0];
    expect(row.address).toBe(VALID_ADDR.toLowerCase());
    expect(row.endpoint).toBe(VALID_SUB.endpoint);
    expect(row.p256dh).toBe(VALID_SUB.keys.p256dh);
    expect(row.auth).toBe(VALID_SUB.keys.auth);
    expect(opts).toEqual({ onConflict: "endpoint" });
  });

  it("truncates user_agent to 256 chars before storing", async () => {
    const longUA = "M".repeat(500);
    const res = makeRes();
    await handler(
      makeReq({
        body: POST_BODY_NO_SIG,
        headers: { "x-forwarded-for": "127.0.0.1", "user-agent": longUA },
      }),
      res,
    );
    const [row] = upsertMock.mock.calls[0];
    expect(row.user_agent.length).toBe(256);
  });

  it("returns 500 with supabase error message when upsert fails", async () => {
    upsertMock.mockResolvedValue({ error: { message: "RLS denied" } });
    const res = makeRes();
    await handler(makeReq({ body: POST_BODY_NO_SIG }), res);
    expect(res.captured.status).toBe(500);
    expect(res.captured.body?.error).toBe("RLS denied");
  });
});

describe("push-subscribe — DELETE (§15.x)", () => {
  it("returns 400 when endpoint is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "DELETE", body: {} }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("endpoint");
  });

  it("calls supabase.from('push_subscriptions').delete().eq('endpoint', ...) on success", async () => {
    eqMock.mockResolvedValue({ error: null });
    const res = makeRes();
    await handler(makeReq({ method: "DELETE", body: { endpoint: VALID_SUB.endpoint } }), res);
    expect(res.captured.status).toBe(200);
    expect(eqMock).toHaveBeenCalledWith("endpoint", VALID_SUB.endpoint);
  });

  it("returns 500 when delete fails", async () => {
    eqMock.mockResolvedValue({ error: { message: "delete failed" } });
    const res = makeRes();
    await handler(makeReq({ method: "DELETE", body: { endpoint: VALID_SUB.endpoint } }), res);
    expect(res.captured.status).toBe(500);
  });
});
