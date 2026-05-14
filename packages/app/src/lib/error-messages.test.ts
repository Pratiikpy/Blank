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

// §15.x extension: body-text content + truncation boundary + pattern-
// ordering precedence + exotic-input handling. The body strings are
// the actual UX copy users see in toasts; a regression that flipped
// "Couldn't reach the RPC" to "Network was unreachable" would change
// the user-facing text without touching the title or any structural
// assertion in the existing test.

describe("mapError — body copy per pattern (UX-facing text)", () => {
  it("user-cancelled body is 'You dismissed the wallet prompt.'", () => {
    expect(mapError("user rejected").body).toBe("You dismissed the wallet prompt.");
  });

  it("insufficient funds body mentions balance + gas (the actionable hint)", () => {
    const body = mapError("insufficient funds").body;
    expect(body.toLowerCase()).toContain("balance");
    expect(body.toLowerCase()).toContain("gas");
  });

  it("approval needed body explains the vault-approval-expired case", () => {
    expect(mapError("ERC20 allowance low").body).toContain("vault approval");
  });

  it("gas estimation body hints at network congestion (the retry-after-a-moment frame)", () => {
    const body = mapError("gas estimation failed").body;
    expect(body.toLowerCase()).toContain("network");
    expect(body.toLowerCase()).toContain("retry");
  });

  it("nonce / replacement-underpriced body says 'wait for it to confirm'", () => {
    expect(mapError("nonce too low").body.toLowerCase()).toContain("pending");
  });

  it("rate-limit body says 'few seconds' (the actionable wait hint)", () => {
    expect(mapError("429").body.toLowerCase()).toContain("retry");
  });

  it("network-error body suggests checking the connection", () => {
    const body = mapError("fetch failed").body;
    expect(body.toLowerCase()).toContain("connection");
  });

  it("reverted body mentions 'contract rejected' (less scary than raw 'reverted')", () => {
    expect(mapError("execution reverted").body.toLowerCase()).toContain("contract");
  });

  it("timeout body says 'check the explorer' (the user might still see it confirm)", () => {
    expect(mapError("operation timed out").body.toLowerCase()).toContain("explorer");
  });
});

describe("mapError — userCancelled is FALSE for every non-cancellation pattern", () => {
  // Cancellation suppression hinges on userCancelled being true ONLY
  // for the rejected/denied/declined pattern. A regression that
  // accidentally set userCancelled=true on, say, network errors would
  // silently suppress all the toasts for retry-worthy errors.
  it.each([
    ["insufficient funds", "Insufficient funds"],
    ["ERC20 allowance low", "Approval needed"],
    ["gas estimation failed", "Gas estimation failed"],
    ["nonce too low", "Transaction stuck"],
    ["429 too many", "Rate limited"],
    ["fetch failed", "Network error"],
    ["execution reverted", "Transaction reverted"],
    ["operation timed out", "Timeout"],
  ])("'%s' classified as '%s' with userCancelled=false", (msg, title) => {
    const result = mapError(msg);
    expect(result.title).toBe(title);
    expect(result.userCancelled).toBe(false);
  });

  it("DEFAULT (empty input) is also userCancelled=false", () => {
    expect(mapError("").userCancelled).toBe(false);
  });

  it("unknown-error fallback is userCancelled=false", () => {
    expect(mapError("totally novel error").userCancelled).toBe(false);
  });
});

describe("mapError — truncation boundary cases", () => {
  it("exactly-120-char unknown message is NOT truncated (preserves the boundary)", () => {
    const exact = "x".repeat(120);
    const result = mapError(new Error(exact));
    expect(result.body).toBe(exact);
    expect(result.body.endsWith("…")).toBe(false);
  });

  it("121-char unknown message IS truncated to 117 chars + ellipsis (= 118 total)", () => {
    const overByOne = "x".repeat(121);
    const result = mapError(new Error(overByOne));
    // Source slices to 117 then adds "…" -> total length 118.
    expect(result.body.length).toBe(118);
    expect(result.body.startsWith("x".repeat(117))).toBe(true);
    expect(result.body.endsWith("…")).toBe(true);
  });

  it("very long unknown messages are still truncated to 118 chars (no unbounded body)", () => {
    const huge = "x".repeat(10_000);
    const result = mapError(new Error(huge));
    expect(result.body.length).toBe(118);
  });
});

describe("mapError — PATTERNS array order (precedence)", () => {
  it("cancellation comes BEFORE every other pattern (suppression must win)", () => {
    // Construct messages where the cancellation phrase coexists with
    // EACH other classifier; cancellation must still win.
    const co = "user rejected — insufficient funds for gas";
    expect(mapError(co).userCancelled).toBe(true);
    expect(mapError("user rejected — 429 too many requests").userCancelled).toBe(true);
    expect(mapError("user rejected — execution reverted: Foo()").userCancelled).toBe(true);
  });

  it("insufficient funds wins over generic 'reverted' (specific beats generic)", () => {
    // A raw revert with the InsufficientFunds() custom error string
    // contains BOTH classifier phrases. The order in PATTERNS puts
    // insufficient-funds BEFORE the generic revert classifier.
    const result = mapError("execution reverted: insufficient funds for transfer");
    expect(result.title).toBe("Insufficient funds");
  });

  it("rate-limit wins over generic 'network error' (specific beats generic)", () => {
    const result = mapError("network error: 429 Too Many Requests");
    expect(result.title).toBe("Rate limited");
  });
});

describe("mapError — exotic input types", () => {
  it("a number input is treated as missing (returns DEFAULT)", () => {
    expect(mapError(42).title).toBe("Transaction failed");
    expect(mapError(42).body).toBe("Something went wrong. Please try again.");
  });

  it("a boolean input is treated as missing (returns DEFAULT)", () => {
    expect(mapError(true).title).toBe("Transaction failed");
    expect(mapError(false).title).toBe("Transaction failed");
  });

  it("an array input is treated as missing (returns DEFAULT)", () => {
    expect(mapError([1, 2, 3]).title).toBe("Transaction failed");
  });

  it("a TypeError (Error subclass) gets its message classified normally", () => {
    const err = new TypeError("user rejected the request");
    expect(mapError(err).userCancelled).toBe(true);
  });

  it("a custom Error subclass gets its message classified normally", () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }
    const err = new CustomError("execution reverted: Foo()");
    expect(mapError(err).title).toBe("Transaction reverted");
  });
});
