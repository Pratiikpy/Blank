import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildInvoiceEmailSignableMessage,
  buildRequestEmailSignableMessage,
  sendInvoiceEmail,
  sendPaymentRequestEmail,
} from "./email-client";

// §15.x lib test for the email-auth canonical message builders.
// SECURITY: these strings must EXACTLY match api/_lib/sig-auth.ts on
// the server side, byte-for-byte, or every wallet-signed email send
// gets rejected with a 401 (server can't verify the signature
// against a different message). The shape is also part of the
// signed payload that lands in audit logs, so a sneaky drift could
// fool a verifier.

describe("buildInvoiceEmailSignableMessage", () => {
  it("emits the canonical 5-line shape with the expected order", () => {
    const out = buildInvoiceEmailSignableMessage({
      invoiceId: 42,
      recipient: "Alice@Example.com",
      signedAt: 1_700_000_000,
      chainId: 11155111,
    });
    expect(out).toBe(
      [
        "Blank: send invoice email",
        "invoiceId: 42",
        "recipient: alice@example.com",
        "chainId: 11155111",
        "signedAt: 1700000000",
      ].join("\n"),
    );
  });

  it("lowercases the recipient before hashing", () => {
    const upper = buildInvoiceEmailSignableMessage({
      invoiceId: 1,
      recipient: "ALICE@example.com",
      signedAt: 1,
      chainId: 1,
    });
    const lower = buildInvoiceEmailSignableMessage({
      invoiceId: 1,
      recipient: "alice@example.com",
      signedAt: 1,
      chainId: 1,
    });
    expect(upper).toBe(lower);
  });

  it("changes when any field changes (signature would differ)", () => {
    const base = {
      invoiceId: 1,
      recipient: "a@b.com",
      signedAt: 100,
      chainId: 1,
    };
    const baseMsg = buildInvoiceEmailSignableMessage(base);

    expect(buildInvoiceEmailSignableMessage({ ...base, invoiceId: 2 })).not.toBe(baseMsg);
    expect(buildInvoiceEmailSignableMessage({ ...base, recipient: "c@d.com" })).not.toBe(baseMsg);
    expect(buildInvoiceEmailSignableMessage({ ...base, signedAt: 101 })).not.toBe(baseMsg);
    expect(buildInvoiceEmailSignableMessage({ ...base, chainId: 2 })).not.toBe(baseMsg);
  });
});

describe("buildRequestEmailSignableMessage", () => {
  it("emits the canonical 5-line shape with the expected order", () => {
    const out = buildRequestEmailSignableMessage({
      requestId: 7,
      recipient: "Bob@Example.com",
      signedAt: 1_700_000_001,
      chainId: 84532,
    });
    expect(out).toBe(
      [
        "Blank: send payment-request email",
        "requestId: 7",
        "recipient: bob@example.com",
        "chainId: 84532",
        "signedAt: 1700000001",
      ].join("\n"),
    );
  });

  it("uses a different prefix line than the invoice variant", () => {
    // SECURITY: the prefix is the cross-message domain separator.
    // If both used "Blank: send X email" with no distinguishing
    // context, an attacker could replay an invoice signature on a
    // request endpoint or vice versa.
    const inv = buildInvoiceEmailSignableMessage({
      invoiceId: 1, recipient: "a@b.com", signedAt: 1, chainId: 1,
    });
    const req = buildRequestEmailSignableMessage({
      requestId: 1, recipient: "a@b.com", signedAt: 1, chainId: 1,
    });
    expect(inv).not.toBe(req);
    expect(inv.split("\n")[0]).toBe("Blank: send invoice email");
    expect(req.split("\n")[0]).toBe("Blank: send payment-request email");
  });

  it("lowercases the recipient before hashing", () => {
    const upper = buildRequestEmailSignableMessage({
      requestId: 1, recipient: "BOB@example.com", signedAt: 1, chainId: 1,
    });
    const lower = buildRequestEmailSignableMessage({
      requestId: 1, recipient: "bob@example.com", signedAt: 1, chainId: 1,
    });
    expect(upper).toBe(lower);
  });
});

// ─── Send wrappers (fetch-mocked) ─────────────────────────────────────

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

describe("sendInvoiceEmail", () => {
  it("posts to /api/email/invoice with the args body", async () => {
    const fetch = mockFetch({ status: 200, body: { messageId: "abc-123" } });
    vi.stubGlobal("fetch", fetch);

    const out = await sendInvoiceEmail({
      invoiceId: 7,
      amount: "100.00",
    });

    expect(out).toEqual({ ok: true, messageId: "abc-123" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/email/invoice");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.invoiceId).toBe(7);
    expect(body.amount).toBe("100.00");
  });

  it("returns ok=false with server error on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: 401, body: { error: "missing signature" } }),
    );
    const out = await sendInvoiceEmail({ invoiceId: 7, amount: "1" });
    expect(out).toEqual({ ok: false, error: "missing signature" });
  });

  it("falls back to HTTP <status> on non-2xx without body.error", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 500, body: {} }));
    const out = await sendInvoiceEmail({ invoiceId: 7, amount: "1" });
    expect(out).toEqual({ ok: false, error: "HTTP 500" });
  });

  it("survives a thrown fetch (network down)", async () => {
    vi.stubGlobal("fetch", mockFetch("throw"));
    const out = await sendInvoiceEmail({ invoiceId: 7, amount: "1" });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("network down");
  });
});

describe("sendPaymentRequestEmail", () => {
  it("posts to /api/email/request with the args body", async () => {
    const fetch = mockFetch({ status: 200, body: { messageId: "req-99" } });
    vi.stubGlobal("fetch", fetch);

    const out = await sendPaymentRequestEmail({ requestId: 7 });

    expect(out).toEqual({ ok: true, messageId: "req-99" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/email/request");
  });

  it("uses a different endpoint than the invoice send", async () => {
    // SECURITY: invoice + request share auth fields but different
    // server-side rules. They MUST hit distinct endpoints.
    const fetch = mockFetch({ status: 200, body: {} });
    vi.stubGlobal("fetch", fetch);
    await sendInvoiceEmail({ invoiceId: 1, amount: "1" });
    await sendPaymentRequestEmail({ requestId: 1 });
    const calls = fetch.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(calls).toEqual(["/api/email/invoice", "/api/email/request"]);
  });
});
