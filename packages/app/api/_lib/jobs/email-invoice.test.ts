import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for email-invoice. Pins the rollout-mode auth gate:
//   - STRICT_EMAIL_AUTH on + no sig -> 401 "missing wallet signature"
//   - STRICT_EMAIL_AUTH off + no sig -> warning logged + email sent
//   - With sig: timestamp window + signer-must-match-vendor + verifyOwnerSignature
// The signer-must-match-vendor 403 is the load-bearing security check —
// without it anyone could blast invoice emails to anyone "from" any
// vendor address.

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());
const sendEmailMock = vi.hoisted(() => vi.fn());
const emailEnabledMock = vi.hoisted(() => vi.fn());
const renderInvoiceEmailMock = vi.hoisted(() => vi.fn());
const getSupabaseAdminMock = vi.hoisted(() => vi.fn());
const checkTimestampWindowMock = vi.hoisted(() => vi.fn());
const verifyOwnerSignatureMock = vi.hoisted(() => vi.fn());
const strictEmailAuthEnabledMock = vi.hoisted(() => vi.fn());

const { FakeEmailNotConfiguredError } = vi.hoisted(() => ({
  FakeEmailNotConfiguredError: class FakeEmailNotConfiguredError extends Error {},
}));

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
  renderInvoiceEmail: renderInvoiceEmailMock,
}));

vi.mock("../supabase-admin.js", () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

vi.mock("../sig-auth.js", () => ({
  buildInvoiceEmailMessage: () => "canonical-message",
  checkTimestampWindow: checkTimestampWindowMock,
  strictEmailAuthEnabled: strictEmailAuthEnabledMock,
  verifyOwnerSignature: verifyOwnerSignatureMock,
}));

vi.mock("../../../src/lib/ipfs.js", () => ({
  ipfsUrl: (cid: string) => `https://gateway/ipfs/${cid}`,
}));

import handler from "./email-invoice.js";

const VENDOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const INVOICE_ROW = {
  invoice_id: 42,
  vendor_address: VENDOR,
  client_address: "0xc".repeat(40),
  description: "Web design",
  due_date: "2026-06-01",
  client_email: "client@example.com",
  vendor_email: "vendor@example.com",
  pdf_cid: null,
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

function adminWithInvoice(row: Record<string, unknown> | null, err: { message: string } | null = null) {
  const maybeSingleMock = vi.fn().mockResolvedValue({ data: row, error: err });
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: maybeSingleMock,
  } as Record<string, unknown>;
  return {
    from: () => chain,
  };
}

beforeEach(() => {
  checkRateLimitMock.mockReset();
  writeRateLimitHeadersMock.mockReset();
  sendEmailMock.mockReset();
  emailEnabledMock.mockReset();
  renderInvoiceEmailMock.mockReset();
  getSupabaseAdminMock.mockReset();
  checkTimestampWindowMock.mockReset();
  verifyOwnerSignatureMock.mockReset();
  strictEmailAuthEnabledMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 9, resetSeconds: 60 });
  emailEnabledMock.mockReturnValue(true);
  getSupabaseAdminMock.mockReturnValue(adminWithInvoice(INVOICE_ROW));
  renderInvoiceEmailMock.mockReturnValue({
    subject: "Invoice INV-42",
    html: "<p>$3,700</p>",
    text: "Pay $3,700",
  });
  sendEmailMock.mockResolvedValue({ id: "msg-abc" });
  checkTimestampWindowMock.mockReturnValue(null);
  verifyOwnerSignatureMock.mockResolvedValue({ ok: true });
  strictEmailAuthEnabledMock.mockReturnValue(false);

  // Silence success-path "unsigned request accepted" warning.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VALID_BODY = { invoiceId: 42, amount: "3700" };

describe("email-invoice — method + service gates (§15.x)", () => {
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

  it("uses correct rate-limit key/max/window", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.key).toBe("invoice-email");
    expect(arg.max).toBe(10);
    expect(arg.windowMs).toBe(60_000);
  });

  it("returns 503 when emailEnabled() is false", async () => {
    emailEnabledMock.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("Email is not configured");
  });

  it("returns 503 when supabase admin is missing", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
  });
});

describe("email-invoice — body validation (§15.x)", () => {
  it("returns 400 when invoiceId is missing or not a number", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { amount: "3700" } }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("invoiceId required");
  });

  it("returns 400 when amount is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { invoiceId: 42 } }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("amount required");
  });

  it("returns 400 when amount is empty string", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { invoiceId: 42, amount: "" } }), res);
    expect(res.captured.status).toBe(400);
  });
});

describe("email-invoice — invoice lookup (§15.x)", () => {
  it("returns 500 with supabase error message on select failure", async () => {
    getSupabaseAdminMock.mockReturnValue(
      adminWithInvoice(null, { message: "RLS denied" }),
    );
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(500);
    expect(res.captured.body?.error).toBe("RLS denied");
  });

  it("returns 404 when no invoice row matches", async () => {
    getSupabaseAdminMock.mockReturnValue(adminWithInvoice(null));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(404);
    expect(res.captured.body?.error).toBe("Invoice not found");
  });
});

describe("email-invoice — recipient resolution (§15.x)", () => {
  it("returns 400 when no recipient (row has no client_email and body provides none)", async () => {
    getSupabaseAdminMock.mockReturnValue(
      adminWithInvoice({ ...INVOICE_ROW, client_email: null }),
    );
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("recipient email");
  });

  it("returns 400 when recipient email fails the plausibility regex", async () => {
    getSupabaseAdminMock.mockReturnValue(
      adminWithInvoice({ ...INVOICE_ROW, client_email: "not-an-email" }),
    );
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(400);
  });

  it("body.recipientEmail overrides invoice.client_email", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, recipientEmail: "override@example.com" } }),
      res,
    );
    expect(res.captured.status).toBe(200);
    expect(sendEmailMock.mock.calls[0][0].to).toBe("override@example.com");
  });
});

describe("email-invoice — wallet-signed auth (§15.x rollout mode)", () => {
  it("STRICT mode + missing signature -> 401", async () => {
    strictEmailAuthEnabledMock.mockReturnValue(true);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("missing wallet signature");
  });

  it("SOFT mode + missing signature -> 200 + logs a warning", async () => {
    strictEmailAuthEnabledMock.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0].join(" ")).toContain("unsigned request accepted");
  });

  it("with sig: timestamp window error -> 401", async () => {
    checkTimestampWindowMock.mockReturnValue("signedAt too old");
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: VENDOR,
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("too old");
  });

  it("with sig: 403 when signer is NOT the invoice vendor (security boundary)", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: OTHER, // different from VENDOR
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(403);
    expect((res.captured.body?.error as string)).toContain("not the invoice vendor");
  });

  it("vendor match is case-insensitive (mixed-case signerAddress still passes)", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: VENDOR.toUpperCase() as `0x${string}`,
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(200);
  });

  it("with sig: 401 when verifyOwnerSignature rejects (with reason in error)", async () => {
    verifyOwnerSignatureMock.mockResolvedValue({ ok: false, reason: "bad-sig" });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          ...VALID_BODY,
          signature: ("0x" + "a".repeat(130)) as `0x${string}`,
          signerAddress: VENDOR,
          signedAt: 1,
          signerChainId: 11155111,
        },
      }),
      res,
    );
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("bad-sig");
  });
});

describe("email-invoice — happy path (§15.x)", () => {
  it("builds the email + sends with idempotency key + returns messageId", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.ok).toBe(true);
    expect(res.captured.body?.messageId).toBe("msg-abc");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0];
    expect(arg.to).toBe("client@example.com");
    expect(arg.idempotencyKey).toBe("invoice:42:client@example.com");
    expect(arg.replyTo).toBe("vendor@example.com");
  });

  it("default payUrl bakes invoice id + url-encoded amount", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, amount: "3,700.00" } }),
      res,
    );
    const tplArg = renderInvoiceEmailMock.mock.calls[0][0];
    expect(tplArg.payUrl).toContain("/pay/INV-42");
    expect(tplArg.payUrl).toContain("amount=3%2C700.00"); // comma url-encoded
  });

  it("body.payUrl overrides the default", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, payUrl: "https://blank.app/custom-pay" } }),
      res,
    );
    const tplArg = renderInvoiceEmailMock.mock.calls[0][0];
    expect(tplArg.payUrl).toBe("https://blank.app/custom-pay");
  });

  it("EmailNotConfiguredError from sendEmail -> 503 with the underlying message", async () => {
    sendEmailMock.mockRejectedValue(new FakeEmailNotConfiguredError("RESEND_API_KEY missing"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("RESEND_API_KEY");
  });

  it("Other sendEmail errors -> 502", async () => {
    sendEmailMock.mockRejectedValue(new Error("Resend 4xx: bad payload"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(502);
  });
});
