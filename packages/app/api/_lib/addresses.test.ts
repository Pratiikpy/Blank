import { describe, it, expect } from "vitest";
import {
  getContracts,
  CONTRACTS_BY_CHAIN,
  RPC_URLS,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
} from "./addresses.js";

// §15.x server-side test for the api/_lib contract registry. The
// /api/* endpoints route every contract call through here; a
// mismatch with the deployed Wave-3 addresses lands user funds
// in the wrong contract. Pin the contract-address shapes + the
// per-chain isolation.

describe("getContracts", () => {
  it("returns the full ServerContractMap for Eth Sepolia", () => {
    const m = getContracts(ETH_SEPOLIA_ID);
    expect(m).not.toBeNull();
    expect(m!.PaymentHub).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(m!.GiftMoney).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(m!.FHERC20Vault_USDC).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(m!.TestUSDC).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(m!.EntryPoint).toBe("0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108");
    expect(m!.BlankPaymaster).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("returns the full ServerContractMap for Base Sepolia", () => {
    const m = getContracts(BASE_SEPOLIA_ID);
    expect(m).not.toBeNull();
    expect(m!.PaymentHub).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(m!.EntryPoint).toBe("0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108");
  });

  it("returns null for unsupported chain ids", () => {
    expect(getContracts(1)).toBeNull(); // mainnet
    expect(getContracts(137)).toBeNull(); // polygon
    expect(getContracts(0)).toBeNull();
  });

  it("Eth Sepolia and Base Sepolia have DIFFERENT PaymentHub addresses", () => {
    // The CREATE2 deployment scheme produces the same address on
    // both chains for SOME contracts but the hubs were deployed
    // separately. Cross-chain accidental routing here would land
    // funds at the wrong PaymentHub.
    const eth = getContracts(ETH_SEPOLIA_ID)!;
    const base = getContracts(BASE_SEPOLIA_ID)!;
    expect(eth.PaymentHub).not.toBe(base.PaymentHub);
    expect(eth.GiftMoney).not.toBe(base.GiftMoney);
    expect(eth.BlankPaymaster).not.toBe(base.BlankPaymaster);
  });

  it("EntryPoint is the SAME address on both chains (CREATE2 deterministic)", () => {
    // EntryPoint v0.8 deploys to the same address everywhere via
    // CREATE2. If this drifts, every UserOp gets routed to the
    // wrong contract.
    const eth = getContracts(ETH_SEPOLIA_ID)!;
    const base = getContracts(BASE_SEPOLIA_ID)!;
    expect(eth.EntryPoint).toBe(base.EntryPoint);
  });
});

describe("CONTRACTS_BY_CHAIN", () => {
  it("includes both supported chain ids", () => {
    expect(Object.keys(CONTRACTS_BY_CHAIN).sort()).toEqual(
      [String(ETH_SEPOLIA_ID), String(BASE_SEPOLIA_ID)].sort(),
    );
  });
});

describe("RPC_URLS", () => {
  it("provides a default RPC URL for both supported chains", () => {
    expect(RPC_URLS[ETH_SEPOLIA_ID]).toMatch(/^https?:\/\//);
    expect(RPC_URLS[BASE_SEPOLIA_ID]).toMatch(/^https?:\/\//);
  });

  it("Base Sepolia URL contains 'base'", () => {
    expect(RPC_URLS[BASE_SEPOLIA_ID].toLowerCase()).toContain("base");
  });

  it("Eth Sepolia URL is NOT a Base URL (cross-chain accident)", () => {
    expect(RPC_URLS[ETH_SEPOLIA_ID].toLowerCase()).not.toContain("base");
  });
});

// §15.x extension: chain-id literal pins + EntryPoint canonical value
// + ServerContractMap shape + cross-chain isolation deepening + env-
// override behavior via module-reload pattern. The existing test
// asserts addresses LOOK like 0x-hex but doesn't pin the specific
// values; a regression that drifted a deployed address would still
// pass the regex check. Below pins the SHAPE + the env-override
// fallthrough semantics.

import { describe as _d, it as _it, expect as _e, vi, beforeEach, afterEach } from "vitest";

describe("chain id constants", () => {
  it("ETH_SEPOLIA_ID = 11155111 (canonical Ethereum Sepolia chain id)", () => {
    expect(ETH_SEPOLIA_ID).toBe(11155111);
  });

  it("BASE_SEPOLIA_ID = 84532 (canonical Base Sepolia chain id)", () => {
    expect(BASE_SEPOLIA_ID).toBe(84532);
  });

  it("the two chain ids are distinct (basic sanity, no copy-paste collapse)", () => {
    expect(ETH_SEPOLIA_ID).not.toBe(BASE_SEPOLIA_ID);
  });
});

describe("ServerContractMap shape invariants", () => {
  const REQUIRED_FIELDS = [
    "PaymentHub",
    "GiftMoney",
    "FHERC20Vault_USDC",
    "TestUSDC",
    "EntryPoint",
    "BlankPaymaster",
    "PaymentReceipts",
  ] as const;

  it("Eth Sepolia map has EXACTLY 7 required fields (no missing + no extras)", () => {
    const m = getContracts(ETH_SEPOLIA_ID)!;
    expect(Object.keys(m).sort()).toEqual([...REQUIRED_FIELDS].sort());
  });

  it("Base Sepolia map has EXACTLY 7 required fields (no missing + no extras)", () => {
    const m = getContracts(BASE_SEPOLIA_ID)!;
    expect(Object.keys(m).sort()).toEqual([...REQUIRED_FIELDS].sort());
  });

  it("every field on both chains is a valid 0x-hex address (40 hex chars)", () => {
    for (const id of [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID]) {
      const m = getContracts(id)!;
      for (const field of REQUIRED_FIELDS) {
        const addr = m[field];
        expect(addr, `${field} on chain ${id}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });

  it("CONTRACTS_BY_CHAIN has exactly 2 chain entries (no orphan + no missing)", () => {
    expect(Object.keys(CONTRACTS_BY_CHAIN).length).toBe(2);
  });
});

describe("EntryPoint canonical v0.8 address", () => {
  // The EntryPoint deploys to the SAME address on every chain via
  // CREATE2 with a canonical salt. Pin the exact value so a typo or
  // a regression to a fork-specific address (e.g. v0.6 or v0.7)
  // fails loud here.
  const CANONICAL_ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

  it("Eth Sepolia EntryPoint matches the canonical v0.8 address byte-for-byte", () => {
    expect(getContracts(ETH_SEPOLIA_ID)!.EntryPoint).toBe(CANONICAL_ENTRYPOINT_V08);
  });

  it("Base Sepolia EntryPoint matches the canonical v0.8 address byte-for-byte", () => {
    expect(getContracts(BASE_SEPOLIA_ID)!.EntryPoint).toBe(CANONICAL_ENTRYPOINT_V08);
  });
});

describe("cross-chain isolation — every per-chain contract differs", () => {
  // The CREATE2 scheme produces the SAME address only for EntryPoint
  // (one canonical deployer). Every OTHER contract was deployed
  // independently per chain, so a cross-chain accident (e.g.
  // referring to Eth Sepolia's PaymentHub when on Base Sepolia)
  // would route to a non-existent contract on the wrong chain.
  const PER_CHAIN_CONTRACTS = [
    "PaymentHub",
    "GiftMoney",
    "FHERC20Vault_USDC",
    "TestUSDC",
    "BlankPaymaster",
    "PaymentReceipts",
  ] as const;

  it("all 6 per-chain contracts differ between Eth Sepolia and Base Sepolia", () => {
    const eth = getContracts(ETH_SEPOLIA_ID)!;
    const base = getContracts(BASE_SEPOLIA_ID)!;
    for (const field of PER_CHAIN_CONTRACTS) {
      expect(eth[field], `${field} cross-chain collision`).not.toBe(base[field]);
    }
  });
});

describe("readAddr env-override behavior (via module reload)", () => {
  // The CONTRACTS_BY_CHAIN map is computed at module-load time by
  // calling buildMap which calls readAddr. To test env overrides we
  // must set the env var BEFORE re-importing the module. vitest's
  // vi.resetModules + dynamic import handles this.

  beforeEach(() => {
    vi.resetModules();
    delete process.env.BLANK_ETH_SEPOLIA_PAYMENT_HUB;
    delete process.env.BLANK_ETH_SEPOLIA_GIFT_MONEY;
    delete process.env.BLANK_BASE_SEPOLIA_PAYMENT_HUB;
  });

  afterEach(() => {
    delete process.env.BLANK_ETH_SEPOLIA_PAYMENT_HUB;
    delete process.env.BLANK_ETH_SEPOLIA_GIFT_MONEY;
    delete process.env.BLANK_BASE_SEPOLIA_PAYMENT_HUB;
  });

  it("BLANK_ETH_SEPOLIA_PAYMENT_HUB env var with valid 0x address overrides the default", async () => {
    const override = "0x1234567890abcdef1234567890abcdef12345678";
    process.env.BLANK_ETH_SEPOLIA_PAYMENT_HUB = override;
    const mod = await import("./addresses.js");
    expect(mod.getContracts(11155111)!.PaymentHub).toBe(override);
  });

  it("env var with INVALID hex (wrong length) falls back to the default address", async () => {
    process.env.BLANK_ETH_SEPOLIA_PAYMENT_HUB = "0xnotvalid"; // too short
    const mod = await import("./addresses.js");
    // Falls back to the default (NOT the malformed override).
    expect(mod.getContracts(11155111)!.PaymentHub).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(mod.getContracts(11155111)!.PaymentHub).not.toBe("0xnotvalid");
  });

  it("env var with non-0x prefix falls back (defensive: must start with 0x)", async () => {
    process.env.BLANK_ETH_SEPOLIA_PAYMENT_HUB =
      "1234567890abcdef1234567890abcdef12345678";
    const mod = await import("./addresses.js");
    expect(mod.getContracts(11155111)!.PaymentHub).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(mod.getContracts(11155111)!.PaymentHub).not.toContain("1234567890");
  });

  it("env override for ONE contract on ONE chain doesn't affect OTHER contracts on same chain", async () => {
    const override = "0x1111111111111111111111111111111111111111";
    process.env.BLANK_ETH_SEPOLIA_PAYMENT_HUB = override;
    const mod = await import("./addresses.js");
    const eth = mod.getContracts(11155111)!;
    expect(eth.PaymentHub).toBe(override);
    // GiftMoney still uses the default.
    expect(eth.GiftMoney).not.toBe(override);
    expect(eth.GiftMoney).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("env override for Eth Sepolia doesn't bleed into Base Sepolia (per-chain ENV_PREFIX isolation)", async () => {
    const override = "0x1111111111111111111111111111111111111111";
    process.env.BLANK_ETH_SEPOLIA_PAYMENT_HUB = override;
    const mod = await import("./addresses.js");
    const base = mod.getContracts(84532)!;
    expect(base.PaymentHub).not.toBe(override);
    expect(base.PaymentHub).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("env var with empty string falls back to default (typeof check + regex)", async () => {
    process.env.BLANK_ETH_SEPOLIA_PAYMENT_HUB = "";
    const mod = await import("./addresses.js");
    expect(mod.getContracts(11155111)!.PaymentHub).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
