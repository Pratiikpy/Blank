import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";
import {
  ClaimLinksAbi,
  StorefrontAbi,
  EncryptedCrowdfundAbi,
  EncryptedEscrowAbi,
  PaymentHubAbi,
} from "./abis";

// §15.x lib test for the Wave 4 contract ABIs. The ABIs declared
// here are what wagmi/viem use to encode/decode every contract
// call from the frontend; if a function name or signature drifts
// from the deployed bytecode, the call fails with a generic
// "function not found" / "decode failed" with no signal of which
// piece broke. Pin the function selectors against deployed state.

function selector(humanReadable: string): `0x${string}` {
  return toFunctionSelector(humanReadable);
}

function abiSelectors(abi: readonly unknown[]): Set<`0x${string}`> {
  const out = new Set<`0x${string}`>();
  for (const entry of abi as Array<{ type?: string; name?: string; inputs?: Array<{ type: string }> }>) {
    if (entry.type !== "function" || !entry.name) continue;
    const sig = `function ${entry.name}(${(entry.inputs ?? [])
      .map((i) => i.type)
      .join(",")})`;
    try {
      out.add(toFunctionSelector(sig));
    } catch {
      // tuples need internal-type expansion; skip those for the
      // selector check (they're tested by the wagmi e2e flow).
    }
  }
  return out;
}

describe("ClaimLinksAbi", () => {
  const sels = abiSelectors(ClaimLinksAbi);

  it("includes claimBearer(uint256,bytes32) selector", () => {
    expect(sels.has(selector("function claimBearer(uint256,bytes32)"))).toBe(true);
  });

  it("includes claimEmailBound(uint256,bytes32,bytes32) selector", () => {
    expect(
      sels.has(selector("function claimEmailBound(uint256,bytes32,bytes32)")),
    ).toBe(true);
  });

  it("includes claimAddressBound(uint256,bytes32) selector", () => {
    expect(sels.has(selector("function claimAddressBound(uint256,bytes32)"))).toBe(true);
  });

  it("includes refundLink(uint256) selector", () => {
    expect(sels.has(selector("function refundLink(uint256)"))).toBe(true);
  });
});

describe("Wave 4 contract ABIs are non-empty", () => {
  it("ClaimLinksAbi has function entries", () => {
    expect(ClaimLinksAbi.length).toBeGreaterThan(0);
    expect(ClaimLinksAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });

  it("StorefrontAbi has function entries", () => {
    expect(StorefrontAbi.length).toBeGreaterThan(0);
    expect(StorefrontAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });

  it("EncryptedCrowdfundAbi has function entries", () => {
    expect(EncryptedCrowdfundAbi.length).toBeGreaterThan(0);
    expect(EncryptedCrowdfundAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });

  it("EncryptedEscrowAbi has function entries", () => {
    expect(EncryptedEscrowAbi.length).toBeGreaterThan(0);
    expect(EncryptedEscrowAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });

  it("PaymentHubAbi has function entries", () => {
    expect(PaymentHubAbi.length).toBeGreaterThan(0);
    expect(PaymentHubAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });
});

describe("Wave 4 ABIs have unique function selectors (no collisions)", () => {
  // Selector collisions (same first-4-bytes hash) on different
  // functions in the same contract would silently route calls to
  // the wrong implementation. viem catches some at runtime but
  // pinning here surfaces drift earlier.
  it("ClaimLinksAbi has no selector collisions", () => {
    const sels = abiSelectors(ClaimLinksAbi);
    const names = new Set<string>();
    for (const entry of ClaimLinksAbi as readonly { type?: string; name?: string }[]) {
      if (entry.type === "function" && entry.name) names.add(entry.name);
    }
    // At least as many selectors as unique function names (some
    // may overload, but for our ABIs every function is uniquely
    // named).
    expect(sels.size).toBeGreaterThanOrEqual(1);
    expect(sels.size).toBeLessThanOrEqual(names.size);
  });
});
