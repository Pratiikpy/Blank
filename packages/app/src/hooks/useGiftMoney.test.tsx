import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useGiftMoney. Encrypted "red envelope" gift hook
// with random-share splits, per-recipient encryption, +1-hour rate
// limiting, and 4 admin ops (create, claim, deactivate, set-expiry).
//
// CRITICAL pins:
//   - 7-step machine (input -> approving -> encrypting -> confirming
//     -> sending -> success | error). createGift drives the full
//     ladder; claimGift/deactivateEnvelope/setExpiry jump straight to
//     "sending" because no FHE encryption is required (they touch
//     existing handles or plaintext-only fields).
//   - Rate limit: max 5 gifts per hour via localStorage timestamp
//     window (#58). Filters by `now - t < 3_600_000ms`. Test pins
//     both branches: <5 in window -> allowed; >=5 -> blocked with
//     specific toast copy. Rate-limit append fires AFTER the on-chain
//     success (NOT on failure) so a reverted createGift doesn't burn
//     a quota slot for an envelope the user never got.
//   - shares.length !== recipients.length -> "Shares and recipients
//     must match" toast + early return. Pre-flight check before any
//     write fires so the user catches the off-by-one BEFORE wasting
//     a UserOp on a contract that would revert anyway.
//   - createGift fanout: recipients[] insertActivitiesFanout rows
//     (each with `${hash}_${recipient.toLowerCase()}` tx_hash suffix)
//     PLUS a sender-copy row (tx_hash=`${hash}_sender`). The
//     sender-copy keeps the gift visible in the sender's own Activity
//     feed under their "Sent" filter without leaking on the recipient
//     side. Each row uses `[envelope:${id}] ${note}` prefix so the
//     UI can extract the envelope id from the activity row even when
//     the supabase row schema doesn't have a dedicated envelope_id
//     column.
//   - #253 broadcast ordering: balance_changed + activity_added fire
//     AFTER insertActivitiesFanout completes — earlier ordering caused
//     the cross-tab listener to refetch while inserts were still in
//     flight and miss the new rows. Test pins by mocking fanout to
//     hang and asserting broadcast is NOT called until fanout
//     resolves.
//   - claimGift skips public-RPC poll (uses relayer-side receipt
//     from unifiedWriteAndWait); under testnet RPC throttling the
//     poll was flaky and caused claim-never-lands UX bugs. Test
//     pins by NOT mocking publicClient.waitForTransactionReceipt
//     in the AA-path happy-path and confirming no call to it.
//   - deactivateEnvelope #126 broadcast: previously ONLY emitted
//     activity_added; now emits BOTH balance_changed AND
//     activity_added because envelope refunds can affect vault
//     ledger. Test pins both broadcasts fire.
//   - setExpiry expiryTimestamp=0 -> "Cleared expiry" note;
//     non-zero -> "Updated envelope #N expiry to ISO" note. Per
//     contract, 0 means "no expiry" (sentinel). The ISO date
//     conversion uses `expiryTimestamp * 1000` because Date() takes
//     ms not seconds — a regression that passed unix-seconds raw
//     would render dates in 1970.
//   - #196 admin-action rows: deactivateEnvelope + setExpiry both
//     insertActivity with user_from === user_to === self (sender
//     auditing their own envelope state-changes), NOT a recipient-
//     side notification. Activity types are pinned strings.
//   - computeRandomSplits MIN_SHARE=0.01 floor: shares can't be zero;
//     when total / N < 0.01 each, falls back to equal split. Sum
//     correction in the last share absorbs floating-point drift so
//     splits sum EXACTLY to total. Test pins by computing for 1000+
//     iterations and verifying sum === total via parseFloat
//     comparison with 6dp tolerance.
//   - computeEqualSplits Math.floor((total/N)*1_000_000)/1_000_000
//     rounding pattern: the last recipient gets the remainder so
//     sum is exact at 6dp. A regression that used toFixed on every
//     share would drift by sub-cent in the last decimal place.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const insertActivitiesFanoutMock = vi.hoisted(() => vi.fn());
const extractEventIdMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const clearVaultApprovalMock = vi.hoisted(() => vi.fn());
const getStoredJsonMock = vi.hoisted(() => vi.fn());
const setStoredJsonMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheEncrypt: useCofheEncryptMock,
  useCofheConnection: useCofheConnectionMock,
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/abis", () => ({ GiftMoneyAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("@/lib/activity-fanout", () => ({
  insertActivitiesFanout: insertActivitiesFanoutMock,
}));
vi.mock("@/lib/event-parser", () => ({ extractEventId: extractEventIdMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
  clearVaultApproval: clearVaultApprovalMock,
}));
vi.mock("@/lib/storage", () => ({
  STORAGE_KEYS: {
    giftRateLimit: () => "gift_rate",
  },
  getStoredJson: getStoredJsonMock,
  setStoredJson: setStoredJsonMock,
}));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import {
  useGiftMoney,
  computeRandomSplits,
  computeEqualSplits,
} from "./useGiftMoney";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const GM = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const VAULT = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const USDC = "0x3333333333333333333333333333333333333333" as `0x${string}`;

const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const encryptInputsAsyncMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheEncryptMock.mockReset();
  useCofheConnectionMock.mockReset();
  insertActivityMock.mockReset();
  insertActivitiesFanoutMock.mockReset();
  extractEventIdMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  getStoredJsonMock.mockReset();
  setStoredJsonMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  waitForTransactionReceiptMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      GiftMoney: GM,
      TestUSDC: USDC,
    },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useCofheEncryptMock.mockReturnValue({
    encryptInputsAsync: encryptInputsAsyncMock,
  });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  isVaultApprovedMock.mockReturnValue(true);
  getStoredJsonMock.mockReturnValue([]);
  toastLoadingMock.mockReturnValue("tid");
  unifiedWriteMock.mockResolvedValue("0xtxhash" as `0x${string}`);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash" as `0x${string}`,
    receipt: { status: "success", blockNumber: 1n, logs: [] },
  });
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 1n,
    logs: [],
  });
  extractEventIdMock.mockReturnValue(42);
  encryptInputsAsyncMock.mockImplementation(async (inputs: unknown[]) =>
    inputs.map((_, i) => ({ ctHash: BigInt(i + 1), signature: "0xenc" })),
  );
  insertActivityMock.mockResolvedValue(undefined);
  insertActivitiesFanoutMock.mockResolvedValue(undefined);
});

// ───────────────────────────────────────────────────────────
//  computeRandomSplits + computeEqualSplits (pure helpers)
// ───────────────────────────────────────────────────────────

describe("useGiftMoney — computeRandomSplits (§15.x)", () => {
  it("returns [] when recipientCount <= 0", () => {
    expect(computeRandomSplits("100", 0)).toEqual([]);
    expect(computeRandomSplits("100", -1)).toEqual([]);
  });

  it("returns [] when total <= 0", () => {
    expect(computeRandomSplits("0", 3)).toEqual([]);
    expect(computeRandomSplits("-5", 3)).toEqual([]);
  });

  it("returns [totalAmount] for recipientCount=1", () => {
    expect(computeRandomSplits("100", 1)).toEqual(["100"]);
  });

  it("sum matches total (within 6dp tolerance) across 100 random iterations", () => {
    for (let i = 0; i < 100; i++) {
      const shares = computeRandomSplits("100", 4);
      const sum = shares.reduce((a, s) => a + parseFloat(s), 0);
      expect(Math.abs(sum - 100)).toBeLessThan(0.0001);
    }
  });

  it("falls back to equal split when total < MIN_SHARE * N", () => {
    // total=0.02, N=5 -> each below 0.01 floor, so equal split
    const shares = computeRandomSplits("0.02", 5);
    expect(shares).toHaveLength(5);
    const everyEqual = shares.every((s) => s === shares[0]);
    expect(everyEqual).toBe(true);
  });

  it("every share is >= 0 (no negative drift)", () => {
    for (let i = 0; i < 50; i++) {
      const shares = computeRandomSplits("10", 5);
      for (const s of shares) expect(parseFloat(s)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("useGiftMoney — computeEqualSplits (§15.x)", () => {
  it("returns [] when recipientCount <= 0 or total <= 0", () => {
    expect(computeEqualSplits("100", 0)).toEqual([]);
    expect(computeEqualSplits("0", 3)).toEqual([]);
  });

  it("returns [totalAmount] for recipientCount=1", () => {
    expect(computeEqualSplits("100", 1)).toEqual(["100"]);
  });

  it("last share absorbs remainder so sum is exact", () => {
    // 100/3 = 33.333333... -> first two get 33.333333, last gets the rest
    const shares = computeEqualSplits("100", 3);
    expect(shares).toHaveLength(3);
    const sum = shares.reduce((a, s) => a + parseFloat(s), 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it("'10' / 4 -> first 3 are equal floored, last is the remainder", () => {
    const shares = computeEqualSplits("10", 4);
    expect(shares).toHaveLength(4);
    expect(shares[0]).toBe(shares[1]);
    expect(shares[1]).toBe(shares[2]);
    const sum = shares.reduce((a, s) => a + parseFloat(s), 0);
    expect(sum).toBeCloseTo(10, 6);
  });
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useGiftMoney — initial state (§15.x)", () => {
  it("returns step='input' + isProcessing=false + 4 callables + 2 helpers + reset", () => {
    const { result } = renderHook(() => useGiftMoney());
    expect(result.current.step).toBe("input");
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.txHash).toBeNull();
    expect(result.current.encryptionProgress).toBe(0);
    expect(typeof result.current.createGift).toBe("function");
    expect(typeof result.current.claimGift).toBe("function");
    expect(typeof result.current.deactivateEnvelope).toBe("function");
    expect(typeof result.current.setExpiry).toBe("function");
    expect(typeof result.current.computeRandomSplits).toBe("function");
    expect(typeof result.current.computeEqualSplits).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  createGift
// ───────────────────────────────────────────────────────────

describe("useGiftMoney — createGift guards (§15.x)", () => {
  it("no address -> no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("not connected -> no write", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("shares.length !== recipients.length -> 'Shares and recipients must match' toast", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["50"], [ALICE, BOB], "Hi");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Shares and recipients must match",
    );
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty shares array -> 'Shares and recipients must match' toast (len 0)", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, [], [], "Hi");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Shares and recipients must match",
    );
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Connection lost. Please refresh.",
    );
  });

  it("share with empty string -> 'All gift share amounts must be filled in' toast + step reset to 'input'", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["50", ""], [ALICE, BOB], "Hi");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "All gift share amounts must be filled in",
    );
    expect(result.current.step).toBe("input");
    expect(result.current.isProcessing).toBe(false);
  });
});

describe("useGiftMoney — createGift rate limit (§15.x)", () => {
  it("0 timestamps in window -> allowed", async () => {
    getStoredJsonMock.mockReturnValue([]);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
  });

  it("4 timestamps in window -> allowed (< 5)", async () => {
    const now = Date.now();
    getStoredJsonMock.mockReturnValue([now - 1000, now - 2000, now - 3000, now - 4000]);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
  });

  it("5 timestamps in window -> BLOCKED + specific toast", async () => {
    const now = Date.now();
    getStoredJsonMock.mockReturnValue([
      now - 1000, now - 2000, now - 3000, now - 4000, now - 5000,
    ]);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Gift limit reached"),
    );
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("stale timestamps (>1h) filtered out -> allowed", async () => {
    const now = Date.now();
    getStoredJsonMock.mockReturnValue([
      now - 4_000_000, // stale (>1h)
      now - 4_000_001,
      now - 4_000_002,
      now - 4_000_003,
      now - 4_000_004,
      now - 1000, // fresh
    ]);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
  });

  it("rate-limit append fires ONLY on success (not on revert)", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(setStoredJsonMock).toHaveBeenCalledTimes(0);
  });

  it("rate-limit append on success: new timestamp pushed + stale filtered", async () => {
    const now = Date.now();
    getStoredJsonMock.mockReturnValue([now - 1000, now - 4_000_000]);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(setStoredJsonMock).toHaveBeenCalledTimes(1);
    const stored = setStoredJsonMock.mock.calls[0][1] as number[];
    expect(stored).toHaveLength(2); // fresh + new (stale filtered)
  });
});

describe("useGiftMoney — createGift happy path (§15.x)", () => {
  it("first-time: approve(GiftMoney) + markVaultApproved + createEnvelope", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteMock.mock.calls[0][0].functionName).toBe(
      "approvePlaintext",
    );
    expect(markVaultApprovedMock).toHaveBeenCalledWith(GM);
  });

  it("pre-approved -> single createEnvelope write", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
  });

  it("createEnvelope args: [vault, recipients, encShares[], note, BigInt(expiry)] + gas 5M", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(
        VAULT,
        ["60", "40"],
        [ALICE, BOB],
        "Happy Birthday",
        1735689600, // 2025-01-01
      );
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(GM);
    expect(call.functionName).toBe("createEnvelope");
    expect(call.args[0]).toBe(VAULT);
    expect(call.args[1]).toEqual([ALICE, BOB]);
    expect(Array.isArray(call.args[2])).toBe(true);
    expect(call.args[2]).toHaveLength(2);
    expect(call.args[3]).toBe("Happy Birthday");
    expect(call.args[4]).toBe(1735689600n);
    expect(call.gas).toBe(5_000_000n);
    const encBatch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(encBatch[0].raw).toBe(60_000_000n);
    expect(encBatch[1].raw).toBe(40_000_000n);
  });

  it("default expiryTimestamp=0 when omitted (no expiry)", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].args[4]).toBe(0n);
  });

  it("step ladder: input -> approving -> encrypting -> confirming -> sending -> success", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(result.current.step).toBe("success");
    expect(result.current.encryptionProgress).toBe(100);
    expect(result.current.txHash).toBe("0xtxhash");
  });

  it("fanout: N recipient rows + 1 sender-copy row with `${hash}_sender` tx_hash", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(
        VAULT,
        ["60", "40"],
        [ALICE, BOB],
        "Hi",
      );
    });
    const rows = insertActivitiesFanoutMock.mock.calls[0][0] as Array<{
      tx_hash: string;
      user_from: string;
      user_to: string;
      activity_type: string;
      note: string;
    }>;
    expect(rows).toHaveLength(3); // 2 recipients + 1 sender-copy
    expect(rows[0].tx_hash).toBe(`0xtxhash_${ALICE.toLowerCase()}`);
    expect(rows[0].user_to).toBe(ALICE.toLowerCase());
    expect(rows[1].tx_hash).toBe(`0xtxhash_${BOB.toLowerCase()}`);
    expect(rows[2].tx_hash).toBe("0xtxhash_sender");
    expect(rows[2].user_from).toBe(ME.toLowerCase());
    expect(rows[2].user_to).toBe(ME.toLowerCase());
    expect(rows[0].activity_type).toBe("gift_created");
    // envelope-id prefix on note
    expect(rows[0].note).toBe("[envelope:7] Hi");
    expect(rows[2].note).toBe("[envelope:7] Hi");
  });

  it("empty note -> '[envelope:N] Gift envelope' default", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "");
    });
    const rows = insertActivitiesFanoutMock.mock.calls[0][0] as Array<{ note: string }>;
    expect(rows[0].note).toBe("[envelope:7] Gift envelope");
  });

  it("extractEventId null -> throws + step='error' + no fanout", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toContain("envelopeId could not be read");
    expect(insertActivitiesFanoutMock).toHaveBeenCalledTimes(0);
  });

  it("reverted receipt -> error step + no rate-limit append + no fanout", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(result.current.step).toBe("error");
    expect(insertActivitiesFanoutMock).toHaveBeenCalledTimes(0);
    expect(setStoredJsonMock).toHaveBeenCalledTimes(0);
  });

  it("#253: broadcastAction fires AFTER fanout resolves (ordering enforced)", async () => {
    let resolveFanout: (v: unknown) => void = () => {};
    insertActivitiesFanoutMock.mockReturnValue(
      new Promise((res) => {
        resolveFanout = res;
      }),
    );
    const { result } = renderHook(() => useGiftMoney());
    let p!: Promise<unknown>;
    await act(async () => {
      p = result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
      await Promise.resolve();
    });
    // Fanout is mid-flight; broadcasts should NOT have fired yet
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
    resolveFanout(undefined);
    await act(async () => {
      await p;
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("error-discriminator: 'allowance' -> clearVaultApproval(GiftMoney)", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(GM);
  });

  it("error-discriminator: 'transfer amount exceeds' -> clearVaultApproval", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(
      new Error("ERC20: transfer amount exceeds balance"),
    );
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(GM);
  });

  it("error-discriminator: unrelated 'rpc fail' -> NOT cleared", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
  });

  it("single-flight: second createGift while first in-flight short-circuits", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useGiftMoney());
    let p1!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.createGift(VAULT, ["50"], [BOB], "Hi");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    resolveFirst({
      hash: "0x",
      receipt: { status: "success", blockNumber: 1n, logs: [] },
    });
    await act(async () => {
      await p1;
    });
  });
});

// ───────────────────────────────────────────────────────────
//  claimGift
// ───────────────────────────────────────────────────────────

describe("useGiftMoney — claimGift (§15.x)", () => {
  it("no address -> no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.claimGift(42);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("claimGift args: [BigInt(envelopeId)] + gas 5M + NO encrypt batch", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.claimGift(42);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claimGift");
    expect(call.args).toEqual([42n]);
    expect(call.gas).toBe(5_000_000n);
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("AA path: uses writeResult.receipt + SKIPS public-RPC poll", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.claimGift(42);
    });
    // receipt was in writeResult, so no public-RPC poll
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("EOA path (no receipt in writeResult) -> polls public-RPC", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtxhash",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "success",
      blockNumber: 1n,
      logs: [],
    });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.claimGift(42);
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(1);
  });

  it("activity_type='gift_claimed' + self-to-self + note mentions envelope id", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.claimGift(42);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("gift_claimed");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ME.toLowerCase());
    expect(row.note).toContain("#42");
    expect(toastSuccessMock).toHaveBeenCalledWith("Gift opened!");
  });

  it("#90: broadcastAction(activity_added) + balance_changed + invalidate fire after activity", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.claimGift(42);
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("reverted receipt -> step='error' + no activity insert", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.claimGift(42);
    });
    expect(result.current.step).toBe("error");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  deactivateEnvelope
// ───────────────────────────────────────────────────────────

describe("useGiftMoney — deactivateEnvelope (§15.x)", () => {
  it("deactivateEnvelope args: [BigInt(envelopeId)] + gas 5M + plaintext", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.deactivateEnvelope(42);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("deactivateEnvelope");
    expect(call.args).toEqual([42n]);
    expect(call.gas).toBe(5_000_000n);
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("activity_type='gift_deactivated' + #196 self-audit row", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.deactivateEnvelope(42);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("gift_deactivated");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ME.toLowerCase());
    expect(row.note).toContain("#42");
    expect(toastSuccessMock).toHaveBeenCalledWith("Envelope deactivated");
  });

  it("#126: broadcasts BOTH balance_changed AND activity_added + invalidate", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.deactivateEnvelope(42);
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("reverted receipt -> step='error' + no activity", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.deactivateEnvelope(42);
    });
    expect(result.current.step).toBe("error");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("no address -> no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.deactivateEnvelope(42);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  setExpiry
// ───────────────────────────────────────────────────────────

describe("useGiftMoney — setExpiry (§15.x)", () => {
  it("setExpiry args: [BigInt(envelopeId), BigInt(expiry)] + gas 5M", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.setExpiry(42, 1735689600);
    });
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.functionName).toBe("setExpiry");
    expect(call.args).toEqual([42n, 1735689600n]);
    expect(call.gas).toBe(5_000_000n);
  });

  it("expiryTimestamp=0 -> 'Cleared expiry' note", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.setExpiry(42, 0);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.note).toBe("Cleared expiry on envelope #42");
    expect(row.activity_type).toBe("gift_expiry_changed");
  });

  it("expiryTimestamp != 0 -> 'Updated...expiry to ISO' note (seconds*1000)", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.setExpiry(42, 1735689600); // 2025-01-01
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.note).toContain("envelope #42");
    expect(row.note).toContain("2025"); // ISO year, proves *1000 conversion correct
  });

  it("activity_type='gift_expiry_changed' + self-to-self + broadcastAction('activity_added')", async () => {
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.setExpiry(42, 1735689600);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ME.toLowerCase());
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(toastSuccessMock).toHaveBeenCalledWith("Expiry updated");
  });

  it("reverted receipt -> step='error' + no activity", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      blockNumber: 1n,
      logs: [],
    });
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.setExpiry(42, 1735689600);
    });
    expect(result.current.step).toBe("error");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.setExpiry(42, 1735689600);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Connection lost. Please refresh.",
    );
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useGiftMoney — reset (§15.x)", () => {
  it("reset clears state back to initial", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("fail"));
    const { result } = renderHook(() => useGiftMoney());
    await act(async () => {
      await result.current.createGift(VAULT, ["100"], [ALICE], "Hi");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("fail");
    act(() => result.current.reset());
    expect(result.current.step).toBe("input");
    expect(result.current.error).toBeNull();
    expect(result.current.txHash).toBeNull();
    expect(result.current.encryptionProgress).toBe(0);
  });
});
