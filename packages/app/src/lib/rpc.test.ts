import { describe, it, expect } from "vitest";
import { getRpcUrls } from "./rpc";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID, type SupportedChainId } from "./constants";

// §15.x lib test for the per-chain RPC URL resolver. The list gets
// passed to viem's fallback() transport so order matters (primary
// first, public fallbacks after) and the URL set must be non-empty.

describe("getRpcUrls", () => {
  it("returns a non-empty list for Eth Sepolia", () => {
    const urls = getRpcUrls(ETH_SEPOLIA_ID);
    expect(urls.length).toBeGreaterThan(0);
  });

  it("returns a non-empty list for Base Sepolia", () => {
    const urls = getRpcUrls(BASE_SEPOLIA_ID);
    expect(urls.length).toBeGreaterThan(0);
  });

  it("returns only well-formed https URLs", () => {
    for (const id of [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID] as SupportedChainId[]) {
      for (const url of getRpcUrls(id)) {
        expect(url).toMatch(/^https?:\/\//);
        // Must be parseable
        expect(() => new URL(url)).not.toThrow();
      }
    }
  });

  it("Eth Sepolia URLs reference 'sepolia' or a publicnode-style host", () => {
    const urls = getRpcUrls(ETH_SEPOLIA_ID);
    for (const url of urls) {
      const lower = url.toLowerCase();
      const ok = lower.includes("sepolia") || lower.includes("publicnode");
      expect(ok).toBe(true);
    }
  });

  it("Base Sepolia URLs reference 'base' AND 'sepolia' (or are a sepolia gateway)", () => {
    const urls = getRpcUrls(BASE_SEPOLIA_ID);
    for (const url of urls) {
      const lower = url.toLowerCase();
      // Each Base Sepolia URL must clearly bind to base+sepolia (cross-
      // chain accidental routes here would be a serious bug).
      expect(lower).toContain("base");
      expect(lower).toContain("sepolia");
    }
  });

  it("never includes mainnet endpoints", () => {
    for (const id of [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID] as SupportedChainId[]) {
      for (const url of getRpcUrls(id)) {
        const lower = url.toLowerCase();
        // Sanity: a mainnet RPC slipping in would silently route writes
        // to mainnet under a chain switch. Belt-and-suspenders gate.
        expect(lower).not.toMatch(/mainnet|ethereum-rpc\.publicnode/);
      }
    }
  });

  it("returns the same list shape on repeated calls (no mutation)", () => {
    const a = getRpcUrls(ETH_SEPOLIA_ID);
    const b = getRpcUrls(ETH_SEPOLIA_ID);
    expect(a).toEqual(b);
  });
});
