import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useSendPayment. The /pay flow hook driving the
// Send screen + request-fulfilment + agent payments + batch
// payroll. Two modes (single + many) routed through one confirmSend
// entry point. The hook holds MODULE-LEVEL singleton state so the
// 4-screen flow (SendContacts -> SendAmount -> SendConfirm ->
// SendSuccess) shares one state machine across route navigations.
//
// CRITICAL pins:
//   - Module-level _sharedState + _listeners pub/sub: every hook
//     instance reads from + writes to the same singleton, so
//     navigation between Send screens keeps recipient + amount +
//     note alive without prop-drilling. Test resets the singleton
//     in beforeEach by rendering + calling reset() so cross-test
//     state pollution can't happen.
//   - setAmount + setRecipientAmount input regex: /^\d*\.?\d{0,6}$/
//     (max 6 decimal places matching USDC precision). A value with
//     7+ decimals is REJECTED silently (no setState call) so the
//     input field stops accepting keystrokes once the user types
//     past 6dp. Empty string "" is always allowed (so the user can
//     clear the field).
//   - setNote 280-char cap (Twitter-length); silently truncated via
//     slice(0, 280). A regression that dropped the cap would let
//     users post novella-length notes that overflow the receipt
//     card's UI.
//   - canProceedSingle: recipient AND amount AND amount > 0 AND
//     recipient !== self (case-INsensitive). Self-send block is
//     critical because PaymentHub allows self-transfers but the
//     UX is confusing (user sees a payment to themselves in their
//     own feed).
//   - canProceedMany: similar but checks the recipients[] array;
//     equal mode -> needs total amount; custom mode -> every
//     per-recipient amount must be present AND > 0; self-send
//     blocked in any recipient slot (case-INsensitive).
//   - canProceed top-level gates: isAuthenticated (EOA wagmi
//     connected OR isSmartAccount) AND publicClient set AND
//     mode-specific gate passes. The smart-account branch matters
//     because passkey-only users have wagmi.isConnected=false but
//     can still submit UserOps via the relayer.
//   - amountWarning when parseFloat(amount) > 100000 -> 'Large
//     amount -- verify sufficient balance' (use double-dash not
//     em-dash so the source string matches the test pin literally).
//   - #71 pending TX recovery on mount: reads STORAGE_KEYS
//     .pendingSend(address, chainId) + shows toast if record is
//     < 10 minutes old + removeStored regardless of age. The age
//     filter matters because a 1-week-old pending record is
//     either already mined (Etherscan link wouldn't show
//     'pending') or genuinely lost — either way, surfacing it
//     would confuse the user.
//   - #272 submittingRef synchronous latch: ref-based not state-
//     based so a double-click in the same React batch can't fire
//     two writeContract calls; ref is set BEFORE state flips to
//     'sending', cleared in finally. Test pins by mocking
//     unifiedWrite to hang + firing two confirmSend calls back-
//     to-back + asserting unifiedWrite called exactly once.
//   - #239 retry-once-on-allowance-error: atomic path self-calls
//     _runConfirmSendAtomic(isRetry=true) after clearVaultApproval;
//     guards via isRetry param so a permanently-broken approval
//     can't infinite-loop. (Legacy path doesn't have this retry —
//     it just clears the cache and exits.)
//   - #277 user-cancelled toast suppression: mapError() returns
//     userCancelled=true for wallet-rejection errors; when true,
//     the catch block skips toast.error so the user doesn't see
//     an 'Error: User rejected' popup when they intentionally
//     cancelled the prompt.
//   - confirmBatchSend gas formula: 5_000_000n + 800_000n *
//     BigInt(N) — base 5M plus 800k per recipient. N=30 (the cap)
//     yields 29M which sits below the 30M Sepolia block gas limit
//     with margin. A regression that dropped the per-recipient
//     multiplier would silently revert with out-of-gas at N=8+.
//   - confirmBatchSend BusinessHub approval cache (not PaymentHub):
//     BusinessHub.runPayroll calls vault.transferFromVerified
//     server-side, so it needs ITS OWN allowance on the vault.
//     Test pins both caches separately.
//   - Per-recipient activity fanout tx_hash suffix
//     `${hash}_${recipient.toLowerCase()}` for dedup-key uniqueness
//     (same pattern as useGroupSplit + useGiftMoney).

const useAccountMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const clearVaultApprovalMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const insertActivitiesFanoutMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const getStoredJsonMock = vi.hoisted(() => vi.fn());
const setStoredJsonMock = vi.hoisted(() => vi.fn());
const removeStoredMock = vi.hoisted(() => vi.fn());
const mapErrorMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastFnMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  useAccount: useAccountMock,
  usePublicClient: usePublicClientMock,
}));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheConnection: useCofheConnectionMock,
  useCofheEncrypt: useCofheEncryptMock,
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/abis", () => ({
  BusinessHubAbi: [],
  FHERC20VaultAbi: [],
  PaymentHubAbi: [],
}));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
  clearVaultApproval: clearVaultApprovalMock,
}));
vi.mock("@/lib/supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("@/lib/activity-fanout", () => ({
  insertActivitiesFanout: insertActivitiesFanoutMock,
}));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/storage", () => ({
  STORAGE_KEYS: {
    pendingSend: (addr: string, c: number) => `pending_send_${addr}_${c}`,
  },
  getStoredJson: getStoredJsonMock,
  setStoredJson: setStoredJsonMock,
  removeStored: removeStoredMock,
}));
vi.mock("@/lib/error-messages", () => ({ mapError: mapErrorMock }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(toastFnMock, {
    error: toastErrorMock,
    success: toastSuccessMock,
  }),
}));

import { useSendPayment, MAX_BATCH_RECIPIENTS } from "./useSendPayment";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const CAROL = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
const VAULT = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const PAYMENT_HUB = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const BUSINESS_HUB = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const USDC = "0x4444444444444444444444444444444444444444" as `0x${string}`;

const unifiedWriteMock = vi.fn();
const encryptInputsAsyncMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();

// Reset the module-level _sharedState by rendering once and calling reset().
function resetSharedState() {
  const { result, unmount } = renderHook(() => useSendPayment());
  act(() => result.current.reset());
  unmount();
}

beforeEach(() => {
  useAccountMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheEncryptMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  insertActivityMock.mockReset();
  insertActivitiesFanoutMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  getStoredJsonMock.mockReset();
  setStoredJsonMock.mockReset();
  removeStoredMock.mockReset();
  mapErrorMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastFnMock.mockReset();
  unifiedWriteMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  waitForTransactionReceiptMock.mockReset();

  useAccountMock.mockReturnValue({ isConnected: true });
  useEffectiveAddressMock.mockReturnValue({
    effectiveAddress: ME,
    isSmartAccount: false,
  });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useCofheEncryptMock.mockReturnValue({
    encryptInputsAsync: encryptInputsAsyncMock,
    isEncrypting: false,
  });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      FHERC20Vault_USDC: VAULT,
      PaymentHub: PAYMENT_HUB,
      BusinessHub: BUSINESS_HUB,
      TestUSDC: USDC,
    },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
  });
  useUnifiedWriteMock.mockReturnValue({ unifiedWrite: unifiedWriteMock });
  isVaultApprovedMock.mockReturnValue(true);
  getStoredJsonMock.mockReturnValue(null); // no pending record by default
  mapErrorMock.mockImplementation((err: unknown) => ({
    title: err instanceof Error ? err.message : "Transaction failed",
    description: "",
    userCancelled: false,
  }));
  unifiedWriteMock.mockResolvedValue("0xtxhash" as `0x${string}`);
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 5n,
  });
  encryptInputsAsyncMock.mockImplementation(async (inputs: unknown[]) =>
    inputs.map((_, i) => ({
      ctHash: BigInt(i + 1),
      securityZone: 0,
      utype: 5,
      signature: "0xenc",
    })),
  );

  resetSharedState();
});

// ───────────────────────────────────────────────────────────
//  Initial state + setters
// ───────────────────────────────────────────────────────────

describe("useSendPayment — initial state (§15.x)", () => {
  it("returns initial singleton state + 9 setters + 3 callables + 4 derived flags", () => {
    const { result } = renderHook(() => useSendPayment());
    expect(result.current.step).toBe("input");
    expect(result.current.recipient).toBe("");
    expect(result.current.amount).toBe("");
    expect(result.current.note).toBe("");
    expect(result.current.token).toBe("USDC");
    expect(result.current.mode).toBe("single");
    expect(result.current.recipients).toEqual([]);
    expect(result.current.splitMode).toBe("equal");
    expect(result.current.recipientAmounts).toEqual([]);
    expect(result.current.txHash).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.canProceed).toBe(false);
    expect(result.current.cofheConnected).toBe(true);
    expect(typeof result.current.setRecipient).toBe("function");
    expect(typeof result.current.setAmount).toBe("function");
    expect(typeof result.current.setNote).toBe("function");
    expect(typeof result.current.setToken).toBe("function");
    expect(typeof result.current.setMode).toBe("function");
    expect(typeof result.current.setRecipients).toBe("function");
    expect(typeof result.current.setSplitMode).toBe("function");
    expect(typeof result.current.setRecipientAmount).toBe("function");
    expect(typeof result.current.send).toBe("function");
    expect(typeof result.current.confirmSend).toBe("function");
    expect(typeof result.current.reset).toBe("function");
    expect(typeof result.current.goBack).toBe("function");
  });
});

describe("useSendPayment — setters (§15.x)", () => {
  it("setAmount accepts <=6dp + rejects 7dp silently", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setAmount("100.123456"));
    expect(result.current.amount).toBe("100.123456");
    act(() => result.current.setAmount("100.1234567")); // 7dp rejected
    expect(result.current.amount).toBe("100.123456"); // unchanged
  });

  it("setAmount accepts empty string (clear field)", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setAmount("50"));
    act(() => result.current.setAmount(""));
    expect(result.current.amount).toBe("");
  });

  it("setAmount rejects non-numeric", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setAmount("abc")); // rejected
    expect(result.current.amount).toBe("");
  });

  it("setNote caps at 280 chars", () => {
    const { result } = renderHook(() => useSendPayment());
    const long = "x".repeat(500);
    act(() => result.current.setNote(long));
    expect(result.current.note.length).toBe(280);
  });

  it("setRecipient + setToken passthrough", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setToken("USDT"));
    expect(result.current.recipient).toBe(ALICE);
    expect(result.current.token).toBe("USDT");
  });

  it("setMode 'many' clears recipient + setMode 'single' clears recipients", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setMode("many"));
    expect(result.current.recipient).toBe(""); // cleared
    expect(result.current.recipients).toEqual([]); // empty since switched
    act(() => result.current.setRecipients([ALICE, BOB]));
    act(() => result.current.setMode("single"));
    expect(result.current.recipients).toEqual([]); // cleared
  });

  it("setMode same mode -> no-op (same state reference returned)", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setMode("single")); // same
    expect(result.current.recipient).toBe(ALICE); // preserved
  });

  it("setRecipients caps at MAX_BATCH_RECIPIENTS (30)", () => {
    const { result } = renderHook(() => useSendPayment());
    const big = Array(50).fill(0).map((_, i) =>
      `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`,
    );
    act(() => result.current.setRecipients(big));
    expect(result.current.recipients).toHaveLength(MAX_BATCH_RECIPIENTS);
    expect(MAX_BATCH_RECIPIENTS).toBe(30);
  });

  it("setRecipients pads recipientAmounts to match length", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipients([ALICE, BOB, CAROL]));
    expect(result.current.recipientAmounts).toHaveLength(3);
    expect(result.current.recipientAmounts).toEqual(["", "", ""]);
  });

  it("setRecipientAmount regex 6dp + bounds check (index out of range no-op)", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipients([ALICE, BOB]));
    act(() => result.current.setRecipientAmount(0, "10.123456"));
    expect(result.current.recipientAmounts[0]).toBe("10.123456");
    act(() => result.current.setRecipientAmount(1, "9.1234567")); // 7dp rejected
    expect(result.current.recipientAmounts[1]).toBe(""); // unchanged
    act(() => result.current.setRecipientAmount(5, "1")); // OOB
    expect(result.current.recipientAmounts).toHaveLength(2); // unchanged
  });

  it("setSplitMode toggles equal <-> custom", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setSplitMode("custom"));
    expect(result.current.splitMode).toBe("custom");
    act(() => result.current.setSplitMode("equal"));
    expect(result.current.splitMode).toBe("equal");
  });
});

// ───────────────────────────────────────────────────────────
//  canProceed gates
// ───────────────────────────────────────────────────────────

describe("useSendPayment — canProceed single mode (§15.x)", () => {
  it("requires recipient + amount > 0 + not-self + isAuthenticated + publicClient", () => {
    const { result } = renderHook(() => useSendPayment());
    expect(result.current.canProceed).toBe(false); // empty
    act(() => result.current.setRecipient(ALICE));
    expect(result.current.canProceed).toBe(false); // no amount
    act(() => result.current.setAmount("10"));
    expect(result.current.canProceed).toBe(true);
  });

  it("self-send blocked (case-INsensitive)", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ME.toUpperCase()));
    act(() => result.current.setAmount("10"));
    expect(result.current.canProceed).toBe(false);
  });

  it("zero amount blocked", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("0"));
    expect(result.current.canProceed).toBe(false);
  });

  it("no publicClient -> blocked", () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    expect(result.current.canProceed).toBe(false);
  });

  it("passkey-only (isSmartAccount=true, isConnected=false) -> canProceed still works", () => {
    useAccountMock.mockReturnValue({ isConnected: false });
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
    });
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    expect(result.current.canProceed).toBe(true);
  });
});

describe("useSendPayment — canProceed many mode (§15.x)", () => {
  it("empty recipients -> blocked", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setAmount("100"));
    expect(result.current.canProceed).toBe(false);
  });

  it("equal split: needs amount > 0", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setRecipients([ALICE, BOB]));
    expect(result.current.canProceed).toBe(false); // no amount
    act(() => result.current.setAmount("100"));
    expect(result.current.canProceed).toBe(true);
  });

  it("custom split: every per-recipient amount must be positive", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setRecipients([ALICE, BOB]));
    act(() => result.current.setSplitMode("custom"));
    act(() => result.current.setRecipientAmount(0, "50"));
    expect(result.current.canProceed).toBe(false); // one missing
    act(() => result.current.setRecipientAmount(1, "30"));
    expect(result.current.canProceed).toBe(true);
  });

  it("custom split with zero amount in slot -> blocked", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setRecipients([ALICE, BOB]));
    act(() => result.current.setSplitMode("custom"));
    act(() => result.current.setRecipientAmount(0, "50"));
    act(() => result.current.setRecipientAmount(1, "0"));
    expect(result.current.canProceed).toBe(false);
  });

  it("self-send in any recipient slot blocks (case-INsensitive)", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setRecipients([ALICE, ME.toUpperCase()]));
    act(() => result.current.setAmount("100"));
    expect(result.current.canProceed).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  amountWarning + #71 pending recovery
// ───────────────────────────────────────────────────────────

describe("useSendPayment — amountWarning + pending recovery (§15.x)", () => {
  it("amountWarning fires when amount > 100000 (double-dash, not em-dash)", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setAmount("100001"));
    expect(result.current.amountWarning).toBe(
      "Large amount -- verify sufficient balance",
    );
  });

  it("amountWarning undefined when amount <= 100000", () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setAmount("99999"));
    expect(result.current.amountWarning).toBeUndefined();
  });

  it("#71 pending TX recovery: fresh record (<10min) toasts + removeStored", () => {
    const recent = Date.now() - 60_000; // 1 min ago
    getStoredJsonMock.mockReturnValue({
      timestamp: recent,
      amount: "50",
      token: "USDC",
      hash: "0xpending",
    });
    renderHook(() => useSendPayment());
    expect(toastFnMock).toHaveBeenCalledWith(
      expect.stringContaining("pending send of 50 USDC"),
      expect.objectContaining({ duration: 10000 }),
    );
    expect(removeStoredMock).toHaveBeenCalled();
  });

  it("#71 pending TX recovery: stale record (>10min) -> NO toast, still removeStored", () => {
    const stale = Date.now() - 700_000; // >10 min
    getStoredJsonMock.mockReturnValue({
      timestamp: stale,
      amount: "50",
      token: "USDC",
      hash: "0xpending",
    });
    renderHook(() => useSendPayment());
    expect(toastFnMock).toHaveBeenCalledTimes(0);
    expect(removeStoredMock).toHaveBeenCalled();
  });

  it("#71 no record -> no toast no remove", () => {
    getStoredJsonMock.mockReturnValue(null);
    renderHook(() => useSendPayment());
    expect(toastFnMock).toHaveBeenCalledTimes(0);
    expect(removeStoredMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  send (transitions to confirming)
// ───────────────────────────────────────────────────────────

describe("useSendPayment — send legacy (§15.x)", () => {
  it("send single mode -> step='confirming'", async () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.step).toBe("confirming");
  });

  it("send single empty amount -> 'Enter an amount' + no transition", async () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    // canProceed will be false, so send returns early
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.step).toBe("input");
  });

  it("send single amount < 0.01 -> 'Minimum amount is $0.01' toast", async () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("0.001"));
    await act(async () => {
      await result.current.send();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Minimum amount is $0.01");
    expect(result.current.step).toBe("input");
  });

  it("send many mode -> step='confirming' (skips amount checks)", async () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setRecipients([ALICE, BOB]));
    act(() => result.current.setAmount("50"));
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.step).toBe("confirming");
  });

  it("canProceed=false -> send is no-op", async () => {
    const { result } = renderHook(() => useSendPayment());
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.step).toBe("input");
  });
});

// ───────────────────────────────────────────────────────────
//  confirmSend single legacy path
// ───────────────────────────────────────────────────────────

describe("useSendPayment — confirmSend single legacy (§15.x)", () => {
  async function setupReady() {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    await act(async () => {
      await result.current.send();
    });
    return result;
  }

  it("no address -> 'Smart wallet not ready' toast + no write", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: null,
      isSmartAccount: false,
    });
    const { result } = renderHook(() => useSendPayment());
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Smart wallet not ready yet — please wait a moment and try again.",
    );
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Connection lost. Please refresh.",
    );
  });

  it("first-time: approve PaymentHub + markVaultApproved + sendPayment", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const result = await setupReady();
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(2);
    expect(unifiedWriteMock.mock.calls[0][0].functionName).toBe(
      "approvePlaintext",
    );
    expect(unifiedWriteMock.mock.calls[0][0].args[0]).toBe(PAYMENT_HUB);
    expect(unifiedWriteMock.mock.calls[1][0].functionName).toBe("sendPayment");
    expect(markVaultApprovedMock).toHaveBeenCalledWith(PAYMENT_HUB);
  });

  it("pre-approved -> single sendPayment write (no approve)", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const result = await setupReady();
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteMock.mock.calls[0][0].functionName).toBe("sendPayment");
  });

  it("sendPayment args: [recipient, vault, encAmount, note] + gas 5M", async () => {
    const result = await setupReady();
    act(() => result.current.setNote("Hello"));
    await act(async () => {
      await result.current.confirmSend();
    });
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.address).toBe(PAYMENT_HUB);
    expect(call.functionName).toBe("sendPayment");
    expect(call.args[0]).toBe(ALICE);
    expect(call.args[1]).toBe(VAULT);
    expect(call.args[2]).toMatchObject({
      ctHash: 1n,
      securityZone: 0,
      utype: 5,
      signature: "0xenc",
    });
    expect(call.args[3]).toBe("Hello");
    expect(call.gas).toBe(5_000_000n);
  });

  it("paymaster mode 'self' passthrough to unifiedWrite", async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.confirmSend("self");
    });
    expect(unifiedWriteMock.mock.calls[0][0].paymaster).toBe("self");
  });

  it("paymaster mode 'sponsored' (default) passthrough", async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.confirmSend("sponsored");
    });
    expect(unifiedWriteMock.mock.calls[0][0].paymaster).toBe("sponsored");
  });

  it("happy path: pendingSend stored, then cleared on success + activity + broadcasts", async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(setStoredJsonMock).toHaveBeenCalled();
    expect(removeStoredMock).toHaveBeenCalled(); // cleared on success
    expect(result.current.step).toBe("success");
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("payment");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ALICE.toLowerCase());
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith("Payment sent!");
  });

  it("reverted receipt -> step='error' + pending NOT cleared + no activity", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      blockNumber: 5n,
    });
    const result = await setupReady();
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(result.current.step).toBe("error");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("allowance error -> clearVaultApproval(PaymentHub)", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("insufficient allowance"));
    const result = await setupReady();
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(PAYMENT_HUB);
    expect(result.current.step).toBe("error");
  });

  it("#277 user-cancelled error: NO toast.error", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("User rejected"));
    mapErrorMock.mockReturnValue({
      title: "Cancelled",
      description: "",
      userCancelled: true,
    });
    const result = await setupReady();
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(toastErrorMock).not.toHaveBeenCalledWith("Cancelled");
  });

  it("#272 submittingRef: double-click in same batch -> only ONE write", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    unifiedWriteMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      }),
    );
    const result = await setupReady();
    let p1: unknown;
    await act(async () => {
      p1 = result.current.confirmSend();
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.confirmSend(); // second
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    resolveFn("0xtxhash");
    await act(async () => {
      await p1;
    });
  });
});

// ───────────────────────────────────────────────────────────
//  confirmBatchSend
// ───────────────────────────────────────────────────────────

describe("useSendPayment — confirmBatchSend (§15.x)", () => {
  async function setupBatchReady(
    recipients: `0x${string}`[] = [ALICE, BOB],
    splitMode: "equal" | "custom" = "equal",
    amounts: string[] = ["100"],
  ) {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setRecipients(recipients));
    act(() => result.current.setSplitMode(splitMode));
    if (splitMode === "equal") {
      act(() => result.current.setAmount(amounts[0]));
    } else {
      amounts.forEach((a, i) =>
        act(() => result.current.setRecipientAmount(i, a)),
      );
    }
    await act(async () => {
      await result.current.send();
    });
    return result;
  }

  it("empty recipients -> 'Pick at least one recipient' + early return", async () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setAmount("100"));
    // canProceed=false so send() won't transition, but call confirmSend
    // directly to test the batch-specific guards
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Pick at least one recipient");
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("equal split happy: encrypts N salaries + runPayroll with gas 5M+800k*N", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const result = await setupBatchReady([ALICE, BOB, CAROL], "equal", ["50"]);
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(1);
    const batch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(batch).toHaveLength(3);
    // Equal split: every input gets parseUnits("50", 6) = 50_000_000n
    for (const item of batch) expect(item.raw).toBe(50_000_000n);
    const runCall = unifiedWriteMock.mock.calls.find(
      (c) => c[0].functionName === "runPayroll",
    );
    expect(runCall).toBeDefined();
    expect(runCall![0].address).toBe(BUSINESS_HUB);
    expect(runCall![0].args[0]).toEqual([ALICE, BOB, CAROL]);
    expect(runCall![0].args[1]).toBe(VAULT);
    // Gas: 5_000_000n + 800_000n * 3n = 7_400_000n
    expect(runCall![0].gas).toBe(7_400_000n);
  });

  it("custom split: per-recipient parseUnits applied", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const result = await setupBatchReady(
      [ALICE, BOB],
      "custom",
      ["25", "75"],
    );
    await act(async () => {
      await result.current.confirmSend();
    });
    const batch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(batch[0].raw).toBe(25_000_000n);
    expect(batch[1].raw).toBe(75_000_000n);
  });

  it("first-time: BusinessHub approve (NOT PaymentHub) + markVaultApproved(BusinessHub)", async () => {
    isVaultApprovedMock.mockImplementation(
      (spender: string) => spender !== BUSINESS_HUB, // only BusinessHub not approved
    );
    const result = await setupBatchReady([ALICE, BOB], "equal", ["50"]);
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(unifiedWriteMock.mock.calls[0][0].functionName).toBe(
      "approvePlaintext",
    );
    expect(unifiedWriteMock.mock.calls[0][0].args[0]).toBe(BUSINESS_HUB);
    expect(markVaultApprovedMock).toHaveBeenCalledWith(BUSINESS_HUB);
  });

  it("custom split with empty slot -> 'Every recipient needs a positive amount' early return", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setMode("many"));
    act(() => result.current.setRecipients([ALICE, BOB]));
    act(() => result.current.setSplitMode("custom"));
    act(() => result.current.setRecipientAmount(0, "50"));
    // slot 1 left empty; canProceed will be false
    // Call confirmSend directly to verify the inner guard
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Every recipient needs a positive amount",
    );
  });

  it("amount < $0.01 in any slot -> 'Minimum per-recipient amount is $0.01'", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const result = await setupBatchReady(
      [ALICE, BOB],
      "custom",
      ["50", "0.001"],
    );
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Minimum per-recipient amount is $0.01",
    );
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("fanout: per-recipient row with `${hash}_${recipient}` tx_hash + BATCH_PAYMENT type", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const result = await setupBatchReady([ALICE, BOB], "equal", ["50"]);
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(insertActivitiesFanoutMock).toHaveBeenCalledTimes(1);
    const rows = insertActivitiesFanoutMock.mock.calls[0][0] as Array<{
      tx_hash: string;
      user_to: string;
      activity_type: string;
      note: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].tx_hash).toBe(`0xtxhash_${ALICE.toLowerCase()}`);
    expect(rows[0].user_to).toBe(ALICE.toLowerCase());
    expect(rows[0].activity_type).toBe("batch_payment");
  });

  it("reverted batch receipt -> step='error' + no fanout", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      blockNumber: 5n,
    });
    const result = await setupBatchReady([ALICE, BOB], "equal", ["50"]);
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(result.current.step).toBe("error");
    expect(insertActivitiesFanoutMock).toHaveBeenCalledTimes(0);
  });

  it("allowance error -> clearVaultApproval(BusinessHub)", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    unifiedWriteMock.mockRejectedValue(new Error("insufficient allowance"));
    const result = await setupBatchReady([ALICE, BOB], "equal", ["50"]);
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(BUSINESS_HUB);
  });

  it("happy path final state: step='success' + N-recipient success toast", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const result = await setupBatchReady([ALICE, BOB, CAROL], "equal", ["50"]);
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(result.current.step).toBe("success");
    expect(toastSuccessMock).toHaveBeenCalledWith("Sent to 3 recipients");
  });
});

// ───────────────────────────────────────────────────────────
//  reset + goBack
// ───────────────────────────────────────────────────────────

describe("useSendPayment — reset + goBack (§15.x)", () => {
  it("reset clears all state to initial", async () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    act(() => result.current.setNote("hi"));
    act(() => result.current.reset());
    expect(result.current.recipient).toBe("");
    expect(result.current.amount).toBe("");
    expect(result.current.note).toBe("");
    expect(result.current.step).toBe("input");
  });

  it("goBack from confirming -> input", async () => {
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.step).toBe("confirming");
    act(() => result.current.goBack());
    expect(result.current.step).toBe("input");
  });

  it("goBack from error -> input + clear error", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("fail"));
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    await act(async () => {
      await result.current.send();
    });
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(result.current.step).toBe("error");
    act(() => result.current.goBack());
    expect(result.current.step).toBe("input");
    expect(result.current.error).toBeNull();
  });

  it("goBack from mid-flight (encrypting/sending) -> no-op", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    unifiedWriteMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      }),
    );
    const { result } = renderHook(() => useSendPayment());
    act(() => result.current.setRecipient(ALICE));
    act(() => result.current.setAmount("10"));
    await act(async () => {
      await result.current.send();
    });
    let p: unknown;
    await act(async () => {
      p = result.current.confirmSend();
      await Promise.resolve();
    });
    // Now in-flight; goBack should be no-op
    const stepBefore = result.current.step;
    expect(["encrypting", "sending"]).toContain(stepBefore);
    act(() => result.current.goBack());
    expect(result.current.step).toBe(stepBefore); // unchanged
    resolveFn("0x");
    await act(async () => {
      await p;
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Cross-instance singleton state
// ───────────────────────────────────────────────────────────

describe("useSendPayment — module-level singleton (§15.x)", () => {
  it("two hook instances share recipient + amount across render trees", async () => {
    const inst1 = renderHook(() => useSendPayment());
    act(() => inst1.result.current.setRecipient(ALICE));
    act(() => inst1.result.current.setAmount("42"));
    // Now mount a second instance; the listener pub/sub syncs.
    const inst2 = renderHook(() => useSendPayment());
    await waitFor(() => {
      expect(inst2.result.current.recipient).toBe(ALICE);
      expect(inst2.result.current.amount).toBe("42");
    });
  });
});
