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
