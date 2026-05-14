import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildInvoiceEmailMessage,
  buildRequestEmailMessage,
  checkTimestampWindow,
  strictEmailAuthEnabled,
  verifyOwnerSignature,
  SIGNATURE_WINDOW_SECONDS,
} from "./sig-auth.js";

// §15.x server-side test for sig-auth pure helpers. The audit
// Top-28 #14 fix made checkTimestampWindow asymmetric (past
// tolerance bounded by SIGNATURE_WINDOW_SECONDS, future bounded
// by a small clock-skew window). Pre-fix this used Math.abs
// which accepted stolen old signatures just as readily as
// future ones; replay risk is asymmetric so the bound must
// reflect that.

describe("buildInvoiceEmailMessage (server side)", () => {
  it("matches the client-side builder byte-for-byte", () => {
    // Verifies BOTH sides emit the same canonical message. If
    // either side drifts, the verifyMessage call rejects with a
    // generic 401 and the user has no signal where it broke.
    const out = buildInvoiceEmailMessage({
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

  it("lowercases the recipient", () => {
    expect(
      buildInvoiceEmailMessage({ invoiceId: 1, recipient: "X@Y.com", signedAt: 1, chainId: 1 }),
    ).toContain("recipient: x@y.com");
  });
});

describe("buildRequestEmailMessage (server side)", () => {
  it("uses a different prefix than the invoice variant", () => {
    const inv = buildInvoiceEmailMessage({
      invoiceId: 1, recipient: "a@b.com", signedAt: 1, chainId: 1,
    });
    const req = buildRequestEmailMessage({
      requestId: 1, recipient: "a@b.com", signedAt: 1, chainId: 1,
    });
    expect(inv.split("\n")[0]).toBe("Blank: send invoice email");
    expect(req.split("\n")[0]).toBe("Blank: send payment-request email");
  });
});

describe("checkTimestampWindow (audit Top-28 #14)", () => {
  // Use vi.useFakeTimers + setSystemTime so we control "now".
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000 * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a signature signed exactly now", () => {
    expect(checkTimestampWindow(1_700_000_000)).toBeNull();
  });

  it("accepts a signature within the past window (90s default)", () => {
    expect(checkTimestampWindow(1_700_000_000 - 30)).toBeNull();
    expect(checkTimestampWindow(1_700_000_000 - 89)).toBeNull();
  });

  it("rejects a signature older than SIGNATURE_WINDOW_SECONDS", () => {
    const out = checkTimestampWindow(1_700_000_000 - SIGNATURE_WINDOW_SECONDS - 1);
    expect(out).not.toBeNull();
    expect(out).toContain("too old");
  });

  it("accepts a slightly-future signature (clock-skew tolerance)", () => {
    expect(checkTimestampWindow(1_700_000_000 + 30)).toBeNull();
    expect(checkTimestampWindow(1_700_000_000 + 60)).toBeNull();
  });

  it("rejects a signature too far in the future (audit Top-28 #14)", () => {
    // Pre-fix: Math.abs accepted +90s just as readily as -90s.
    // Post-fix: future bound is a small skew tolerance, much
    // tighter than the past bound.
    const out = checkTimestampWindow(1_700_000_000 + 120);
    expect(out).not.toBeNull();
    expect(out).toContain("future");
  });

  it("rejects non-numeric signedAt with a clear error", () => {
    expect(checkTimestampWindow("not a number")).toContain("unix-seconds number");
    expect(checkTimestampWindow(undefined)).toContain("unix-seconds number");
    expect(checkTimestampWindow(NaN)).toContain("unix-seconds number");
  });

  it("the past window is wider than the future window (asymmetric)", () => {
    // Symmetric Math.abs would accept both. Asymmetric implementation
    // accepts -89s but rejects +120s — verify the gap.
    expect(checkTimestampWindow(1_700_000_000 - 89)).toBeNull();
    expect(checkTimestampWindow(1_700_000_000 + 89)).toContain("future");
  });

  it("exact past boundary: signedAt = now - SIGNATURE_WINDOW_SECONDS (90s) is ACCEPTED", () => {
    // The check uses `ageSeconds > SIGNATURE_WINDOW_SECONDS`, so age =
    // exactly 90s is admitted (strict-greater-than is the boundary).
    expect(checkTimestampWindow(1_700_000_000 - SIGNATURE_WINDOW_SECONDS)).toBeNull();
  });

  it("exact future boundary: signedAt = now + 60 (clock-skew) is ACCEPTED but +61 is rejected", () => {
    // ageSeconds = now - (now + 60) = -60. The check is
    // `ageSeconds < -60`, so -60 is admitted, -61 is rejected.
    expect(checkTimestampWindow(1_700_000_000 + 60)).toBeNull();
    expect(checkTimestampWindow(1_700_000_000 + 61)).toContain("future");
  });

  it("signedAt=0 (epoch) is rejected as too old (sanity catch for missing/default value)", () => {
    expect(checkTimestampWindow(0)).toContain("too old");
  });

  it("rejects non-finite signedAt: Infinity, -Infinity (Number.isFinite gate)", () => {
    expect(checkTimestampWindow(Infinity)).toContain("unix-seconds number");
    expect(checkTimestampWindow(-Infinity)).toContain("unix-seconds number");
  });

  it("rejects null + boolean signedAt (typeof number check)", () => {
    expect(checkTimestampWindow(null)).toContain("unix-seconds number");
    expect(checkTimestampWindow(true)).toContain("unix-seconds number");
    expect(checkTimestampWindow(false)).toContain("unix-seconds number");
  });
});

// §15.x extension: SIGNATURE_WINDOW_SECONDS value pin + buildRequest
// byte-for-byte + strictEmailAuthEnabled env flag + verifyOwnerSignature
// unsupported-chain path. The Top-28 #14 audit set the window to 90s
// after the previous 5-minute window was deemed too permissive; pinning
// the literal value catches a regression that drifted it back up.

describe("SIGNATURE_WINDOW_SECONDS constant (Top-28 #14)", () => {
  it("= 90 seconds (the audited replay-protection window)", () => {
    expect(SIGNATURE_WINDOW_SECONDS).toBe(90);
  });
});

describe("buildRequestEmailMessage — byte-for-byte + lowercase", () => {
  it("emits the canonical 5-line shape with the payment-request prefix", () => {
    const out = buildRequestEmailMessage({
      requestId: 17,
      recipient: "Bob@Example.com",
      signedAt: 1_700_000_000,
      chainId: 84532,
    });
    expect(out).toBe(
      [
        "Blank: send payment-request email",
        "requestId: 17",
        "recipient: bob@example.com",
        "chainId: 84532",
        "signedAt: 1700000000",
      ].join("\n"),
    );
  });

  it("lowercases the recipient (same normalization as the invoice builder)", () => {
    expect(
      buildRequestEmailMessage({
        requestId: 1,
        recipient: "MIXED@CaSe.COM",
        signedAt: 1,
        chainId: 1,
      }),
    ).toContain("recipient: mixed@case.com");
  });
});

describe("buildInvoiceEmailMessage — chain id passthrough", () => {
  it("emits chainId as-is for Base Sepolia (84532)", () => {
    const out = buildInvoiceEmailMessage({
      invoiceId: 1,
      recipient: "a@b.c",
      signedAt: 1,
      chainId: 84532,
    });
    expect(out).toContain("chainId: 84532");
  });

  it("emits chainId as-is for Eth Sepolia (11155111)", () => {
    const out = buildInvoiceEmailMessage({
      invoiceId: 1,
      recipient: "a@b.c",
      signedAt: 1,
      chainId: 11155111,
    });
    expect(out).toContain("chainId: 11155111");
  });
});

describe("strictEmailAuthEnabled (the fail-closed feature flag)", () => {
  afterEach(() => {
    delete process.env.STRICT_EMAIL_AUTH;
  });

  it("defaults to TRUE when STRICT_EMAIL_AUTH is unset (fail-closed shipped default)", () => {
    delete process.env.STRICT_EMAIL_AUTH;
    expect(strictEmailAuthEnabled()).toBe(true);
  });

  it("returns FALSE when STRICT_EMAIL_AUTH is exactly '0' (explicit opt-out for local dev)", () => {
    process.env.STRICT_EMAIL_AUTH = "0";
    expect(strictEmailAuthEnabled()).toBe(false);
  });

  it("returns TRUE for any other value (even 'false') — only the literal '0' disables", () => {
    process.env.STRICT_EMAIL_AUTH = "false";
    expect(strictEmailAuthEnabled()).toBe(true);
    process.env.STRICT_EMAIL_AUTH = "no";
    expect(strictEmailAuthEnabled()).toBe(true);
    process.env.STRICT_EMAIL_AUTH = "1";
    expect(strictEmailAuthEnabled()).toBe(true);
    process.env.STRICT_EMAIL_AUTH = "";
    expect(strictEmailAuthEnabled()).toBe(true);
  });
});

describe("verifyOwnerSignature — unsupported chain path", () => {
  it("returns ok=false with 'unsupported chainId' reason for mainnet (1)", async () => {
    const out = await verifyOwnerSignature({
      chainId: 1,
      signer: "0x1234567890abcdef1234567890abcdef12345678",
      message: "test",
      signature: "0xdeadbeef",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("unsupported chainId");
    expect(out.reason).toContain("1");
  });

  it("returns ok=false with 'unsupported chainId' reason for arbitrary unknown id", async () => {
    const out = await verifyOwnerSignature({
      chainId: 999999,
      signer: "0x1234567890abcdef1234567890abcdef12345678",
      message: "test",
      signature: "0xdeadbeef",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("unsupported chainId");
  });

  it("returns ok=false with 'unsupported chainId' for chainId=0 (defensive zero check)", async () => {
    const out = await verifyOwnerSignature({
      chainId: 0,
      signer: "0x1234567890abcdef1234567890abcdef12345678",
      message: "test",
      signature: "0xdeadbeef",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("unsupported chainId");
  });
});
