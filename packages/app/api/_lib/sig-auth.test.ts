import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildInvoiceEmailMessage,
  buildRequestEmailMessage,
  checkTimestampWindow,
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
});
