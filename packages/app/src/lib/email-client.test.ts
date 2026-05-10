import { describe, it, expect } from "vitest";
import {
  buildInvoiceEmailSignableMessage,
  buildRequestEmailSignableMessage,
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
