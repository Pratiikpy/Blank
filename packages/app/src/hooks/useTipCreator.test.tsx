import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useTipCreator. Phase 4 creator-support flow: encrypted
// USDC tip to a creator via CreatorHub.support(). Two FHE-specific
// landmines + one approval-cache landmine to pin:
//
// CRITICAL pins:
//   - audit Top-28 #16 double-submit guard via submittingRef. The ref
//     flips synchronously to true at the top of `tip()` and blocks any
//     second call until the finally clears it. Without the ref, a
//     rapid-fire double-click on the Tip button would fire TWO support
//     txs (and double-charge the user). isTipping state is async so it
//     can't be relied on for the gate.
//   - SDK output normalization for encrypted inputs: rawEncAmount may
//     wrap (ctHash, securityZone, utype, signature) at top level OR
//     inside .data. The contract's InEuint64 ABI tuple expects them at
//     TOP LEVEL. Without normalization the signature doesn't line up
//     with the ctHash on chain and MockTaskManager.verifyInput reverts
//     with "InvalidSigner". This is the same fix as useSendPayment.
//   - First-time approval cache via isVaultApproved/markVaultApproved.
//     First tip approves MAX_UINT64 once; subsequent tips skip the
//     approval tx entirely. On allowance/approve/insufficient/transfer-
//     amount errors, clearVaultApproval re-arms the gate so the next
//     attempt re-approves (covers the case where someone revokes
//     approval externally or the contract is upgraded).
//   - Empty/whitespace-only amount -> "Enter an amount" toast, no
//     parseUnits (parseUnits("") throws), no encrypt, no support call.
//   - Transaction-reverted receipt -> throws "Transaction reverted
//     on-chain", caught by outer try, surfaced as toast.error. Without
//     the throw the supabase insert would fire for a reverted tx and
//     poison the activity feed with a phantom "tip sent" row.
//   - On success: insertActivity + insertCreatorSupporter +
//     recomputeCreatorSupporterCount + broadcastAction (balance_changed
//     AND activity_added) + invalidateBalanceQueries all fire. The
//     supporter inserts are wrapped in their own try/catch so a
//     supabase outage doesn't fail-close the tip — the on-chain tx is
//     irreversible at this point so we accept best-effort logging.
//   - No address OR no cofhe connection -> early return (no toast, no
//     state change). Defensive: the UI gates the button so this path
//     shouldn't fire, but the ref still flips false in finally so a
//     subsequent valid call works.
//   - Funding gate: on an upgraded CreatorHub, support() leaves a Pending
//     tip. The hook decrypts the public "funded" bit, calls
//     confirmFunding, and only then records the supporter. An unfunded
//     tip is voided and never recorded; a check that cannot finish leaves
//     the tip Pending and recoverable. Pre-gate contracts keep the
//     single-step behaviour.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const insertCreatorSupporterMock = vi.hoisted(() => vi.fn());
const recomputeCreatorSupporterCountMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const clearVaultApprovalMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());
const decryptForTxMock = vi.hoisted(() => vi.fn());
const readContractMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
const NOT_READY = vi.hoisted(() => "encryption-not-ready");
vi.mock("@/lib/cofhe-shim", () => ({
  // Pins "the not-ready message is shown" without pinning the exact copy.
  ENCRYPTION_NOT_READY: NOT_READY,
  useCofheConnection: useCofheConnectionMock,
  useCofheEncrypt: useCofheEncryptMock,
  useCofheDecryptForTx: () => ({ decryptForTx: decryptForTxMock }),
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/lib/supabase", () => ({
  insertActivity: insertActivityMock,
  insertCreatorSupporter: insertCreatorSupporterMock,
  recomputeCreatorSupporterCount: recomputeCreatorSupporterCountMock,
}));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
  clearVaultApproval: clearVaultApprovalMock,
}));
vi.mock("@/lib/abis", () => ({ CreatorHubAbi: [], FHERC20VaultAbi: [] }));
// Same logic, but time only advances when the helper sleeps, so a decrypt that
// never becomes ready times out instantly instead of after 90 real seconds.
vi.mock("@/lib/funding-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/funding-gate")>();
  return {
    ...actual,
    runFundingGate: (opts: Parameters<typeof actual.runFundingGate>[0]) => {
      let t = 0;
      return actual.runFundingGate({ ...opts, now: () => t, sleep: async (ms) => { t += ms; } });
    },
  };
});
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), debug: vi.fn() } }));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useTipCreator } from "./useTipCreator";
import { PENDING_EVENT_TOPIC, addPendingFunding, listPendingFundings } from "@/lib/pending-funding";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CREATOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VAULT = "0x1111111111111111111111111111111111111111";
const HUB = "0x2222222222222222222222222222222222222222";

const encryptInputsAsyncMock = vi.fn();
const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const getTransactionReceiptMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheEncryptMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  insertActivityMock.mockReset();
  insertCreatorSupporterMock.mockReset();
  recomputeCreatorSupporterCountMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  decryptForTxMock.mockReset();
  readContractMock.mockReset();
  localStorage.clear();
  encryptInputsAsyncMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  getTransactionReceiptMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useCofheEncryptMock.mockReturnValue({
    encryptInputsAsync: encryptInputsAsyncMock,
  });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      CreatorHub: HUB,
      FHERC20Vault_USDC: VAULT,
    },
  });
  // A pre-gate CreatorHub has no nextTipId, so reads fail by default: the
  // legacy suites below run against exactly that contract.
  readContractMock.mockRejectedValue(new Error("execution reverted"));
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    getTransactionReceipt: getTransactionReceiptMock,
    readContract: readContractMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  isVaultApprovedMock.mockReturnValue(true); // skip approval by default
  toastLoadingMock.mockReturnValue("toast-id");
  insertActivityMock.mockResolvedValue(undefined);
  insertCreatorSupporterMock.mockResolvedValue(undefined);
  recomputeCreatorSupporterCountMock.mockResolvedValue(undefined);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: { status: "success", blockNumber: 12345n },
  });
  encryptInputsAsyncMock.mockResolvedValue(["0xhandle0", "0xbatchproof"]);
});

// ----- initial state ----- //

describe("useTipCreator — initial state (§15.x)", () => {
  it("returns { isTipping: false, tip: fn } on mount", () => {
    const { result } = renderHook(() => useTipCreator());
    expect(result.current.isTipping).toBe(false);
    expect(typeof result.current.tip).toBe("function");
    expect(result.current.pendingTipCount).toBe(0);
  });
});

// ----- guard rails: no address / no connection ----- //

describe("useTipCreator — guard rails (§15.x)", () => {
  it("no effectiveAddress -> early return, no encrypt, no support, no toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledTimes(0);
  });

  it("CRITICAL cofhe not connected -> no write AND the user is told why", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith(NOT_READY);
  });

  it("publicClient null -> 'Connection lost' toast (no encrypt)", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost. Please refresh.");
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });
});

// ----- empty amount validation ----- //

describe("useTipCreator — empty amount validation (§15.x)", () => {
  it("empty string amount -> 'Enter an amount' toast, no encrypt, no support", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "", "thanks");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("whitespace-only amount -> 'Enter an amount' toast", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "   ", "thanks");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("isTipping flips back to false after validation rejection (ref cleared in finally)", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "", "thanks");
    });
    expect(result.current.isTipping).toBe(false);
  });
});

// ----- double-submit guard (audit Top-28 #16) ----- //

describe("useTipCreator — audit Top-28 #16 double-submit guard (§15.x)", () => {
  it("rapid double-call -> only ONE encrypt+support call (submittingRef synchronously blocks 2nd)", async () => {
    // Stall the support call to keep the ref locked between calls
    let resolveSupport: (v: unknown) => void = () => {};
    const supportPromise = new Promise((res) => {
      resolveSupport = res;
    });
    unifiedWriteAndWaitMock.mockReturnValue(supportPromise);

    const { result } = renderHook(() => useTipCreator());

    // Fire both calls before the first resolves
    let p1: Promise<unknown>;
    let p2: Promise<unknown>;
    await act(async () => {
      p1 = result.current.tip(CREATOR, "10", "first");
      p2 = result.current.tip(CREATOR, "10", "second");
      // Let microtasks run so the second call hits the ref-guard
      await Promise.resolve();
      // Now resolve the support call
      resolveSupport({
        hash: "0xtxhash",
        receipt: { status: "success", blockNumber: 1n },
      });
      await p1;
      await p2;
    });

    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    // The second call's encrypt should ALSO not have fired
    // (only the first call encrypted)
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(1);
  });
});

// ----- first-time approval ----- //

describe("useTipCreator — first-time approval cache (§15.x)", () => {
  it("approval not cached -> approvePlaintext fires + markVaultApproved called", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    const args = unifiedWriteMock.mock.calls[0][0];
    expect(args.functionName).toBe("approvePlaintext");
    expect(args.address).toBe(VAULT);
    expect(args.args[0]).toBe(HUB);
    expect(args.args[1]).toBe(BigInt("18446744073709551615")); // MAX_UINT64
    expect(markVaultApprovedMock).toHaveBeenCalledWith(HUB);
  });

  it("approval cached -> approvePlaintext skipped (no unifiedWrite call)", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval failure -> error toast + throws + tip support NOT called", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteMock.mockRejectedValue(new Error("user rejected approval"));
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Approval failed",
      expect.objectContaining({ id: "toast-id" }),
    );
    // Outer catch fires with the original error message
    expect(toastErrorMock).toHaveBeenCalledWith("user rejected approval");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });
});

// ----- SDK output normalization ----- //

describe("useTipCreator — 0.7 encrypted input wiring (§15.x)", () => {
  it("passes the handle and the batch proof through in order", async () => {
    // 0.7 returns [handle, ..., batchSignature]. There is no struct to
    // normalise: what the SDK returns goes on the wire unchanged.
    encryptInputsAsyncMock.mockResolvedValue(["0xhandle0", "0xbatchproof"]);
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    const args = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(args.args[2]).toBe("0xhandle0");
    expect(args.args[3]).toBe("0xbatchproof");
  });

  it("names CreatorHub as the consuming contract", async () => {
    // CreatorHub.support runs FHE.asEuint64, so the batch signature is bound
    // to CreatorHub — not to the vault the funds move through.
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    expect(encryptInputsAsyncMock.mock.calls[0][1]).toBe(HUB);
  });
});

describe("useTipCreator — CreatorHub.support call (§15.x)", () => {
  it("calls support with (creator, vault, encAmount, message)", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "great work");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const args = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(args.address).toBe(HUB);
    expect(args.functionName).toBe("support");
    expect(args.args[0]).toBe(CREATOR);
    expect(args.args[1]).toBe(VAULT);
    expect(args.args[4]).toBe("great work");
  });

  it("passes manual gas limit (FHE precompile breaks estimation)", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    const args = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(args.gas).toBe(5_000_000n);
  });

  it("AA-receipt path: uses tipResult.receipt directly (no waitForTransactionReceipt poll)", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xaa",
      receipt: { status: "success", blockNumber: 999n },
    });
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
    expect(getTransactionReceiptMock).toHaveBeenCalledTimes(0);
    expect(insertActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ block_number: 999 }),
    );
  });

  it("EOA-receipt path: no receipt on tipResult -> falls back to publicClient", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xeoa",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "success",
      blockNumber: 12345n,
    });
    getTransactionReceiptMock.mockResolvedValue({ status: "success" });
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
    });
    expect(insertActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ block_number: 12345 }),
    );
  });

  it("reverted receipt -> throws + error toast + NO supabase write (audit invariant)", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n },
    });
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Transaction reverted on-chain");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(insertCreatorSupporterMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
  });
});

// ----- success path side effects ----- //

describe("useTipCreator — success path side effects (§15.x)", () => {
  it("activity row inserted with lowercased addresses + tx_hash + creator note", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "great stream");
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.tx_hash).toBe("0xtxhash");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(CREATOR.toLowerCase());
    expect(row.note).toBe("great stream");
    expect(row.contract_address).toBe(HUB);
    expect(row.token_address).toBe(VAULT);
  });

  it("insertCreatorSupporter + recomputeCreatorSupporterCount both fire after success", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(insertCreatorSupporterMock).toHaveBeenCalledWith({
      creator_address: CREATOR,
      supporter_address: ME,
      message: "msg",
    });
    expect(recomputeCreatorSupporterCountMock).toHaveBeenCalledWith(CREATOR);
  });

  it("supporter insert failure -> warn-logged but tip still succeeds (best-effort logging)", async () => {
    insertCreatorSupporterMock.mockRejectedValue(new Error("supabase down"));
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    // Despite the supabase failure, the tip success toast still fired
    expect(toastSuccessMock).toHaveBeenCalledWith("Tip sent!");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("broadcastAction fires for BOTH 'balance_changed' AND 'activity_added'", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("invalidateBalanceQueries fires on success", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("success toast 'Tip sent!' fires", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Tip sent!");
  });
});

// ----- isTipping state ----- //

describe("useTipCreator — isTipping state machine (§15.x)", () => {
  it("isTipping flips true during in-flight + false after success", async () => {
    let resolveSupport: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValue(
      new Promise((res) => {
        resolveSupport = res;
      }),
    );
    const { result } = renderHook(() => useTipCreator());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.tip(CREATOR, "5", "msg");
    });
    // Wait for state to propagate
    await waitFor(() => {
      expect(result.current.isTipping).toBe(true);
    });
    await act(async () => {
      resolveSupport({
        hash: "0xok",
        receipt: { status: "success", blockNumber: 1n },
      });
      await p;
    });
    expect(result.current.isTipping).toBe(false);
  });

  it("isTipping flips false after thrown error too (finally always clears)", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(result.current.isTipping).toBe(false);
  });
});

// ----- error handling ----- //

describe("useTipCreator — error handling (§15.x)", () => {
  it("allowance error -> clearVaultApproval re-arms gate for next attempt", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
    expect(toastErrorMock).toHaveBeenCalledWith("insufficient allowance");
  });

  it("'transfer amount exceeds' error -> clearVaultApproval fires", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(
      new Error("ERC20: transfer amount exceeds balance"),
    );
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
  });

  it("unrelated error (e.g. 'rpc timeout') -> clearVaultApproval NOT called", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc timeout"));
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith("rpc timeout");
  });

  it("non-Error thrown value -> 'Tip failed' fallback toast", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue("string not error");
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Tip failed");
  });
});

// ----- funding gate ----- //

const SIG = "0xsig" as const;
const TIP_ID = 7n;
const SCOPE = { kind: "tip", chainId: 11155111, contract: HUB, account: ME } as const;
const padId = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const pendingLog = (id: bigint) => ({
  address: HUB,
  topics: [PENDING_EVENT_TOPIC.tip, padId(id)],
  data: "0x",
});
const HANDLE_HEX = `0x${"ab".repeat(32)}`;

/** Upgraded CreatorHub: status 1 Pending, 2 Confirmed, 3 Voided. confirmFunding moves it. */
function gatedHub(over: { status?: number; nextTipId?: bigint; logs?: unknown[] } = {}) {
  const chain = { status: over.status ?? 1, nextTipId: over.nextTipId ?? TIP_ID + 1n };
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "nextTipId") return chain.nextTipId;
    if (functionName === "getTip") return [ME, CREATOR, VAULT, chain.status];
    if (functionName === "getTipFundedHandle") return HANDLE_HEX;
    throw new Error(`unexpected read ${functionName}`);
  });
  unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string; args: unknown[] }) => {
    if (args.functionName === "confirmFunding") {
      chain.status = args.args[1] ? 2 : 3;
      return { hash: "0xconfirm", receipt: { status: "success", blockNumber: 13000n, logs: [] } };
    }
    return {
      hash: "0xtxhash",
      receipt: { status: "success", blockNumber: 12345n, logs: over.logs ?? [pendingLog(TIP_ID)] },
    };
  });
  return chain;
}

const confirmCalls = () => unifiedWriteAndWaitMock.mock.calls.filter((c) => c[0].functionName === "confirmFunding");

describe("useTipCreator — funding gate, funded tip", () => {
  it("confirms the tip with the decrypted bit, then records the supporter", async () => {
    gatedHub();
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "great stream");
    });
    expect(outcome).toBe("confirmed");
    const confirm = confirmCalls();
    expect(confirm).toHaveLength(1);
    expect(confirm[0][0].address).toBe(HUB);
    expect(confirm[0][0].args).toEqual([TIP_ID, true, SIG]);
    expect(confirm[0][0].gas).toBe(1_500_000n);
    // The handle is declared bytes32 (a hex string from viem) and decryptForTx wants a bigint.
    expect(decryptForTxMock).toHaveBeenCalledWith(BigInt(HANDLE_HEX), "ebool");
    expect(insertActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ tx_hash: "0xtxhash", block_number: 12345, note: "great stream" }),
    );
    expect(insertCreatorSupporterMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith("Tip sent!", expect.anything());
    expect(listPendingFundings(SCOPE)).toHaveLength(0);
  });

  it("records nothing before the confirmation lands", async () => {
    gatedHub();
    let release: (v: unknown) => void = () => {};
    decryptForTxMock.mockReturnValue(new Promise((r) => { release = r; }));
    const { result } = renderHook(() => useTipCreator());
    let p!: Promise<unknown>;
    act(() => { p = result.current.tip(CREATOR, "5", "msg"); });
    await waitFor(() => expect(decryptForTxMock).toHaveBeenCalled());
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(toastSuccessMock).not.toHaveBeenCalledWith("Tip sent!", expect.anything());
    await act(async () => {
      release({ decryptedValue: true, signature: SIG });
      await p;
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("reads the tip id from nextTipId - 1 when the receipt carries no TipPending log", async () => {
    gatedHub({ logs: [], nextTipId: 9n });
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(confirmCalls()[0][0].args[0]).toBe(8n);
  });

  it("someone else already confirmed it: nothing is sent, the tip still counts", async () => {
    const chain = gatedHub();
    decryptForTxMock.mockImplementation(async () => {
      chain.status = 2;
      return { decryptedValue: true, signature: SIG };
    });
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "msg");
    });
    expect(outcome).toBe("confirmed");
    expect(confirmCalls()).toHaveLength(0);
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });
});

describe("useTipCreator — funding gate, unfunded tip", () => {
  it("voids the tip: honest toast, no supporter, no activity, approval re-armed", async () => {
    gatedHub();
    decryptForTxMock.mockResolvedValue({ decryptedValue: false, signature: SIG });
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "msg");
    });
    expect(outcome).toBe("voided");
    expect(confirmCalls()[0][0].args).toEqual([TIP_ID, false, SIG]);
    expect(toastErrorMock).toHaveBeenCalledWith("Tip did not go through: balance too low", expect.anything());
    expect(toastSuccessMock).not.toHaveBeenCalledWith("Tip sent!", expect.anything());
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(insertCreatorSupporterMock).toHaveBeenCalledTimes(0);
    expect(recomputeCreatorSupporterCountMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
    expect(listPendingFundings(SCOPE)).toHaveLength(0);
  });
});

describe("useTipCreator — funding gate, second step does not finish", () => {
  it("decrypt never ready: tip stays pending, recorded nowhere, retry entry kept", async () => {
    gatedHub();
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "msg");
    });
    expect(outcome).toBe("pending");
    expect(confirmCalls()).toHaveLength(0);
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(toastSuccessMock).not.toHaveBeenCalledWith("Tip sent!", expect.anything());
    const msg = toastErrorMock.mock.calls.at(-1)![0] as string;
    expect(msg).toMatch(/not ready yet/);
    expect(msg).toMatch(/not counted yet/);
    expect(result.current.pendingTipCount).toBe(1);
    const entries = listPendingFundings(SCOPE);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("7");
    expect(entries[0].data).toMatchObject({ creator: CREATOR, message: "msg", hash: "0xtxhash", blockNumber: "12345" });
  });

  it("confirm keeps failing: the real reason reaches the toast and the tip stays recoverable", async () => {
    gatedHub();
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "confirmFunding") throw new Error("rpc: nonce too low");
      return { hash: "0xtxhash", receipt: { status: "success", blockNumber: 12345n, logs: [pendingLog(TIP_ID)] } };
    });
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "msg");
    });
    expect(outcome).toBe("pending");
    expect(toastErrorMock.mock.calls.at(-1)![0]).toMatch(/rpc: nonce too low/);
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(listPendingFundings(SCOPE)).toHaveLength(1);
  });

  it("a reverted confirmation is an error, never a success", async () => {
    gatedHub();
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) =>
      args.functionName === "confirmFunding"
        ? { hash: "0xconfirm", receipt: { status: "reverted", blockNumber: 2n, logs: [] } }
        : { hash: "0xtxhash", receipt: { status: "success", blockNumber: 12345n, logs: [pendingLog(TIP_ID)] } },
    );
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "msg");
    });
    expect(outcome).toBe("pending");
    expect(toastErrorMock.mock.calls.at(-1)![0]).toMatch(/reverted/);
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("finishPendingTips completes a tip left pending, with the original tx hash", async () => {
    const chain = gatedHub();
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "5", "msg");
    });
    expect(chain.status).toBe(1);

    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    let counted = 0;
    await act(async () => {
      counted = await result.current.finishPendingTips();
    });
    expect(counted).toBe(1);
    expect(confirmCalls()).toHaveLength(1);
    expect(insertActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ tx_hash: "0xtxhash", block_number: 12345, user_to: CREATOR.toLowerCase() }),
    );
    expect(result.current.pendingTipCount).toBe(0);
  });

  it("a tip voided while the tab was closed records nothing and clears the entry on the next visit", async () => {
    gatedHub({ status: 3 });
    addPendingFunding(SCOPE, 7n, { creator: CREATOR, message: "msg", hash: "0xold", blockNumber: "5" });
    const { result } = renderHook(() => useTipCreator());
    await waitFor(() => expect(result.current.pendingTipCount).toBe(0));
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith("A tip did not go through: balance too low");
  });

  it("a tip confirmed by someone else while the tab was closed is recorded on the next visit", async () => {
    gatedHub({ status: 2 });
    addPendingFunding(SCOPE, 7n, { creator: CREATOR, message: "hello", hash: "0xold", blockNumber: "5" });
    const { result } = renderHook(() => useTipCreator());
    await waitFor(() => expect(insertActivityMock).toHaveBeenCalledTimes(1));
    expect(insertActivityMock).toHaveBeenCalledWith(expect.objectContaining({ tx_hash: "0xold", block_number: 5 }));
    expect(confirmCalls()).toHaveLength(0);
    await waitFor(() => expect(result.current.pendingTipCount).toBe(0));
  });

  it("does not resume while the FHE session is not connected", async () => {
    gatedHub();
    useCofheConnectionMock.mockReturnValue({ connected: false });
    addPendingFunding(SCOPE, 7n, { creator: CREATOR, message: "m", hash: "0xold", blockNumber: "5" });
    const { result } = renderHook(() => useTipCreator());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.pendingTipCount).toBe(1);
    expect(decryptForTxMock).not.toHaveBeenCalled();
  });
});

describe("useTipCreator — pre-gate contract fallback", () => {
  it("no nextTipId: single step, records straight away, never touches the gate", async () => {
    // readContract rejects by default (pre-gate CreatorHub).
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "msg");
    });
    expect(outcome).toBe("confirmed");
    expect(decryptForTxMock).not.toHaveBeenCalled();
    expect(confirmCalls()).toHaveLength(0);
    expect(readContractMock.mock.calls.every((c) => c[0].functionName === "nextTipId")).toBe(true);
    expect(toastSuccessMock).toHaveBeenCalledWith("Tip sent!");
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("probe fails transiently on an upgraded contract: the TipPending log still routes to the gate", async () => {
    const chain = gatedHub();
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "nextTipId") throw new Error("rpc busy");
      if (functionName === "getTip") return [ME, CREATOR, VAULT, chain.status];
      return HANDLE_HEX;
    });
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "msg");
    });
    expect(outcome).toBe("confirmed");
    expect(confirmCalls()).toHaveLength(1);
  });

  it("tip returns failed when the write throws", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc timeout"));
    const { result } = renderHook(() => useTipCreator());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.tip(CREATOR, "5", "msg");
    });
    expect(outcome).toBe("failed");
  });
});
