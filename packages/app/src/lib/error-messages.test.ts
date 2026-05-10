import { describe, it, expect } from "vitest";
import { mapError } from "./error-messages";

// §15.x lib test for the central error-message mapper. Every error toast
// in the app flows through this; misclassification means worse UX, missed
// userCancelled suppression, or leaking raw revert strings to users.

describe("mapError", () => {
  it("returns DEFAULT for empty / non-error input", () => {
    expect(mapError(undefined).title).toBe("Transaction failed");
    expect(mapError(null).title).toBe("Transaction failed");
    expect(mapError({}).title).toBe("Transaction failed");
    expect(mapError("").title).toBe("Transaction failed");
  });

  it("classifies user-rejection as userCancelled=true", () => {
    expect(mapError(new Error("User rejected the request")).userCancelled).toBe(true);
    expect(mapError("User denied transaction").userCancelled).toBe(true);
    expect(mapError("user declined").userCancelled).toBe(true);
    expect(mapError("rejected the request").userCancelled).toBe(true);
  });

  it("classifies insufficient funds", () => {
    expect(mapError(new Error("insufficient funds for gas")).title).toBe("Insufficient funds");
    expect(mapError("INSUFFICIENT BALANCE").title).toBe("Insufficient funds");
  });

  it("classifies approval errors", () => {
    expect(mapError(new Error("ERC20 allowance too low")).title).toBe("Approval needed");
    expect(mapError("approve amount required").title).toBe("Approval needed");
  });

  it("classifies gas estimation failures", () => {
    expect(mapError("gas required exceeds limit").title).toBe("Gas estimation failed");
    expect(mapError("gas estimation failed").title).toBe("Gas estimation failed");
  });

  it("classifies nonce / replacement-underpriced errors", () => {
    expect(mapError("nonce too low").title).toBe("Transaction stuck");
    expect(mapError("replacement transaction underpriced").title).toBe("Transaction stuck");
  });

  it("classifies 429 / rate-limit errors", () => {
    expect(mapError("429 Too Many Requests").title).toBe("Rate limited");
    expect(mapError("rate limit exceeded").title).toBe("Rate limited");
  });

  it("classifies network errors", () => {
    expect(mapError("network error: connection lost").title).toBe("Network error");
    expect(mapError("fetch failed").title).toBe("Network error");
    expect(mapError("ECONNREFUSED 0.0.0.0:8545").title).toBe("Network error");
  });

  it("classifies revert as Transaction reverted", () => {
    expect(mapError("execution reverted").title).toBe("Transaction reverted");
    expect(mapError("transaction reverted: BalanceTooLow()").title).toBe("Transaction reverted");
  });

  it("classifies timeout errors", () => {
    expect(mapError("timeout after 30s").title).toBe("Timeout");
    expect(mapError("operation timed out").title).toBe("Timeout");
  });

  it("falls back with raw message for unrecognized errors", () => {
    const result = mapError(new Error("totally random failure mode"));
    expect(result.title).toBe("Transaction failed");
    expect(result.body).toBe("totally random failure mode");
    expect(result.userCancelled).toBe(false);
  });

  it("truncates long unknown messages to 120 chars with ellipsis", () => {
    const longMsg = "a".repeat(200);
    const result = mapError(new Error(longMsg));
    expect(result.body.length).toBeLessThanOrEqual(120);
    expect(result.body.endsWith("…")).toBe(true);
  });

  it("accepts a plain string as input", () => {
    expect(mapError("user rejected").userCancelled).toBe(true);
  });

  it("user-cancellation pattern wins over reverted pattern", () => {
    // Some wallets wrap the rejection in a verbose envelope that also
    // contains "execution reverted". Cancellation must take precedence
    // so the toast suppresses correctly.
    const result = mapError("user rejected the request: execution reverted");
    expect(result.userCancelled).toBe(true);
    expect(result.title).toBe("Cancelled");
  });
});
