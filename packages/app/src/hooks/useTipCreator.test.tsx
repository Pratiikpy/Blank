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

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheConnection: useCofheConnectionMock,
  useCofheEncrypt: useCofheEncryptMock,
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
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), debug: vi.fn() } }));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useTipCreator } from "./useTipCreator";

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
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    getTransactionReceipt: getTransactionReceiptMock,
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
  encryptInputsAsyncMock.mockResolvedValue([
    { ctHash: 0x42n, securityZone: 0, utype: 5, signature: "0xabc" },
  ]);
});

// ----- initial state ----- //

describe("useTipCreator — initial state (§15.x)", () => {
  it("returns { isTipping: false, tip: fn } on mount", () => {
    const { result } = renderHook(() => useTipCreator());
    expect(result.current.isTipping).toBe(false);
    expect(typeof result.current.tip).toBe("function");
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

  it("cofhe not connected -> early return", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
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

describe("useTipCreator — SDK output normalization (§15.x)", () => {
  it("top-level shape: ctHash + signature passed through as-is", async () => {
    encryptInputsAsyncMock.mockResolvedValue([
      {
        ctHash: 0x42n,
        securityZone: 1,
        utype: 5,
        signature: "0xtoplevel",
      },
    ]);
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    const args = unifiedWriteAndWaitMock.mock.calls[0][0];
    const encInput = args.args[2] as {
      ctHash: bigint;
      securityZone: number;
      utype: number;
      signature: string;
    };
    expect(encInput.ctHash).toBe(0x42n);
    expect(encInput.securityZone).toBe(1);
    expect(encInput.utype).toBe(5);
    expect(encInput.signature).toBe("0xtoplevel");
  });

  it("nested .data shape: ctHash + signature lifted from raw.data to top level", async () => {
    encryptInputsAsyncMock.mockResolvedValue([
      {
        // top level intentionally empty
        data: {
          ctHash: 0x99n,
          securityZone: 2,
          utype: 5,
          signature: "0xnested",
        },
      },
    ]);
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    const args = unifiedWriteAndWaitMock.mock.calls[0][0];
    const encInput = args.args[2] as {
      ctHash: bigint;
      securityZone: number;
      utype: number;
      signature: string;
    };
    expect(encInput.ctHash).toBe(0x99n);
    expect(encInput.securityZone).toBe(2);
    expect(encInput.signature).toBe("0xnested");
  });

  it("neither path set -> defaults: ctHash=0n, signature='0x', utype=5 (defensive)", async () => {
    encryptInputsAsyncMock.mockResolvedValue([{}]);
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "10", "thanks");
    });
    const args = unifiedWriteAndWaitMock.mock.calls[0][0];
    const encInput = args.args[2] as {
      ctHash: bigint;
      securityZone: number;
      utype: number;
      signature: string;
    };
    expect(encInput.ctHash).toBe(0n);
    expect(encInput.utype).toBe(5);
    expect(encInput.signature).toBe("0x");
  });

  it("encryptInputsAsync called with Encryptable.uint64(parseUnits(amount, 6))", async () => {
    const { result } = renderHook(() => useTipCreator());
    await act(async () => {
      await result.current.tip(CREATOR, "1.5", "thanks");
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(1);
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr).toHaveLength(1);
    // parseUnits("1.5", 6) === 1_500_000n
    expect(arr[0].raw).toBe(1_500_000n);
  });
});

// ----- support call ----- //

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
    expect(args.args[3]).toBe("great work");
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
