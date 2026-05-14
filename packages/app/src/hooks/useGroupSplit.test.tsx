import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useGroupSplit. Group-expense split tracker with
// encrypted per-member shares + encrypted settle-debt transfers.
// Surfaces: computeEqualSplit (pure math), createGroup (plaintext
// roster sync), addExpense (encrypted per-member shares + total),
// settleDebt (encrypted vault transfer + actual-vs-requested
// decrypt-for-view), voteOnExpense (encrypted vote weight),
// leaveGroup (plaintext, self-removal), archiveGroup (plaintext,
// admin-only).
//
// CRITICAL pins:
//   - computeEqualSplit returns toFixed(6) string (the vault's USDC
//     precision); test confirms 100/3 -> "33.333333" not the truncated
//     "33.33" or full-precision "33.33333333333333".
//   - createGroup roster sync: insertGroupMembership called ONCE per
//     unique member with `is_admin = (member === address)` for the
//     caller and false for the rest; the dedup is `members.filter(m =>
//     m !== address)` so passing the caller's own address in `members`
//     doesn't insert two membership rows; case-SENSITIVE comparison
//     (caller-passed address must match effectiveAddress exactly) is
//     intentional because the on-chain createGroup uses === too.
//   - createGroup extractEventId null -> throws "groupId could not be
//     read" rather than inserting at id=0 (§1.7 audit fix).
//   - addExpense TWO encrypt batches in sequence: first batch encrypts
//     all N member shares (one call with N inputs), second batch
//     encrypts the total (one call with 1 input); test pins the call
//     ORDER + the input shape because a regression that interleaved
//     them or merged into one call would change the handle ordering
//     and the contract would charge the wrong member.
//   - addExpense per-member fanout activity with tx_hash suffix
//     `_${member.toLowerCase()}` for dedup-key uniqueness; without
//     the suffix, the supabase upsert constraint on tx_hash would
//     collapse all N rows to one; the lowercase normalization is
//     deliberate so that callers passing checksummed addresses don't
//     cause case-flapping in the dedup key.
//   - addExpense + settleDebt approval cache: isVaultApproved(
//     GroupManager) shortcuts approve; cleared on /allowance|approve|
//     insufficient|transfer amount exceeds/ errors (external-revoke
//     recovery); unrelated errors (rpc timeout) leave cache armed.
//   - settleDebt 3-branch toast based on decrypted ACTUAL transferred
//     amount from DebtSettledEncrypted event: actual === requested ->
//     "Debt settled in full"; actual < requested -> red toast with
//     shortfall amount + 8s duration (vault underfunded, on-chain
//     accounting is still correct because the contract uses actual);
//     decrypt fail OR no handle -> generic "Debt settled!" success
//     (on-chain accounting still correct, user just won't see partial
//     warning). The third branch is fail-soft because decryptForView
//     may legitimately not be ready (cofhe handshake) and we don't
//     want the success toast to disappear over that.
//   - settleDebt voteOnExpense leaveGroup archiveGroup activity_type
//     strings are pinned in the test: "debt_settled" / "group_vote"
//     / "group_left" / "group_archived" — supabase realtime
//     filters on these strings; renaming would silently break the
//     Activity feed.
//   - Single-flight via submittingRef (ref-based, NOT state) so a
//     re-render between submit + ref-flip doesn't open a race; test
//     pins by hanging first call, firing second, asserting only ONE
//     unifiedWriteAndWait fired.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheDecryptForViewMock = vi.hoisted(() => vi.fn());
const insertGroupExpenseMock = vi.hoisted(() => vi.fn());
const insertGroupMembershipMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const insertActivitiesFanoutMock = vi.hoisted(() => vi.fn());
const extractEventIdMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const clearVaultApprovalMock = vi.hoisted(() => vi.fn());
const decodeEventLogMock = vi.hoisted(() => vi.fn());
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
  useCofheDecryptForView: useCofheDecryptForViewMock,
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/abis", () => ({ GroupManagerAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/supabase", () => ({
  insertGroupExpense: insertGroupExpenseMock,
  insertGroupMembership: insertGroupMembershipMock,
  insertActivity: insertActivityMock,
}));
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
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    decodeEventLog: decodeEventLogMock,
  };
});
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useGroupSplit } from "./useGroupSplit";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const GM = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const VAULT_USDC = "0x2222222222222222222222222222222222222222" as `0x${string}`;

const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const encryptInputsAsyncMock = vi.fn();
const decryptForViewMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheEncryptMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheDecryptForViewMock.mockReset();
  insertGroupExpenseMock.mockReset();
  insertGroupMembershipMock.mockReset();
  insertActivityMock.mockReset();
  insertActivitiesFanoutMock.mockReset();
  extractEventIdMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  decodeEventLogMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  decryptForViewMock.mockReset();
  waitForTransactionReceiptMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      GroupManager: GM,
      FHERC20Vault_USDC: VAULT_USDC,
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
  useCofheDecryptForViewMock.mockReturnValue({ decryptForView: decryptForViewMock });
  isVaultApprovedMock.mockReturnValue(true);
  toastLoadingMock.mockReturnValue("tid");
  unifiedWriteMock.mockResolvedValue("0xapprove" as `0x${string}`);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash" as `0x${string}`,
    receipt: { status: "success", blockNumber: 1n, logs: [] },
  });
  extractEventIdMock.mockReturnValue(42);
  encryptInputsAsyncMock.mockImplementation(async (inputs: unknown[]) =>
    inputs.map((_, i) => ({ ctHash: BigInt(i + 1), signature: "0xenc" })),
  );
  insertGroupMembershipMock.mockResolvedValue(undefined);
  insertGroupExpenseMock.mockResolvedValue(undefined);
  insertActivityMock.mockResolvedValue(undefined);
  insertActivitiesFanoutMock.mockResolvedValue(undefined);
});

// ───────────────────────────────────────────────────────────
//  Initial state + computeEqualSplit
// ───────────────────────────────────────────────────────────

describe("useGroupSplit — initial state + math (§15.x)", () => {
  it("returns isProcessing=false + 7 callables", () => {
    const { result } = renderHook(() => useGroupSplit());
    expect(result.current.isProcessing).toBe(false);
    expect(typeof result.current.computeEqualSplit).toBe("function");
    expect(typeof result.current.createGroup).toBe("function");
    expect(typeof result.current.addExpense).toBe("function");
    expect(typeof result.current.settleDebt).toBe("function");
    expect(typeof result.current.voteOnExpense).toBe("function");
    expect(typeof result.current.leaveGroup).toBe("function");
    expect(typeof result.current.archiveGroup).toBe("function");
  });

  it("computeEqualSplit '100' / 3 -> '33.333333' (6dp)", () => {
    const { result } = renderHook(() => useGroupSplit());
    expect(result.current.computeEqualSplit("100", 3)).toBe("33.333333");
  });

  it("computeEqualSplit '10' / 4 -> '2.500000' (trailing zeros preserved)", () => {
    const { result } = renderHook(() => useGroupSplit());
    expect(result.current.computeEqualSplit("10", 4)).toBe("2.500000");
  });

  it("computeEqualSplit '5' / 2 -> '2.500000'", () => {
    const { result } = renderHook(() => useGroupSplit());
    expect(result.current.computeEqualSplit("5", 2)).toBe("2.500000");
  });
});

// ───────────────────────────────────────────────────────────
//  createGroup
// ───────────────────────────────────────────────────────────

describe("useGroupSplit — createGroup (§15.x)", () => {
  it("no address -> early return, no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("Trip", [ALICE]);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("not connected (cofhe handshake pending) -> early return", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("Trip", [ALICE]);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> 'Connection lost' toast + no write", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("Trip", [ALICE]);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: createGroup args (name, members) + gas 5M + extractEventId + memberships", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("Roadtrip", [ALICE, BOB]);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(GM);
    expect(call.functionName).toBe("createGroup");
    expect(call.args[0]).toBe("Roadtrip");
    expect(call.args[1]).toEqual([ALICE, BOB]);
    expect(call.gas).toBe(5_000_000n);
    expect(insertGroupMembershipMock).toHaveBeenCalledTimes(3);
    expect(toastSuccessMock).toHaveBeenCalledWith("Group created!");
  });

  it("inserts self as admin + others as non-admin", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("Roadtrip", [ALICE, BOB]);
    });
    const adminRow = insertGroupMembershipMock.mock.calls.find(
      (c) => c[0].member_address === ME,
    );
    expect(adminRow?.[0].is_admin).toBe(true);
    const aliceRow = insertGroupMembershipMock.mock.calls.find(
      (c) => c[0].member_address === ALICE,
    );
    expect(aliceRow?.[0].is_admin).toBe(false);
  });

  it("dedups self when caller is in `members` (no double-insert)", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("Roadtrip", [ME, ALICE]);
    });
    expect(insertGroupMembershipMock).toHaveBeenCalledTimes(2);
    const selfRows = insertGroupMembershipMock.mock.calls.filter(
      (c) => c[0].member_address === ME,
    );
    expect(selfRows).toHaveLength(1);
    expect(selfRows[0][0].is_admin).toBe(true);
  });

  it("extractEventId null -> error toast + no memberships", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("Trip", [ALICE]);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("groupId could not be read"),
    );
    expect(insertGroupMembershipMock).toHaveBeenCalledTimes(0);
  });

  it("reverted receipt -> error toast + no memberships", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("Trip", [ALICE]);
    });
    expect(toastErrorMock).toHaveBeenCalled();
    expect(insertGroupMembershipMock).toHaveBeenCalledTimes(0);
  });

  it("returns the tx hash on success", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useGroupSplit());
    let h: unknown;
    await act(async () => {
      h = await result.current.createGroup("Trip", [ALICE]);
    });
    expect(h).toBe("0xtxhash");
  });

  it("single-flight: second createGroup while first in-flight short-circuits", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useGroupSplit());
    let p1!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.createGroup("A", [ALICE]);
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.createGroup("B", [BOB]);
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
//  addExpense
// ───────────────────────────────────────────────────────────

describe("useGroupSplit — addExpense (§15.x)", () => {
  it("no address -> no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE, BOB], ["50", "50"], "Lunch");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty shares array -> no write", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [], [], "Lunch");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("share with empty string -> 'All share amounts must be filled in' toast", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE, BOB], ["50", ""], "Lunch");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "All share amounts must be filled in",
    );
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty totalAmount -> 'Enter a total amount' toast", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "", [ALICE], ["100"], "Lunch");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a total amount");
  });

  it("first-time: approve + markVaultApproved(GroupManager) + addExpense", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE, BOB], ["50", "50"], "Lunch");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteMock.mock.calls[0][0].functionName).toBe(
      "approvePlaintext",
    );
    expect(unifiedWriteMock.mock.calls[0][0].address).toBe(VAULT_USDC);
    expect(markVaultApprovedMock).toHaveBeenCalledWith(GM);
  });

  it("pre-approved -> single addExpense write, no approve", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE, BOB], ["50", "50"], "Lunch");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
  });

  it("TWO encrypt calls in order: shares batch (N inputs) THEN total batch (1 input)", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE, BOB], ["60", "40"], "Lunch");
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(2);
    const firstBatch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    const secondBatch = encryptInputsAsyncMock.mock.calls[1][0] as Array<{ raw: bigint }>;
    expect(firstBatch).toHaveLength(2);
    expect(firstBatch[0].raw).toBe(60_000_000n);
    expect(firstBatch[1].raw).toBe(40_000_000n);
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].raw).toBe(100_000_000n);
  });

  it("addExpense args: [BigInt(groupId), members, encShares[], encTotal, description] + gas 5M", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(7, "100", [ALICE, BOB], ["60", "40"], "Lunch");
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("addExpense");
    expect(call.address).toBe(GM);
    expect(call.args[0]).toBe(7n);
    expect(call.args[1]).toEqual([ALICE, BOB]);
    expect(Array.isArray(call.args[2])).toBe(true);
    expect(call.args[2]).toHaveLength(2);
    expect(call.args[4]).toBe("Lunch");
    expect(call.gas).toBe(5_000_000n);
  });

  it("happy path: insertGroupExpense + fanout activities + broadcastAction TWICE + invalidate", async () => {
    extractEventIdMock.mockReturnValue(99);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE, BOB], ["50", "50"], "Lunch");
    });
    expect(insertGroupExpenseMock).toHaveBeenCalledTimes(1);
    expect(insertGroupExpenseMock.mock.calls[0][0]).toMatchObject({
      group_id: 1,
      expense_id: 99,
      payer_address: ME,
      description: "Lunch",
      member_count: 2,
      tx_hash: "0xtxhash",
    });
    expect(insertActivitiesFanoutMock).toHaveBeenCalledTimes(1);
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith("Expense added!");
  });

  it("fanout rows: per-member tx_hash suffix `_${member}` (lowercase) for dedup-key uniqueness", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE, BOB], ["50", "50"], "Lunch");
    });
    const rows = insertActivitiesFanoutMock.mock.calls[0][0] as Array<{
      tx_hash: string;
      user_to: string;
      activity_type: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].tx_hash).toBe(`0xtxhash_${ALICE.toLowerCase()}`);
    expect(rows[1].tx_hash).toBe(`0xtxhash_${BOB.toLowerCase()}`);
    expect(rows[0].user_to).toBe(ALICE.toLowerCase());
    expect(rows[1].user_to).toBe(BOB.toLowerCase());
    expect(rows[0].activity_type).toBe("group_expense");
  });

  it("extractEventId null -> error + no supabase write", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE], ["100"], "Lunch");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("expenseId could not be read"),
    );
    expect(insertGroupExpenseMock).toHaveBeenCalledTimes(0);
  });

  it("reverted receipt -> error + no supabase write", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE], ["100"], "Lunch");
    });
    expect(insertGroupExpenseMock).toHaveBeenCalledTimes(0);
  });

  it("error-discriminator: 'allowance' -> clearVaultApproval(GroupManager)", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE], ["100"], "Lunch");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(GM);
  });

  it("error-discriminator: 'transfer amount exceeds' -> clearVaultApproval", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(
      new Error("ERC20: transfer amount exceeds balance"),
    );
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE], ["100"], "Lunch");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(GM);
  });

  it("error-discriminator: unrelated 'rpc fail' -> NOT cleared", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.addExpense(1, "100", [ALICE], ["100"], "Lunch");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  settleDebt
// ───────────────────────────────────────────────────────────

describe("useGroupSplit — settleDebt (§15.x)", () => {
  beforeEach(() => {
    isVaultApprovedMock.mockReturnValue(true);
  });

  it("no address -> no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "25");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty amount -> 'Enter an amount' toast + no write", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("settleDebt args: [BigInt(groupId), withAddress, vaultUSDC, encAmount] + gas 5M", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(7, ALICE, "25");
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("settleDebt");
    expect(call.address).toBe(GM);
    expect(call.args[0]).toBe(7n);
    expect(call.args[1]).toBe(ALICE);
    expect(call.args[2]).toBe(VAULT_USDC);
    expect(call.gas).toBe(5_000_000n);
    const encBatch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(encBatch[0].raw).toBe(25_000_000n);
  });

  it("3-branch toast: decrypted === amountWei -> 'Debt settled in full ($25)'", async () => {
    decodeEventLogMock.mockReturnValue({
      eventName: "DebtSettledEncrypted",
      args: { encryptedActual: "0xabc" },
    });
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtxhash",
      receipt: {
        status: "success",
        blockNumber: 1n,
        logs: [{ address: GM, data: "0x", topics: [] }],
      },
    });
    decryptForViewMock.mockResolvedValue(25_000_000n);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "25");
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Debt settled in full ($25)");
  });

  it("3-branch toast: decrypted < amountWei -> red toast with shortfall + 8s duration", async () => {
    decodeEventLogMock.mockReturnValue({
      eventName: "DebtSettledEncrypted",
      args: { encryptedActual: "0xabc" },
    });
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtxhash",
      receipt: {
        status: "success",
        blockNumber: 1n,
        logs: [{ address: GM, data: "0x", topics: [] }],
      },
    });
    decryptForViewMock.mockResolvedValue(10_000_000n); // tried 25, got 10
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "25");
    });
    const errCall = toastErrorMock.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("Settled $10") &&
        c[0].includes("Remaining unsettled: $15"),
    );
    expect(errCall).toBeDefined();
    expect(errCall?.[1]).toMatchObject({ duration: 8000 });
  });

  it("3-branch toast: decrypted handle null -> generic 'Debt settled!' (fail-soft)", async () => {
    // No DebtSettledEncrypted log present -> handle null
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtxhash",
      receipt: { status: "success", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "25");
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Debt settled!");
  });

  it("3-branch toast: decryptForView returns non-bigint -> generic 'Debt settled!'", async () => {
    decodeEventLogMock.mockReturnValue({
      eventName: "DebtSettledEncrypted",
      args: { encryptedActual: "0xabc" },
    });
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtxhash",
      receipt: {
        status: "success",
        blockNumber: 1n,
        logs: [{ address: GM, data: "0x", topics: [] }],
      },
    });
    decryptForViewMock.mockResolvedValue(null);
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "25");
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Debt settled!");
  });

  it("activity_type='debt_settled' + lowercase user_to + broadcastAction TWICE + invalidate", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "25");
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("debt_settled");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ALICE.toLowerCase());
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("error-discriminator: 'approve' -> clearVaultApproval", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("approve failed"));
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "25");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(GM);
  });

  it("reverted receipt -> error + no activity insert", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.settleDebt(1, ALICE, "25");
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  voteOnExpense
// ───────────────────────────────────────────────────────────

describe("useGroupSplit — voteOnExpense (§15.x)", () => {
  it("no address -> 'Connection lost' toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.voteOnExpense(1, 2, "50");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty votes -> 'Enter a vote amount' toast", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.voteOnExpense(1, 2, "");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a vote amount");
  });

  it("voteOnExpense args: [BigInt(groupId), BigInt(expenseId), encVotes] + gas 5M", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.voteOnExpense(7, 13, "50");
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("voteOnExpense");
    expect(call.address).toBe(GM);
    expect(call.args[0]).toBe(7n);
    expect(call.args[1]).toBe(13n);
    expect(call.gas).toBe(5_000_000n);
    const encBatch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(encBatch[0].raw).toBe(50_000_000n);
  });

  it("activity_type='group_vote' + self-to-self user_from/user_to + note mentions ids", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.voteOnExpense(7, 13, "50");
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("group_vote");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ME.toLowerCase());
    expect(row.note).toContain("#13");
    expect(row.note).toContain("#7");
    expect(toastSuccessMock).toHaveBeenCalledWith("Vote submitted!");
  });

  it("reverted receipt -> error + no activity", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.voteOnExpense(1, 2, "50");
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  leaveGroup + archiveGroup
// ───────────────────────────────────────────────────────────

describe("useGroupSplit — leaveGroup (§15.x)", () => {
  it("no address -> 'Connection lost' toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.leaveGroup(1);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
  });

  it("leaveGroup args: [BigInt(groupId)] + gas 5M + plaintext (no encrypt)", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.leaveGroup(7);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("leaveGroup");
    expect(call.args).toEqual([7n]);
    expect(call.gas).toBe(5_000_000n);
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("activity_type='group_left' + broadcastAction('activity_added') ONLY (no balance broadcast)", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.leaveGroup(7);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("group_left");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(broadcastActionMock).not.toHaveBeenCalledWith("balance_changed");
    expect(toastSuccessMock).toHaveBeenCalledWith("Left the group!");
  });

  it("reverted receipt -> error + no activity", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.leaveGroup(1);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("returns hash on success", async () => {
    const { result } = renderHook(() => useGroupSplit());
    let h: unknown;
    await act(async () => {
      h = await result.current.leaveGroup(1);
    });
    expect(h).toBe("0xtxhash");
  });
});

describe("useGroupSplit — archiveGroup (§15.x)", () => {
  it("no address -> 'Connection lost' toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.archiveGroup(1);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
  });

  it("archiveGroup args: [BigInt(groupId)] + gas 5M + plaintext", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.archiveGroup(7);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("archiveGroup");
    expect(call.args).toEqual([7n]);
    expect(call.gas).toBe(5_000_000n);
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("activity_type='group_archived' + broadcastAction('activity_added') only", async () => {
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.archiveGroup(7);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("group_archived");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(broadcastActionMock).not.toHaveBeenCalledWith("balance_changed");
    expect(toastSuccessMock).toHaveBeenCalledWith("Group archived!");
  });

  it("reverted receipt -> error + no activity", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.archiveGroup(1);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  isProcessing state lifecycle
// ───────────────────────────────────────────────────────────

describe("useGroupSplit — isProcessing lifecycle (§15.x)", () => {
  it("flips true during in-flight createGroup + back to false after", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      }),
    );
    const { result } = renderHook(() => useGroupSplit());
    let p!: Promise<unknown>;
    await act(async () => {
      p = result.current.createGroup("A", [ALICE]);
      await Promise.resolve();
    });
    expect(result.current.isProcessing).toBe(true);
    resolveFn({
      hash: "0x",
      receipt: { status: "success", blockNumber: 1n, logs: [] },
    });
    await act(async () => {
      await p;
    });
    expect(result.current.isProcessing).toBe(false);
  });

  it("resets isProcessing to false on rejection too", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("fail"));
    const { result } = renderHook(() => useGroupSplit());
    await act(async () => {
      await result.current.createGroup("A", [ALICE]);
    });
    expect(result.current.isProcessing).toBe(false);
  });
});
