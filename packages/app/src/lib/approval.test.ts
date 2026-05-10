import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  setApprovalContext,
  isVaultApproved,
  markVaultApproved,
  clearVaultApproval,
} from "./approval";

// §15.x lib test for the #102 fix that switched the vault-approval
// cache from spender-only keying to (sender, spender, chainId)
// keying. Pre-fix, switching wallet or chain leaked stale "already
// approved" hits and produced "insufficient allowance" reverts.

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VAULT = "0xCccccccccccccccccccccccccccccccccccccccc";
const VAULT_2 = "0xDddddddddddddddddddddddddddddddddddddddd";
const ETH_SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;

beforeEach(() => {
  localStorage.clear();
  setApprovalContext(undefined, undefined);
});

describe("approval module (vault-approval cache)", () => {
  it("returns false when no context is set", () => {
    expect(isVaultApproved(VAULT)).toBe(false);
  });

  it("mark + check works for the same (sender, spender, chainId)", () => {
    setApprovalContext(ALICE, ETH_SEPOLIA);
    markVaultApproved(VAULT);
    expect(isVaultApproved(VAULT)).toBe(true);
  });

  it("does NOT carry over to a different sender (#102 fix)", () => {
    setApprovalContext(ALICE, ETH_SEPOLIA);
    markVaultApproved(VAULT);

    setApprovalContext(BOB, ETH_SEPOLIA);
    expect(isVaultApproved(VAULT)).toBe(false);
  });

  it("does NOT carry over to a different chainId (#102 fix)", () => {
    setApprovalContext(ALICE, ETH_SEPOLIA);
    markVaultApproved(VAULT);

    setApprovalContext(ALICE, BASE_SEPOLIA);
    expect(isVaultApproved(VAULT)).toBe(false);
  });

  it("does NOT carry over to a different spender", () => {
    setApprovalContext(ALICE, ETH_SEPOLIA);
    markVaultApproved(VAULT);
    expect(isVaultApproved(VAULT_2)).toBe(false);
  });

  it("normalizes sender + spender case in the key", () => {
    setApprovalContext(ALICE, ETH_SEPOLIA);
    markVaultApproved(VAULT.toUpperCase());

    // Re-set with lowercase variants — should still match
    setApprovalContext(ALICE.toLowerCase(), ETH_SEPOLIA);
    expect(isVaultApproved(VAULT.toLowerCase())).toBe(true);
  });

  it("expires after TTL (24h)", () => {
    setApprovalContext(ALICE, ETH_SEPOLIA);
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(realNow); // for the mark
    markVaultApproved(VAULT);
    expect(isVaultApproved(VAULT)).toBe(true);

    // Jump 25 hours forward.
    const twentyFiveHrs = realNow + 25 * 60 * 60 * 1000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(twentyFiveHrs);
    expect(isVaultApproved(VAULT)).toBe(false);
    spy.mockRestore();
  });

  it("clearVaultApproval removes the entry", () => {
    setApprovalContext(ALICE, ETH_SEPOLIA);
    markVaultApproved(VAULT);
    expect(isVaultApproved(VAULT)).toBe(true);
    clearVaultApproval(VAULT);
    expect(isVaultApproved(VAULT)).toBe(false);
  });

  it("returns false when localStorage is corrupted (defensive try/catch)", () => {
    setApprovalContext(ALICE, ETH_SEPOLIA);
    localStorage.setItem("blank_vault_approved_v2", "{not valid json");
    expect(isVaultApproved(VAULT)).toBe(false);
  });

  it("mark is a no-op when context is missing", () => {
    // No setApprovalContext call.
    markVaultApproved(VAULT);
    setApprovalContext(ALICE, ETH_SEPOLIA);
    expect(isVaultApproved(VAULT)).toBe(false);
  });
});
