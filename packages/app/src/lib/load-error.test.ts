import { describe, it, expect } from "vitest";
import { classifyLoadError } from "./load-error";

// §15.x test for the F1 fix: every Wave 4 public deep-link page used
// to render raw RPC errors like "HTTPProviderError: 429 Too Many
// Requests" as a full-page headline. The classifier splits errors
// into transient (retry CTA) vs permanent (no retry, go home).
//
// CRITICAL invariants pinned:
//   - 429 / rate-limit / timeout / network / 5xx -> transient
//   - "not found" / "reverted" / "does not exist" -> permanent
//   - Permanent patterns take precedence over transient ones (so a
//     revert string mentioning "timeout" doesn't get a retry CTA)
//   - Unknown errors default to transient (retry costs nothing,
//     routing them to "not found" would block legitimate recovery)
//   - Headlines + hints are user-readable (no raw err.message leak)
//   - rawCause is preserved for the collapsed-details affordance

describe("classifyLoadError — transient errors (retry CTA)", () => {
  const ctx = { resourceName: "Link", chainName: "Ethereum Sepolia" };

  it("classifies HTTP 429 as transient", () => {
    const out = classifyLoadError(new Error("HTTP 429 Too Many Requests"), ctx);
    expect(out.kind).toBe("transient");
    expect(out.headline).toBe("Network busy");
  });

  it("classifies 'rate limit' string as transient", () => {
    const out = classifyLoadError(new Error("Provider rate-limit exceeded"), ctx);
    expect(out.kind).toBe("transient");
  });

  it("classifies timeout as transient", () => {
    expect(classifyLoadError(new Error("Request timed out"), ctx).kind).toBe("transient");
    expect(classifyLoadError(new Error("ETIMEDOUT"), ctx).kind).toBe("transient");
  });

  it("classifies ECONNRESET / ECONNREFUSED as transient", () => {
    expect(classifyLoadError(new Error("ECONNRESET on socket"), ctx).kind).toBe("transient");
    expect(classifyLoadError(new Error("ECONNREFUSED 127.0.0.1:8545"), ctx).kind).toBe("transient");
  });

  it("classifies 'Failed to fetch' (browser network error) as transient", () => {
    expect(classifyLoadError(new Error("Failed to fetch"), ctx).kind).toBe("transient");
  });

  it("classifies HTTP 5xx as transient", () => {
    expect(classifyLoadError(new Error("HTTP 502 Bad Gateway"), ctx).kind).toBe("transient");
    expect(classifyLoadError(new Error("503 Service Unavailable"), ctx).kind).toBe("transient");
  });

  it("hint mentions the chain name when provided", () => {
    const out = classifyLoadError(new Error("429"), ctx);
    expect(out.hint).toContain("Ethereum Sepolia");
  });

  it("hint omits the chain name when not provided (no 'undefined' leak)", () => {
    const out = classifyLoadError(new Error("429"), { resourceName: "Listing" });
    expect(out.hint).not.toContain("undefined");
    expect(out.hint).toContain("chain");
  });
});

describe("classifyLoadError — permanent errors (no retry)", () => {
  const ctx = { resourceName: "Link", chainName: "Base Sepolia" };

  it("'not found' is permanent", () => {
    expect(classifyLoadError(new Error("ClaimLinks: not found"), ctx).kind).toBe("permanent");
  });

  it("'execution reverted' is permanent", () => {
    expect(classifyLoadError(new Error("execution reverted"), ctx).kind).toBe("permanent");
  });

  it("'reverted with reason' (viem's wrapped revert) is permanent", () => {
    const err = new Error("ContractFunctionExecutionError: The contract function 'getLink' reverted with the following reason: not found");
    expect(classifyLoadError(err, ctx).kind).toBe("permanent");
  });

  it("'does not exist' is permanent", () => {
    expect(classifyLoadError(new Error("listing does not exist"), ctx).kind).toBe("permanent");
  });

  it("'unsupported chain' is permanent", () => {
    expect(classifyLoadError(new Error("unsupported chain id"), ctx).kind).toBe("permanent");
  });

  it("permanent hint mentions the chain name + resource", () => {
    const out = classifyLoadError(new Error("not found"), ctx);
    expect(out.hint).toContain("Base Sepolia");
    expect(out.hint.toLowerCase()).toContain("link");
  });
});

describe("classifyLoadError — precedence + defaults", () => {
  it("CRITICAL: permanent patterns beat transient when both match", () => {
    // Revert strings sometimes mention "timeout" (e.g. 'auction
    // settlement not yet timed out'). Permanent must win.
    const err = new Error("execution reverted: deadline timeout not elapsed");
    expect(classifyLoadError(err, { resourceName: "Listing" }).kind).toBe("permanent");
  });

  it("unknown error defaults to transient (recoverable)", () => {
    const out = classifyLoadError(new Error("something totally weird"), { resourceName: "Campaign" });
    expect(out.kind).toBe("transient");
    expect(out.headline).toBe("Couldn't load");
  });

  it("non-Error throws still produce a usable classification", () => {
    expect(classifyLoadError("a string was thrown", { resourceName: "Link" }).kind).toBe("transient");
    expect(classifyLoadError(undefined, { resourceName: "Link" }).kind).toBe("transient");
    expect(classifyLoadError(null, { resourceName: "Link" }).kind).toBe("transient");
    expect(classifyLoadError({ shape: "object" }, { resourceName: "Link" }).kind).toBe("transient");
  });

  it("rawCause preserves the original message for debug details", () => {
    const out = classifyLoadError(new Error("HTTPProviderError: 429 from sepolia.publicnode.com"), {
      resourceName: "Link",
    });
    expect(out.rawCause).toContain("publicnode");
    expect(out.rawCause).toContain("429");
  });
});
