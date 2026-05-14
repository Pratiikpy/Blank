import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useEncryptedEscrow. Wave 4 #249 fully-encrypted escrow
// hook. Replaces the plaintext-storage path in BusinessHub.escrow for
// new escrows; existing BusinessHub escrows keep using useBusinessHub.
//
// CRITICAL pins:
//   - §3.17 split guards: createEscrow uses guardReady (requires cofhe
//     connected), plaintext-only ops (arbiterDecide, markDelivered,
//     approveRelease, disputeEscrow, claimExpiredEscrow) use
//     guardWalletReady (skip cofhe-connect requirement). Without this
//     split an arbiter clicking "Release to Beneficiary" before cofhe
//     finished its background handshake would see "Wallet not connected"
//     even though their wallet IS connected — confusing UI.
//   - §3.15 fail-fast pre-encryption validation. Mirrors contract
//     require() statements so users don't lose 30s of FHE work on a
//     guaranteed-revert input. 4 branches: beneficiary === zero-addr,
//     beneficiary === sender, vault === zero-addr, deadline < now+86400,
//     description > 512 chars.
//   - §3.4 ensureVaultApproval uses unifiedWriteAndWait (NOT
//     unifiedWrite) so the approval receipt mines BEFORE
//     markVaultApproved caches. Pre-fix race left allowance still
//     pending while the createEscrow tx fired, reverting on insufficient
//     allowance. The AndWait fix is the load-bearing invariant.
//   - §3.10 receipt-path discrimination: AA path returns wr.receipt with
//     logs ready — skip the "confirming" pipeline step (no extra RPC).
//     EOA path has no receipt — fall through to
//     publicClient.waitForTransactionReceipt + flash pipeline.markConfirming.
//   - §3.13 callSimple preserves lastEscrowId across invocations via
//     setState((prev) => ({ ...prev, ... })). Without spread, calling
//     markDelivered after createEscrow would clear the lastEscrowId
//     state and lose the link to the just-created escrow in the UI.
//   - §3.11 error state preserves prev.txHash so the failed tx is still
//     linkable to the explorer (debugging affordance). Same on
//     createEscrow + callSimple error paths.
//   - §3.7 callSimple uses a FRIENDLY_LABEL map for toasts:
//     markDelivered -> "Delivery marked", arbiterDecide -> "Arbiter
//     decision recorded", etc. Raw function names would leak
//     implementation detail to users.
//   - §3.12 txExplorerUrl derived from state.txHash + activeChainId.
//     Null when no tx hash. UI uses this directly without re-deriving.
//   - extractEventId returns the on-chain escrow id from event logs.
//     If null, the tx mined but we couldn't read the id — throw with a
//     helpful message rather than fail silently.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useFhePipelineMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const extractEventIdMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("./useFhePipeline", () => ({ useFhePipeline: useFhePipelineMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheConnection: useCofheConnectionMock,
  useCofheEncrypt: useCofheEncryptMock,
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/abis", () => ({ EncryptedEscrowAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
}));
vi.mock("@/lib/event-parser", () => ({ extractEventId: extractEventIdMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useEncryptedEscrow } from "./useEncryptedEscrow";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ARBITER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const EE_ADDR = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

const encryptInputsAsyncMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const onEncryptStepMock = vi.fn();
const markSubmittingMock = vi.fn();
const markConfirmingMock = vi.fn();
const markDoneMock = vi.fn();
const markFailedMock = vi.fn();
const startMock = vi.fn();
const pipelineResetMock = vi.fn();

function defaultParams(over: Record<string, unknown> = {}) {
  return {
    beneficiary: ALICE,
    vault: VAULT,
    amountTokens: "100",
    decimals: 6,
    description: "Test escrow",
    arbiter: ARBITER,
    deadlineSeconds: Math.floor(Date.now() / 1000) + 7 * 86400,
    ...over,
  };
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useFhePipelineMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheEncryptMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  extractEventIdMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  onEncryptStepMock.mockReset();
  markSubmittingMock.mockReset();
  markConfirmingMock.mockReset();
  markDoneMock.mockReset();
  markFailedMock.mockReset();
  startMock.mockReset();
  pipelineResetMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { EncryptedEscrow: EE_ADDR },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useFhePipelineMock.mockReturnValue({
    state: { currentIndex: -1, phase: "idle", error: null },
    start: startMock,
    onEncryptStep: onEncryptStepMock,
    markSubmitting: markSubmittingMock,
    markConfirming: markConfirmingMock,
    markDone: markDoneMock,
    markFailed: markFailedMock,
    reset: pipelineResetMock,
  });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useCofheEncryptMock.mockReturnValue({ encryptInputsAsync: encryptInputsAsyncMock });
  encryptInputsAsyncMock.mockResolvedValue([
    { ctHash: 0x42n, securityZone: 0, utype: 5, signature: "0xenc" },
  ]);
  toastLoadingMock.mockReturnValue("toast-id");
  isVaultApprovedMock.mockReturnValue(true);
  extractEventIdMock.mockReturnValue(7);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: { status: "success", blockNumber: 1n, logs: [] },
  });
});

// ───────────────────────────────────────────────────────────
//  Initial state + return shape
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — initial state (§15.x)", () => {
  it("returns idle state + null txExplorerUrl + 5 callsable handlers", () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    expect(result.current.state.step).toBe("idle");
    expect(result.current.state.isProcessing).toBe(false);
    expect(result.current.state.txHash).toBeNull();
    expect(result.current.state.lastEscrowId).toBeNull();
    expect(result.current.txExplorerUrl).toBeNull();
    expect(typeof result.current.createEscrow).toBe("function");
    expect(typeof result.current.markDelivered).toBe("function");
    expect(typeof result.current.approveRelease).toBe("function");
    expect(typeof result.current.disputeEscrow).toBe("function");
    expect(typeof result.current.claimExpiredEscrow).toBe("function");
    expect(typeof result.current.arbiterDecide).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.17 split guards: createEscrow (encrypt-required)
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — guardReady (createEscrow) (§15.x)", () => {
  it("no address -> 'Wallet not connected' toast + null return", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useEncryptedEscrow());
    let r: number | null = null;
    await act(async () => {
      r = await result.current.createEscrow(defaultParams());
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
  });

  it("cofhe NOT connected -> 'Wallet not connected' toast (createEscrow needs encrypt)", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useEncryptedEscrow());
    let r: number | null = null;
    await act(async () => {
      r = await result.current.createEscrow(defaultParams());
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
  });

  it("EncryptedEscrow not deployed (zero addr) -> distinct toast", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { EncryptedEscrow: ZERO_ADDR },
    });
    const { result } = renderHook(() => useEncryptedEscrow());
    let r: number | null = null;
    await act(async () => {
      r = await result.current.createEscrow(defaultParams());
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "EncryptedEscrow not deployed on this chain yet",
    );
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useEncryptedEscrow());
    let r: number | null = null;
    await act(async () => {
      r = await result.current.createEscrow(defaultParams());
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost. Please refresh.");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.17 split guards: callSimple (wallet-only)
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — guardWalletReady (callSimple) (§15.x)", () => {
  it("cofhe NOT connected -> arbiterDecide STILL WORKS (plaintext-only path)", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useEncryptedEscrow());
    let ok = false;
    await act(async () => {
      ok = await result.current.arbiterDecide(5, true);
    });
    expect(ok).toBe(true);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("arbiterDecide");
    expect(call.args).toEqual([5n, true]);
  });

  it("cofhe NOT connected -> markDelivered STILL WORKS", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useEncryptedEscrow());
    let ok = false;
    await act(async () => {
      ok = await result.current.markDelivered(3);
    });
    expect(ok).toBe(true);
  });

  it("no wallet -> callSimple returns false + 'Wallet not connected' toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useEncryptedEscrow());
    let ok = true;
    await act(async () => {
      ok = await result.current.markDelivered(1);
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
  });

  it("EncryptedEscrow not deployed -> callSimple returns false", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { EncryptedEscrow: ZERO_ADDR },
    });
    const { result } = renderHook(() => useEncryptedEscrow());
    let ok = true;
    await act(async () => {
      ok = await result.current.approveRelease(1);
    });
    expect(ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  §3.15 pre-encryption validation
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — §3.15 pre-encryption validation (§15.x)", () => {
  it("beneficiary === zero-addr -> rejected before encrypt fires", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams({ beneficiary: ZERO_ADDR }));
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Beneficiary must be a different address from yours.",
    );
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("beneficiary === sender (case-INsensitive) -> rejected before encrypt", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(
        defaultParams({
          beneficiary: ME.toUpperCase().replace("0X", "0x"),
        }),
      );
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Beneficiary must be a different address from yours.",
    );
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("vault === zero-addr -> 'Vault address required' toast", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams({ vault: ZERO_ADDR }));
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Vault address required.");
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("deadline < now+86400 -> 'at least 1 day from now' toast", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(
        defaultParams({ deadlineSeconds: Math.floor(Date.now() / 1000) + 3600 }),
      );
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Escrow deadline must be at least 1 day from now.",
    );
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("description > 512 chars -> 'must be 512 or fewer' toast", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(
        defaultParams({ description: "x".repeat(513) }),
      );
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Description must be 512 characters or fewer.",
    );
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("description exactly 512 chars -> passes (boundary)", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(
        defaultParams({ description: "x".repeat(512) }),
      );
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  §3.4 ensureVaultApproval AndWait race fix
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — §3.4 vault approval (§15.x)", () => {
  it("first call: approves via unifiedWriteAndWait (NOT unifiedWrite) + markVaultApproved", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    // FIRST call to unifiedWriteAndWait should be the approval
    const approveCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
    expect(approveCall.address).toBe(VAULT);
    expect(approveCall.args[0]).toBe(EE_ADDR);
    // MAX_UINT64 from constants
    expect(approveCall.args[1]).toBe(BigInt("18446744073709551615"));
    expect(markVaultApprovedMock).toHaveBeenCalledWith(EE_ADDR);
  });

  it("pre-approved -> approval skipped, only createEscrow tx fires", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("createEscrow");
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval failure -> toast + throws + createEscrow tx NOT fired", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    let callCount = 0;
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      callCount += 1;
      if (args.functionName === "approvePlaintext") {
        throw new Error("approve reverted");
      }
      return { hash: "0x", receipt: { status: "success", logs: [] } };
    });
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(callCount).toBe(1);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Approval failed",
      expect.objectContaining({ id: "toast-id" }),
    );
  });
});

// ───────────────────────────────────────────────────────────
//  createEscrow happy path
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — createEscrow happy path (§15.x)", () => {
  it("calls createEscrow with (beneficiary, vault, encAmount, description, arbiter, deadline)", async () => {
    const params = defaultParams({ description: "Build website" });
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(params);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("createEscrow");
    expect(call.address).toBe(EE_ADDR);
    expect(call.args[0]).toBe(ALICE);
    expect(call.args[1]).toBe(VAULT);
    expect(call.args[3]).toBe("Build website");
    expect(call.args[4]).toBe(ARBITER);
    expect(call.args[5]).toBe(BigInt(params.deadlineSeconds));
    expect(call.gas).toBe(5_000_000n);
  });

  it("parseUnits applied to amountTokens with provided decimals", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(
        defaultParams({ amountTokens: "1.5", decimals: 6 }),
      );
    });
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(1_500_000n);
  });

  it("returns escrow id from extractEventId on success", async () => {
    extractEventIdMock.mockReturnValue(42);
    const { result } = renderHook(() => useEncryptedEscrow());
    let id: number | null = null;
    await act(async () => {
      id = await result.current.createEscrow(defaultParams());
    });
    expect(id).toBe(42);
    expect(result.current.state.step).toBe("success");
    expect(result.current.state.lastEscrowId).toBe(42);
    expect(result.current.state.txHash).toBe("0xtxhash");
  });

  it("invalidateBalanceQueries fires on success", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("pipeline lifecycle: start -> onEncryptStep passed -> markSubmitting -> markDone", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(startMock).toHaveBeenCalled();
    // The pipeline's onEncryptStep is passed to encryptInputsAsync as 2nd arg
    const encArgs = encryptInputsAsyncMock.mock.calls[0];
    expect(encArgs[1]).toBe(onEncryptStepMock);
    expect(markSubmittingMock).toHaveBeenCalled();
    expect(markDoneMock).toHaveBeenCalled();
  });

  it("step transitions: approving -> encrypting -> sending -> success", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.state.step).toBe("success");
  });

  it("extractEventId returns null -> throw 'escrowId could not be read'", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useEncryptedEscrow());
    let id: number | null = 0;
    await act(async () => {
      id = await result.current.createEscrow(defaultParams());
    });
    expect(id).toBeNull();
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("escrowId could not be read");
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("escrowId could not be read"),
    );
  });
});

// ───────────────────────────────────────────────────────────
//  §3.10 receipt-path discrimination
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — §3.10 receipt path (§15.x)", () => {
  it("AA path: wr.receipt present -> SKIPS markConfirming + waitForTransactionReceipt", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xaa",
      receipt: { status: "success", logs: [{ topics: [] }] },
    });
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(0);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("EOA path: wr.receipt missing -> markConfirming fires + waitForTransactionReceipt polled", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xeoa",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "success",
      logs: [],
    });
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
    });
  });

  it("EOA path reverted -> throws 'createEscrow reverted'", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      logs: [],
    });
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("createEscrow reverted");
  });
});

// ───────────────────────────────────────────────────────────
//  createEscrow error path
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — createEscrow error path (§15.x)", () => {
  it("write rejection -> step=error + markFailed pipeline + toast", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("user rejected");
    expect(markFailedMock).toHaveBeenCalledWith(expect.any(Error));
    expect(toastErrorMock).toHaveBeenCalledWith("user rejected");
  });

  it("non-Error throw -> String(err) captured into state.error", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue("plain-string");
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.state.error).toBe("plain-string");
  });

  it("error path returns null", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("fail"));
    const { result } = renderHook(() => useEncryptedEscrow());
    let id: number | null = 0;
    await act(async () => {
      id = await result.current.createEscrow(defaultParams());
    });
    expect(id).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  callSimple: all 5 plaintext ops
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — callSimple plaintext ops (§15.x)", () => {
  it("markDelivered(id) calls markDelivered with BigInt(id)", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.markDelivered(11);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("markDelivered");
    expect(call.args).toEqual([11n]);
    expect(call.gas).toBe(5_000_000n);
  });

  it("approveRelease(id) -> approveRelease + 'Release approved' toast", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.approveRelease(22);
    });
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe(
      "approveRelease",
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Release approved");
  });

  it("disputeEscrow -> 'Dispute opened' friendly label", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.disputeEscrow(3);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Dispute opened");
  });

  it("claimExpiredEscrow -> 'Escrow refunded after deadline' label", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.claimExpiredEscrow(4);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Escrow refunded after deadline",
    );
  });

  it("arbiterDecide(id, true) -> arbiterDecide with (BigInt id, true)", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.arbiterDecide(5, true);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("arbiterDecide");
    expect(call.args).toEqual([5n, true]);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Arbiter decision recorded",
    );
  });

  it("arbiterDecide(id, false) -> passes false through", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.arbiterDecide(5, false);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.args).toEqual([5n, false]);
  });

  it("§3.13 callSimple PRESERVES lastEscrowId across invocations", async () => {
    // First create an escrow to set lastEscrowId=7
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.state.lastEscrowId).toBe(7);
    // Now call markDelivered — lastEscrowId must SURVIVE
    await act(async () => {
      await result.current.markDelivered(7);
    });
    expect(result.current.state.lastEscrowId).toBe(7);
    expect(result.current.state.step).toBe("success");
  });

  it("callSimple write rejection -> returns false + state.step='error'", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rejected"));
    const { result } = renderHook(() => useEncryptedEscrow());
    let ok = true;
    await act(async () => {
      ok = await result.current.markDelivered(1);
    });
    expect(ok).toBe(false);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("rejected");
    expect(toastErrorMock).toHaveBeenCalledWith("rejected");
  });

  it("§3.11 callSimple error path preserves prev state (defensive)", async () => {
    // Successful createEscrow sets txHash=0xtxhash, lastEscrowId=7
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.state.txHash).toBe("0xtxhash");
    // Now markDelivered fails — txHash + lastEscrowId still readable
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("fail"));
    await act(async () => {
      await result.current.markDelivered(7);
    });
    expect(result.current.state.txHash).toBe("0xtxhash"); // preserved
    expect(result.current.state.lastEscrowId).toBe(7); // preserved
    expect(result.current.state.step).toBe("error");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.12 txExplorerUrl derived
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — §3.12 txExplorerUrl (§15.x)", () => {
  it("null when no tx hash", () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    expect(result.current.txExplorerUrl).toBeNull();
  });

  it("after successful createEscrow -> URL contains the tx hash", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.txExplorerUrl).not.toBeNull();
    expect(result.current.txExplorerUrl).toContain("0xtxhash");
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — reset (§15.x)", () => {
  it("reset clears state back to idle + calls pipeline.reset", async () => {
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.state.step).toBe("success");
    act(() => result.current.reset());
    expect(result.current.state.step).toBe("idle");
    expect(result.current.state.txHash).toBeNull();
    expect(result.current.state.lastEscrowId).toBeNull();
    expect(pipelineResetMock).toHaveBeenCalledTimes(1);
  });

  it("reset after error -> clean state", async () => {
    unifiedWriteAndWaitMock.mockRejectedValueOnce(new Error("fail"));
    const { result } = renderHook(() => useEncryptedEscrow());
    await act(async () => {
      await result.current.createEscrow(defaultParams());
    });
    expect(result.current.state.step).toBe("error");
    act(() => result.current.reset());
    expect(result.current.state.step).toBe("idle");
    expect(result.current.state.error).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Concurrent invocation guard via isProcessing
// ───────────────────────────────────────────────────────────

describe("useEncryptedEscrow — concurrent-invocation guard (§15.x)", () => {
  it("second call while first is in-flight -> short-circuits via state.isProcessing", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useEncryptedEscrow());
    let p1!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.createEscrow(defaultParams());
      // Let the first call set isProcessing=true
      await Promise.resolve();
    });
    // Second call immediately
    let secondResult: number | null = 0;
    await act(async () => {
      secondResult = await result.current.createEscrow(
        defaultParams({ description: "second" }),
      );
    });
    // Second call should have returned null without firing a second tx
    expect(secondResult).toBeNull();
    // Resolve the first call so the test cleans up
    resolveFirst({
      hash: "0x",
      receipt: { status: "success", logs: [] },
    });
    await act(async () => {
      await p1;
    });
  });
});
