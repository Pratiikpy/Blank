import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for email-request. Mirror of email-invoice but with a
// subtle role inversion: from_address = PAYER (being asked to pay),
// to_address = REQUESTER (who authored the row). The signer-must-match
// check binds to to_address — getting that wrong would let the payer
// pretend to be the requester and trigger a "your money is needed"
// email to themselves.

const { FakeEmailNotConfiguredError } = vi.hoisted(() => ({
  FakeEmailNotConfiguredError: class FakeEmailNotConfiguredError extends Error {},
}));

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());
const sendEmailMock = vi.hoisted(() => vi.fn());
const emailEnabledMock = vi.hoisted(() => vi.fn());
const renderPaymentRequestEmailMock = vi.hoisted(() => vi.fn());
const getSupabaseAdminMock = vi.hoisted(() => vi.fn());
const checkTimestampWindowMock = vi.hoisted(() => vi.fn());
const verifyOwnerSignatureMock = vi.hoisted(() => vi.fn());
const strictEmailAuthEnabledMock = vi.hoisted(() => vi.fn());

vi.mock("../rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

vi.mock("../resend.js", () => ({
  sendEmail: sendEmailMock,
  emailEnabled: emailEnabledMock,
  EmailNotConfiguredError: FakeEmailNotConfiguredError,
}));

vi.mock("../email-templates.js", () => ({
  renderPaymentRequestEmail: renderPaymentRequestEmailMock,
}));

vi.mock("../supabase-admin.js", () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

vi.mock("../sig-auth.js", () => ({
  buildRequestEmailMessage: () => "canonical-request-message",
  checkTimestampWindow: checkTimestampWindowMock,
  strictEmailAuthEnabled: strictEmailAuthEnabledMock,
  verifyOwnerSignature: verifyOwnerSignatureMock,
}));

import handler from "./email-request.js";

// to_address = REQUESTER (signer should match this).
// from_address = PAYER (should NOT be able to sign for this).
const REQUESTER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc";

const REQUEST_ROW = {
  request_id: 7,
  to_address: REQUESTER,
  from_address: PAYER,
  note: "Pizza split",
  payer_email: "payer@example.com",
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

function adminWithRequest(row: Record<string, unknown> | null, err: { message: string } | null = null) {
  const maybeSingleMock = vi.fn().mockResolvedValue({ data: row, error: err });
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: maybeSingleMock,
  };
  return { from: () => chain };
}

beforeEach(() => {
  checkRateLimitMock.mockReset();
  writeRateLimitHeadersMock.mockReset();
  sendEmailMock.mockReset();
  emailEnabledMock.mockReset();
  renderPaymentRequestEmailMock.mockReset();
  getSupabaseAdminMock.mockReset();
  checkTimestampWindowMock.mockReset();
  verifyOwnerSignatureMock.mockReset();
  strictEmailAuthEnabledMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 9, resetSeconds: 60 });
  emailEnabledMock.mockReturnValue(true);
  getSupabaseAdminMock.mockReturnValue(adminWithRequest(REQUEST_ROW));
  renderPaymentRequestEmailMock.mockReturnValue({
    subject: "Pay request",
    html: "<p>You owe $42</p>",
    text: "You owe $42",
  });
  sendEmailMock.mockResolvedValue({ id: "msg-req-1" });
  checkTimestampWindowMock.mockReturnValue(null);
  verifyOwnerSignatureMock.mockResolvedValue({ ok: true });
  strictEmailAuthEnabledMock.mockReturnValue(false);

  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VALID_BODY = { requestId: 7 };

describe("email-request — method + service gates (§15.x)", () => {
  it("rejects non-POST with 405 + Allow: POST", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.captured.status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });

  it("returns 429 when rate-limit exhausted", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 60 });
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(429);
  });

  it("uses key=request-email / max=10 / window=60s", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.key).toBe("request-email");
    expect(arg.max).toBe(10);
    expect(arg.windowMs).toBe(60_000);
  });

  it("returns 503 when emailEnabled is false", async () => {
    emailEnabledMock.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
  });

  it("returns 503 when supabase admin is missing", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
  });
});

describe("email-request — body + lookup validation (§15.x)", () => {
  it("returns 400 when requestId is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ body: {} }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("requestId required");
  });

  it("returns 500 on supabase select error", async () => {
    getSupabaseAdminMock.mockReturnValue(
      adminWithRequest(null, { message: "table missing" }),
    );
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(500);
    expect(res.captured.body?.error).toBe("table missing");
  });

  it("returns 404 when no request row matches", async () => {
    getSupabaseAdminMock.mockReturnValue(adminWithRequest(null));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(404);
    expect(res.captured.body?.error).toBe("Payment request not found");
  });

  it("returns 400 when payer_email is missing and body provides none", async () => {
    getSupabaseAdminMock.mockReturnValue(
      adminWithRequest({ ...REQUEST_ROW, payer_email: null }),
    );
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("payer email");
  });

  it("body.payerEmail overrides request.payer_email", async () => {
    const res = makeRes();
    // Pre-fix this test asserted the vulnerable behavior (override honored
    // without auth). Unauthenticated callers could drive Blank into
    // sending "payment request" emails to arbitrary addresses. Now the
    // override only honors signed requests; unsigned ones silently fall
    // back to the stored row.
    await handler(
      makeReq({ body: { ...VALID_BODY, payerEmail: "attacker@example.com" } }),
      res,
    );
    expect(res.captured.status).toBe(200);
    expect(sendEmailMock.mock.calls[0][0].to).toBe("payer@example.com");
  });
});

describe("email-request — wallet-signed auth (§15.x rollout)", () => {
  it("STRICT mode + missing signature -> 401", async () => {
    strictEmailAuthEnabledMock.mockReturnValue(true);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("missing wallet signature");
  });

  it("SOFT mode + missing signature -> 200 + warning logged", async () => {
    strictEmailAuthEnabledMock.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(200);
    expect(warnSpy.mock.calls[0].join(" ")).toContain("unsigned request accepted");
  });

  it("timestamp window error -> 401", async () => {
    checkTimestampWindowMock.mockReturnValue("signedAt too old");
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: REQUESTER,
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(401);
  });

  it("CRITICAL: 403 when signer is the PAYER (from_address) — must be the REQUESTER (to_address)", async () => {
    // The payer signing for the requester would let them spoof "your
    // money is needed" emails to themselves. This MUST 403.
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: PAYER, // = from_address. NOT allowed.
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(403);
    expect((res.captured.body?.error as string)).toContain("requester");
  });

  it("403 when signer is an unrelated address", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: OTHER,
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(403);
  });

  it("requester match is case-insensitive (mixed-case REQUESTER still passes)", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: REQUESTER.toUpperCase() as `0x${string}`,
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(200);
  });

  it("verifyOwnerSignature reject -> 401 with reason in error", async () => {
    verifyOwnerSignatureMock.mockResolvedValue({ ok: false, reason: "expired-permit" });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: REQUESTER,
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("expired-permit");
  });
});

describe("email-request — happy path (§15.x)", () => {
  it("returns messageId + correct idempotencyKey on success", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.messageId).toBe("msg-req-1");

    const arg = sendEmailMock.mock.calls[0][0];
    expect(arg.to).toBe("payer@example.com");
    expect(arg.idempotencyKey).toBe("request:7:payer@example.com");
  });

  it("default requesterName is the shortened requester address", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    const tplArg = renderPaymentRequestEmailMock.mock.calls[0][0];
    expect(tplArg.requesterName).toContain(REQUESTER.slice(0, 6));
    expect(tplArg.requesterName).toContain(REQUESTER.slice(-4));
  });

  it("body.requesterName overrides default short address", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, requesterName: "Alice (ENS)" } }),
      res,
    );
    const tplArg = renderPaymentRequestEmailMock.mock.calls[0][0];
    expect(tplArg.requesterName).toBe("Alice (ENS)");
  });

  it("default reviewUrl is `${origin}/app/requests`", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: VALID_BODY, headers: { origin: "https://www.myblank.app" } }),
      res,
    );
    const tplArg = renderPaymentRequestEmailMock.mock.calls[0][0];
    expect(tplArg.reviewUrl).toBe("https://www.myblank.app/app/requests");
  });

  it("body.reviewUrl overrides default", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { ...VALID_BODY, reviewUrl: "https://www.myblank.app/custom" },
        headers: { origin: "https://www.myblank.app" },
      }),
      res,
    );
    const tplArg = renderPaymentRequestEmailMock.mock.calls[0][0];
    expect(tplArg.reviewUrl).toBe("https://www.myblank.app/custom");
  });

  it("EmailNotConfiguredError from sendEmail -> 503", async () => {
    sendEmailMock.mockRejectedValue(new FakeEmailNotConfiguredError("Resend key missing"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
  });

  it("Other sendEmail errors -> 502", async () => {
    sendEmailMock.mockRejectedValue(new Error("Resend 4xx"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(502);
  });
});
