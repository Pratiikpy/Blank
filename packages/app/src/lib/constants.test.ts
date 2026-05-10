import { describe, it, expect } from "vitest";
import {
  getExplorerTxUrl,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  CHAINS,
} from "./constants";

// §15.x lib test for the per-chain explorer-URL helper. §3.12 wired
// this into all 4 Wave 4 hooks so consumer screens render
// `txExplorerUrl` directly without re-implementing the chain → URL
// mapping. Pin the contract: known chains route to their own
// explorer; unknown chains fall back to Base Sepolia.

describe("getExplorerTxUrl", () => {
  const txHash = "0x1234567890abcdef";

  it("returns the etherscan URL for Eth Sepolia", () => {
    expect(getExplorerTxUrl(txHash, ETH_SEPOLIA_ID)).toBe(
      `${CHAINS[ETH_SEPOLIA_ID].explorerUrl}/tx/${txHash}`,
    );
    expect(getExplorerTxUrl(txHash, ETH_SEPOLIA_ID)).toContain("sepolia.etherscan.io");
  });

  it("returns the basescan URL for Base Sepolia", () => {
    expect(getExplorerTxUrl(txHash, BASE_SEPOLIA_ID)).toBe(
      `${CHAINS[BASE_SEPOLIA_ID].explorerUrl}/tx/${txHash}`,
    );
    expect(getExplorerTxUrl(txHash, BASE_SEPOLIA_ID)).toContain("sepolia-explorer.base.org");
  });

  it("falls back to Base Sepolia when chainId is undefined", () => {
    expect(getExplorerTxUrl(txHash)).toBe(
      `${CHAINS[BASE_SEPOLIA_ID].explorerUrl}/tx/${txHash}`,
    );
  });

  it("falls back to Base Sepolia for an unknown chainId", () => {
    // mainnet (1) is not in our supported set; explorer URL must NOT
    // be a mainnet domain — it falls back to the testnet default so
    // links never accidentally point at mainnet.
    const url = getExplorerTxUrl(txHash, 1);
    expect(url).toBe(`${CHAINS[BASE_SEPOLIA_ID].explorerUrl}/tx/${txHash}`);
    expect(url).not.toContain("etherscan.io/tx");
  });

  it("interpolates the tx hash verbatim (no encoding)", () => {
    const weirdHash = "0xABCdef0123456789";
    const url = getExplorerTxUrl(weirdHash, BASE_SEPOLIA_ID);
    expect(url.endsWith(`/tx/${weirdHash}`)).toBe(true);
  });
});
