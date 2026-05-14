import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  setApprovalContext,
  isVaultApproved,
  markVaultApproved,
  clearVaultApproval,
  verifyVaultApproved,
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

  // §15.x extension: additional sync-helper edges + verifyVaultApproved
  // async event-scan coverage (#252 cross-device approval recovery).
  // The async path is the only way for a fresh-localStorage browser
  // session to discover that the on-chain allowance is ALREADY set
  // without re-prompting the user — a regression would force a
  // double-approve flow on every fresh device.

  describe("additional sync-helper edges", () => {
    it("clearVaultApproval is a no-op when context is missing (defensive: don't crash)", () => {
      // No setApprovalContext.
      expect(() => clearVaultApproval(VAULT)).not.toThrow();
    });

    it("clearVaultApproval ONLY removes the matching (sender, spender, chainId) entry", () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      markVaultApproved(VAULT);
      markVaultApproved(VAULT_2);
      // Clear VAULT entry only.
      clearVaultApproval(VAULT);
      expect(isVaultApproved(VAULT)).toBe(false);
      expect(isVaultApproved(VAULT_2)).toBe(true);
    });

    it("mark for sender B does NOT overwrite sender A's entry (additive storage map)", () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      markVaultApproved(VAULT);
      setApprovalContext(BOB, ETH_SEPOLIA);
      markVaultApproved(VAULT);
      // Both senders' entries survive.
      setApprovalContext(ALICE, ETH_SEPOLIA);
      expect(isVaultApproved(VAULT)).toBe(true);
      setApprovalContext(BOB, ETH_SEPOLIA);
      expect(isVaultApproved(VAULT)).toBe(true);
    });

    it("isVaultApproved with a missing localStorage entry returns false (default empty map)", () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      // Nothing has been marked yet — the JSON.parse("{}") fallback
      // must yield false for any spender query.
      expect(isVaultApproved(VAULT)).toBe(false);
    });

    it("uses the v2 storage key 'blank_vault_approved_v2' (not the legacy v1 key)", () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      markVaultApproved(VAULT);
      // The v1 key MUST stay empty (the migration cleared it at module
      // load) and the v2 key is where the actual data lives.
      expect(localStorage.getItem("blank_vault_approved_v2")).toBeTruthy();
      const parsed = JSON.parse(localStorage.getItem("blank_vault_approved_v2")!);
      expect(typeof parsed).toBe("object");
    });
  });

  describe("verifyVaultApproved (#252 cross-device recovery via event scan)", () => {
    const VAULT_ADDR = VAULT as `0x${string}`;
    const ALICE_ADDR = ALICE as `0x${string}`;

    function makePublicClient(logs: unknown[] = []) {
      const getLogs = vi.fn().mockResolvedValue(logs);
      return { getLogs };
    }

    it("returns true immediately when isVaultApproved sync-cache is already set (no event scan)", async () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      markVaultApproved(VAULT);
      const client = makePublicClient([]);
      const out = await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      expect(out).toBe(true);
      // Critical: NO event scan when the sync cache hits (saves an
      // RPC round-trip on every write that gates on approval).
      expect(client.getLogs).not.toHaveBeenCalled();
    });

    it("scans on-chain events when sync-cache misses + returns true when an EncryptedApproval is found", async () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      // No markVaultApproved — sync cache is empty.
      const client = makePublicClient([
        { args: { owner: ALICE_ADDR, spender: VAULT_ADDR, timestamp: 1700000000n } },
      ]);
      const out = await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      expect(out).toBe(true);
      expect(client.getLogs).toHaveBeenCalledTimes(1);
    });

    it("marks the sync-cache when event scan succeeds (next call is sync-fast)", async () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      const client = makePublicClient([{ args: {} }]); // any non-empty array
      await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      // Second call should hit the sync cache + skip the event scan.
      client.getLogs.mockClear();
      const out = await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      expect(out).toBe(true);
      expect(client.getLogs).not.toHaveBeenCalled();
    });

    it("returns false when event scan returns an empty array (no on-chain approval found)", async () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      const client = makePublicClient([]);
      const out = await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      expect(out).toBe(false);
      // Sync cache stays unmarked.
      expect(isVaultApproved(VAULT)).toBe(false);
    });

    it("returns false when getLogs throws (RPC error gracefully degrades to 'not approved')", async () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      const getLogs = vi.fn().mockRejectedValue(new Error("RPC timeout"));
      const client = { getLogs };
      const out = await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      expect(out).toBe(false);
    });

    it("queries getLogs with the correct address + EncryptedApproval event + (owner, spender) args", async () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      const client = makePublicClient([]);
      await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      expect(client.getLogs).toHaveBeenCalledTimes(1);
      const args = client.getLogs.mock.calls[0]![0]!;
      expect(args.address).toBe(VAULT_ADDR);
      expect(args.event.name).toBe("EncryptedApproval");
      expect(args.args).toEqual({ owner: ALICE_ADDR, spender: VAULT_ADDR });
      // Scans full history (fromBlock=earliest) so a user who approved
      // years ago on a different device is still recognized.
      expect(args.fromBlock).toBe("earliest");
      expect(args.toBlock).toBe("latest");
    });

    it("the cached mark from event-scan survives across calls (same sender, same chain)", async () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      const client = makePublicClient([{ args: {} }]);
      await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      // The sync isVaultApproved now reports true (markVaultApproved
      // was called inside verifyVaultApproved on the match path).
      expect(isVaultApproved(VAULT)).toBe(true);
    });

    it("event-scan match does NOT mark approval for a DIFFERENT chain (chainId is part of the cache key)", async () => {
      setApprovalContext(ALICE, ETH_SEPOLIA);
      const client = makePublicClient([{ args: {} }]);
      await verifyVaultApproved(VAULT_ADDR, ALICE_ADDR, VAULT_ADDR, client);
      // Switch chain — the eth-sepolia mark must NOT carry over.
      setApprovalContext(ALICE, BASE_SEPOLIA);
      expect(isVaultApproved(VAULT)).toBe(false);
    });
  });
});
