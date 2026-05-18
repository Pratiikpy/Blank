import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getExplorerTxUrl,
  setActiveChainId,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  CHAINS,
  FAUCET_LINKS,
  CONTRACTS_BY_CHAIN,
  AGENT_ATTESTATION_ADDRESS,
  MAX_UINT64,
  TOKEN_DECIMALS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  PERMIT_EXPIRY_DAYS,
  MAX_BATCH_RECIPIENTS,
  REVEAL_TIMEOUT_MS,
  ENCRYPTED_PLACEHOLDER,
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

// §15.x extension: chain-id constants + chain-registry shape +
// FAUCET_LINKS + contract-map shape + setActiveChainId behavior +
// numeric constants. A regression here would silently break the
// frontend's chain routing — e.g. a swapped chain id would map
// every contract address to the wrong chain's deployment, sending
// user funds to a non-existent contract or to a different live
// contract on a different network.

describe("chain-id constants", () => {
  it("ETH_SEPOLIA_ID = 11155111 (canonical Ethereum Sepolia chain id)", () => {
    expect(ETH_SEPOLIA_ID).toBe(11155111);
  });

  it("BASE_SEPOLIA_ID = 84532 (canonical Base Sepolia chain id)", () => {
    expect(BASE_SEPOLIA_ID).toBe(84532);
  });

  it("the two chain ids are distinct (no collision)", () => {
    expect(ETH_SEPOLIA_ID).not.toBe(BASE_SEPOLIA_ID);
  });
});

describe("CHAINS registry shape", () => {
  it("has exactly entries for both supported chain ids", () => {
    expect(Object.keys(CHAINS).length).toBe(2);
    expect(CHAINS[ETH_SEPOLIA_ID]).toBeDefined();
    expect(CHAINS[BASE_SEPOLIA_ID]).toBeDefined();
  });

  it("every entry has all 8 required ChainInfo fields", () => {
    for (const id of [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID] as const) {
      const c = CHAINS[id];
      expect(c.id).toBe(id);
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.shortName).toBe("string");
      expect(typeof c.network).toBe("string");
      expect(c.rpcUrl).toMatch(/^https?:\/\//);
      expect(c.explorerUrl).toMatch(/^https?:\/\//);
      expect(c.coFheUrl).toMatch(/^https?:\/\//);
      expect(c.verifierUrl).toMatch(/^https?:\/\//);
      expect(c.thresholdNetworkUrl).toMatch(/^https?:\/\//);
    }
  });

  it("explorer URLs point at the correct chain (etherscan for Eth Sepolia, basescan-equivalent for Base Sepolia)", () => {
    expect(CHAINS[ETH_SEPOLIA_ID].explorerUrl).toMatch(/sepolia\.etherscan\.io/);
    expect(CHAINS[BASE_SEPOLIA_ID].explorerUrl).toMatch(/base\.org|basescan/);
  });
});

describe("FAUCET_LINKS shape", () => {
  it("has at least one faucet for each supported chain (don't leave a chain with no faucet hint)", () => {
    expect(FAUCET_LINKS[ETH_SEPOLIA_ID].length).toBeGreaterThan(0);
    expect(FAUCET_LINKS[BASE_SEPOLIA_ID].length).toBeGreaterThan(0);
  });

  it("every faucet entry has a label + a URL", () => {
    for (const id of [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID] as const) {
      for (const f of FAUCET_LINKS[id]) {
        expect(typeof f.label).toBe("string");
        expect(f.label.length).toBeGreaterThan(0);
        expect(f.url).toMatch(/^https?:\/\//);
      }
    }
  });

  it("URLs are unique within a chain (no duplicate suggestions)", () => {
    for (const id of [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID] as const) {
      const urls = FAUCET_LINKS[id].map((f) => f.url);
      expect(new Set(urls).size).toBe(urls.length);
    }
  });
});

describe("CONTRACTS_BY_CHAIN shape", () => {
  it("has entries for both supported chains", () => {
    expect(CONTRACTS_BY_CHAIN[ETH_SEPOLIA_ID]).toBeDefined();
    expect(CONTRACTS_BY_CHAIN[BASE_SEPOLIA_ID]).toBeDefined();
  });

  it("required ContractMap fields are populated as 0x-prefixed addresses on both chains", () => {
    const required = [
      "TestUSDC", "TokenRegistry", "EventHub", "FHERC20Vault_USDC",
      "PaymentHub", "GroupManager", "CreatorHub", "BusinessHub",
      "P2PExchange", "InheritanceManager", "PaymentReceipts",
      "EncryptedFlags", "GiftMoney", "PrivacyRouter", "StealthPayments",
      "MockDEX", "EntryPoint", "BlankAccountFactory", "BlankPaymaster",
      "BurnerRegistry", "BlankAccount_Impl_v041", "SessionKeyValidator",
      "ERC5564Announcer", "ERC6538Registry",
      "ClaimLinks", "Storefront",
    ];
    for (const chainId of [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID] as const) {
      const m = CONTRACTS_BY_CHAIN[chainId] as Record<string, unknown>;
      for (const key of required) {
        expect(m[key], `${key} on chain ${chainId}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });
});

describe("setActiveChainId (localStorage persistence)", () => {
  // The function also calls `window.location.reload()` but jsdom's
  // reload is non-configurable. The localStorage write is the
  // load-bearing piece: at next module load, `readActiveChainId`
  // reads this key and resolves SUPPORTED_CHAIN_ID + ACTIVE_CHAIN +
  // CONTRACTS to the new chain. Reload is just the propagation
  // mechanism (simpler than reactive plumbing per the source comment).
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("persists the new chain id to localStorage under the canonical key 'blank:active_chain_id'", () => {
    try {
      setActiveChainId(BASE_SEPOLIA_ID);
    } catch {
      // jsdom's location.reload throws on call — ignore; we only care
      // about the localStorage side effect which happens BEFORE the reload.
    }
    // Canonical key, shared with ChainProvider via STORAGE_KEYS.activeChainId.
    // Pre-fix used the underscore-form "blank_active_chain_id" which never
    // collided with the colon-form key ChainProvider writes — module-level
    // SUPPORTED_CHAIN_ID stayed on Eth Sepolia regardless of UI selection.
    expect(localStorage.getItem("blank:active_chain_id")).toBe(String(BASE_SEPOLIA_ID));
  });

  it("overwrites a prior value on a subsequent call (per-call setter, not append-only)", () => {
    try { setActiveChainId(BASE_SEPOLIA_ID); } catch {}
    try { setActiveChainId(ETH_SEPOLIA_ID); } catch {}
    expect(localStorage.getItem("blank:active_chain_id")).toBe(String(ETH_SEPOLIA_ID));
  });

  it("the storage key 'blank:active_chain_id' is namespaced (won't collide with other apps on the same origin)", () => {
    try { setActiveChainId(BASE_SEPOLIA_ID); } catch {}
    // The key starts with 'blank' to namespace under our app prefix.
    const keys = Object.keys(localStorage);
    expect(keys.some((k) => k.startsWith("blank"))).toBe(true);
  });
});

describe("misc constants (numeric + format invariants)", () => {
  it("MAX_UINT64 = 2^64 - 1 (the FHE euint64 max)", () => {
    expect(MAX_UINT64).toBe((1n << 64n) - 1n);
    expect(MAX_UINT64.toString()).toBe("18446744073709551615");
  });

  it("TOKEN_DECIMALS = 6 (matches TestUSDC.decimals())", () => {
    expect(TOKEN_DECIMALS).toBe(6);
  });

  it("POLL_INTERVAL_MS < POLL_TIMEOUT_MS (intervals can't outlast the timeout window)", () => {
    expect(POLL_INTERVAL_MS).toBeLessThan(POLL_TIMEOUT_MS);
    expect(POLL_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("PERMIT_EXPIRY_DAYS is a positive integer (no fractional days, no zero / negative)", () => {
    expect(Number.isInteger(PERMIT_EXPIRY_DAYS)).toBe(true);
    expect(PERMIT_EXPIRY_DAYS).toBeGreaterThan(0);
  });

  it("MAX_BATCH_RECIPIENTS is a reasonable cap (positive, less than block gas headroom)", () => {
    expect(MAX_BATCH_RECIPIENTS).toBeGreaterThan(0);
    expect(MAX_BATCH_RECIPIENTS).toBeLessThanOrEqual(100);
  });

  it("REVEAL_TIMEOUT_MS is at least 1 second (don't auto-hide before the user can read)", () => {
    expect(REVEAL_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
  });

  it("ENCRYPTED_PLACEHOLDER is a fixed bullet-style mask (••••.••)", () => {
    expect(ENCRYPTED_PLACEHOLDER).toBe("••••.••");
    // Looks like "••••.••" when rendered.
    expect(ENCRYPTED_PLACEHOLDER.length).toBe(7);
  });

  it("AGENT_ATTESTATION_ADDRESS is a valid 0x address (20 bytes hex)", () => {
    expect(AGENT_ATTESTATION_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
