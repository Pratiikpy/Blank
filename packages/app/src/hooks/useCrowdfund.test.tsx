import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useCrowdfund. Wave 4 #257 EncryptedCrowdfund hook.
// Mirrors useEncryptedEscrow shape — same split-guard / approval-cache /
// receipt-path / state-preservation invariants, plus contribute() and
// publishCloseResult() which are unique to crowdfund.
//
// CRITICAL pins:
//   - §3.17 split guards: createCampaign + contribute use guardReady
//     (need cofhe for FHE encryption); closeCampaign + claimRelease +
//     claimRefund + publishCloseResult use guardWalletReady (plaintext-
//     only). A backer clicking Refund before cofhe handshake completed
//     should NOT see "Wallet not connected" — they're refunding, no
//     encryption needed.
//   - §3.4 ensureVaultApproval uses unifiedWriteAndWait so the approval
//     receipt mines BEFORE markVaultApproved caches. Pre-fix race left
//     allowance pending while createCampaign/contribute fired, reverting
//     on insufficient allowance.
//   - §3.10 receipt-path discrimination on createCampaign only (it needs
//     event logs to extract the campaign id). contribute SKIPS the
//     receipt-flash because unifiedWriteAndWait already settled and no
//     event id is needed (returns boolean success).
//   - §3.13 callSimple preserves lastCampaignId across invocations via
//     setState((prev) => ({ ...prev, ... })). After createCampaign sets
//     lastCampaignId=42, closeCampaign(42) MUST keep that 42 visible
//     for the UI's "View campaign #42" link.
//   - §3.11 error state preserves prev.txHash + lastCampaignId so the
//     UI still shows the campaign link and a failed tx is still
//     linkable to the explorer.
//   - §3.7 callSimple uses FRIENDLY_LABEL map: closeCampaign -> "Campaign
//     closed", claimRelease -> "Funds released", claimRefund -> "Refund
//     claimed". Raw function names leak implementation detail.
//   - §3.2 publishCloseResult distinct toast copy keyed on the plaintext
//     boolean: true -> "Goal verdict: success published"; false ->
//     "Goal verdict: not met published". The user needs to see WHICH
//     verdict went on-chain since plaintext+signature came from
//     off-chain decrypt and the user could have rotated the verdict.
//   - claimRefund passes TWO args (campaignId, contributionIndex) — the
//     contract needs the per-contribution index because a backer can
//     contribute N times to the same campaign and each contribution is
//     refundable independently. Other callSimple ops take one id arg.

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
vi.mock("@/lib/abis", () => ({ EncryptedCrowdfundAbi: [], FHERC20VaultAbi: [] }));
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

import { useCrowdfund } from "./useCrowdfund";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const CF_ADDR = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
const CID_HASH = ("0x" + "cd".repeat(32)) as `0x${string}`;
const SIGNATURE = ("0x" + "01".repeat(65)) as `0x${string}`;

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

function createParams(over: Record<string, unknown> = {}) {
  return {
    vault: VAULT,
    goalTokens: "1000",
    decimals: 6,
    durationSeconds: 7 * 86400,
    title: "Test campaign",
    descriptionCidHash: CID_HASH,
    ...over,
  };
}

function contribParams(over: Record<string, unknown> = {}) {
  return {
    campaignId: 7,
    vault: VAULT,
    amountTokens: "100",
    decimals: 6,
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
    contracts: { EncryptedCrowdfund: CF_ADDR },
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
  extractEventIdMock.mockReturnValue(42);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: { status: "success", blockNumber: 1n, logs: [] },
  });
});

// ───────────────────────────────────────────────────────────
//  Initial state + return shape
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — initial state (§15.x)", () => {
  it("returns idle state + null txExplorerUrl + 6 callable handlers", () => {
    const { result } = renderHook(() => useCrowdfund());
    expect(result.current.state.step).toBe("idle");
    expect(result.current.state.isProcessing).toBe(false);
    expect(result.current.state.txHash).toBeNull();
    expect(result.current.state.lastCampaignId).toBeNull();
    expect(result.current.txExplorerUrl).toBeNull();
    expect(typeof result.current.createCampaign).toBe("function");
    expect(typeof result.current.contribute).toBe("function");
    expect(typeof result.current.closeCampaign).toBe("function");
    expect(typeof result.current.publishCloseResult).toBe("function");
    expect(typeof result.current.claimRelease).toBe("function");
    expect(typeof result.current.claimRefund).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.17 split guards
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — guardReady (createCampaign/contribute) (§15.x)", () => {
  it("cofhe NOT connected -> createCampaign rejected", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useCrowdfund());
    let r: number | null = 0;
    await act(async () => {
      r = await result.current.createCampaign(createParams());
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
  });

  it("cofhe NOT connected -> contribute rejected", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useCrowdfund());
    let ok = true;
    await act(async () => {
      ok = await result.current.contribute(contribParams());
    });
    expect(ok).toBe(false);
  });

  it("no address -> 'Wallet not connected' toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
  });

  it("crowdfund not deployed (zero addr) -> distinct toast", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { EncryptedCrowdfund: ZERO_ADDR },
    });
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Crowdfund not deployed on this chain yet",
    );
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost. Please refresh.");
  });
});

describe("useCrowdfund — guardWalletReady (callSimple/publishCloseResult) (§15.x)", () => {
  it("cofhe NOT connected -> closeCampaign STILL WORKS (plaintext path)", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useCrowdfund());
    let ok = false;
    await act(async () => {
      ok = await result.current.closeCampaign(5);
    });
    expect(ok).toBe(true);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalled();
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("closeCampaign");
  });

  it("cofhe NOT connected -> claimRelease STILL WORKS", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useCrowdfund());
    let ok = false;
    await act(async () => {
      ok = await result.current.claimRelease(7);
    });
    expect(ok).toBe(true);
  });

  it("cofhe NOT connected -> claimRefund STILL WORKS (audit invariant)", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useCrowdfund());
    let ok = false;
    await act(async () => {
      ok = await result.current.claimRefund(7, 0);
    });
    expect(ok).toBe(true);
  });

  it("cofhe NOT connected -> publishCloseResult STILL WORKS", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useCrowdfund());
    let ok = false;
    await act(async () => {
      ok = await result.current.publishCloseResult(7, true, SIGNATURE);
    });
    expect(ok).toBe(true);
  });

  it("no wallet -> callSimple returns false + 'Wallet not connected' toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useCrowdfund());
    let ok = true;
    await act(async () => {
      ok = await result.current.closeCampaign(1);
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.4 vault approval
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — §3.4 vault approval (§15.x)", () => {
  it("createCampaign first call: approves via unifiedWriteAndWait + markVaultApproved", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    const approveCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
    expect(approveCall.address).toBe(VAULT);
    expect(approveCall.args[0]).toBe(CF_ADDR);
    expect(approveCall.args[1]).toBe(BigInt("18446744073709551615")); // MAX_UINT64
    expect(markVaultApprovedMock).toHaveBeenCalledWith(CF_ADDR);
  });

  it("contribute first call: also runs the approval flow", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.contribute(contribParams());
    });
    const approveCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
    expect(approveCall.args[0]).toBe(CF_ADDR);
  });

  it("pre-approved -> approval skipped", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("createCampaign");
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval failure -> toast + throws + main tx NOT fired", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "approvePlaintext") {
        throw new Error("approve reverted");
      }
      return { hash: "0x", receipt: { status: "success", logs: [] } };
    });
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Approval failed",
      expect.objectContaining({ id: "toast-id" }),
    );
  });
});

// ───────────────────────────────────────────────────────────
//  createCampaign happy path
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — createCampaign happy path (§15.x)", () => {
  it("calls createCampaign with (vault, encGoal, duration, title, cidHash)", async () => {
    const params = createParams({ title: "Save the otters", goalTokens: "5000" });
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(params);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("createCampaign");
    expect(call.address).toBe(CF_ADDR);
    expect(call.args[0]).toBe(VAULT);
    expect(call.args[2]).toBe(BigInt(params.durationSeconds));
    expect(call.args[3]).toBe("Save the otters");
    expect(call.args[4]).toBe(CID_HASH);
    expect(call.gas).toBe(5_000_000n);
  });

  it("parseUnits applied to goalTokens with provided decimals", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(
        createParams({ goalTokens: "2.5", decimals: 6 }),
      );
    });
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(2_500_000n);
  });

  it("returns campaign id from extractEventId + sets lastCampaignId state", async () => {
    extractEventIdMock.mockReturnValue(99);
    const { result } = renderHook(() => useCrowdfund());
    let id: number | null = null;
    await act(async () => {
      id = await result.current.createCampaign(createParams());
    });
    expect(id).toBe(99);
    expect(result.current.state.lastCampaignId).toBe(99);
    expect(result.current.state.step).toBe("success");
  });

  it("extractEventId returns null -> throws + sets error state", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useCrowdfund());
    let id: number | null = 0;
    await act(async () => {
      id = await result.current.createCampaign(createParams());
    });
    expect(id).toBeNull();
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("campaignId could not be read");
  });

  it("invalidateBalanceQueries + pipeline.markDone fire on success", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
    expect(markDoneMock).toHaveBeenCalledTimes(1);
  });

  it("pipeline fanout: start -> onEncryptStep passed to encrypt -> markSubmitting -> markDone", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(startMock).toHaveBeenCalled();
    expect(encryptInputsAsyncMock.mock.calls[0][1]).toBe(onEncryptStepMock);
    expect(markSubmittingMock).toHaveBeenCalled();
    expect(markDoneMock).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────
//  contribute (encrypt-required, no event id extraction)
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — contribute (§15.x)", () => {
  it("calls contribute with (BigInt(campaignId), encAmount)", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.contribute(contribParams({ campaignId: 42, amountTokens: "50" }));
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("contribute");
    expect(call.args[0]).toBe(42n);
    expect(call.gas).toBe(5_000_000n);
  });

  it("parseUnits applied to amountTokens with provided decimals", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.contribute(
        contribParams({ amountTokens: "0.5", decimals: 6 }),
      );
    });
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(500_000n);
  });

  it("returns true on success + sets lastCampaignId to the campaign contributed to", async () => {
    const { result } = renderHook(() => useCrowdfund());
    let ok = false;
    await act(async () => {
      ok = await result.current.contribute(contribParams({ campaignId: 13 }));
    });
    expect(ok).toBe(true);
    expect(result.current.state.lastCampaignId).toBe(13);
    expect(result.current.state.step).toBe("success");
  });

  it("§3.10 contribute SKIPS markConfirming (no event-id extraction needed)", async () => {
    // Force the EOA path (no receipt on result) to confirm contribute
    // STILL doesn't call markConfirming — unifiedWriteAndWait already
    // settles the receipt for contribute.
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtx",
      receipt: undefined,
    });
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.contribute(contribParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(0);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("contribute write rejection -> returns false + step=error + markFailed pipeline", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("contribute reverted"));
    const { result } = renderHook(() => useCrowdfund());
    let ok = true;
    await act(async () => {
      ok = await result.current.contribute(contribParams());
    });
    expect(ok).toBe(false);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("contribute reverted");
    expect(markFailedMock).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────
//  §3.10 receipt-path on createCampaign
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — §3.10 receipt path (createCampaign) (§15.x)", () => {
  it("AA path: wr.receipt present -> SKIPS markConfirming + waitForTransactionReceipt", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xaa",
      receipt: { status: "success", logs: [] },
    });
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(0);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("EOA path: wr.receipt missing -> markConfirming + waitForTransactionReceipt fire", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xeoa",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "success",
      logs: [],
    });
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
    });
  });

  it("EOA path reverted -> throws 'createCampaign reverted'", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      logs: [],
    });
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("createCampaign reverted");
  });
});

// ───────────────────────────────────────────────────────────
//  callSimple operations
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — callSimple operations (§15.x)", () => {
  it("closeCampaign(id) -> closeCampaign with (BigInt(id)) + 'Campaign closed' toast", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.closeCampaign(11);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("closeCampaign");
    expect(call.args).toEqual([11n]);
    expect(toastSuccessMock).toHaveBeenCalledWith("Campaign closed");
  });

  it("claimRelease(id) -> claimRelease + 'Funds released' toast", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.claimRelease(22);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claimRelease");
    expect(call.args).toEqual([22n]);
    expect(toastSuccessMock).toHaveBeenCalledWith("Funds released");
  });

  it("claimRefund(id, contributionIndex) -> claimRefund with BOTH BigInt args", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.claimRefund(5, 2);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claimRefund");
    expect(call.args).toEqual([5n, 2n]);
    expect(toastSuccessMock).toHaveBeenCalledWith("Refund claimed");
  });

  it("§3.13 callSimple PRESERVES lastCampaignId across invocations", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(result.current.state.lastCampaignId).toBe(7);
    await act(async () => {
      await result.current.closeCampaign(7);
    });
    expect(result.current.state.lastCampaignId).toBe(7);
    expect(result.current.state.step).toBe("success");
  });

  it("callSimple write rejection -> returns false + step=error", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useCrowdfund());
    let ok = true;
    await act(async () => {
      ok = await result.current.closeCampaign(1);
    });
    expect(ok).toBe(false);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("user rejected");
  });

  it("§3.11 callSimple error preserves prev.txHash + lastCampaignId", async () => {
    extractEventIdMock.mockReturnValue(42);
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(result.current.state.txHash).toBe("0xtxhash");
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("fail"));
    await act(async () => {
      await result.current.closeCampaign(42);
    });
    expect(result.current.state.txHash).toBe("0xtxhash"); // preserved
    expect(result.current.state.lastCampaignId).toBe(42); // preserved
    expect(result.current.state.step).toBe("error");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.2 publishCloseResult
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — §3.2 publishCloseResult (§15.x)", () => {
  it("calls publishCloseResult with (BigInt(campaignId), plaintext, signature)", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.publishCloseResult(13, true, SIGNATURE);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("publishCloseResult");
    expect(call.args).toEqual([13n, true, SIGNATURE]);
  });

  it("plaintext=true -> 'Goal verdict: success published' toast", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.publishCloseResult(1, true, SIGNATURE);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Goal verdict: success published",
    );
  });

  it("plaintext=false -> 'Goal verdict: not met published' toast (distinct copy)", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.publishCloseResult(1, false, SIGNATURE);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Goal verdict: not met published",
    );
  });

  it("returns true on success", async () => {
    const { result } = renderHook(() => useCrowdfund());
    let ok = false;
    await act(async () => {
      ok = await result.current.publishCloseResult(1, true, SIGNATURE);
    });
    expect(ok).toBe(true);
    expect(result.current.state.step).toBe("success");
  });

  it("returns false on rejection + sets error state", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("bad signature"));
    const { result } = renderHook(() => useCrowdfund());
    let ok = true;
    await act(async () => {
      ok = await result.current.publishCloseResult(1, true, SIGNATURE);
    });
    expect(ok).toBe(false);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("bad signature");
  });
});

// ───────────────────────────────────────────────────────────
//  Error path + non-Error throws
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — error path (§15.x)", () => {
  it("createCampaign write rejection -> step=error + markFailed pipeline", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rejected"));
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(result.current.state.step).toBe("error");
    expect(markFailedMock).toHaveBeenCalledWith(expect.any(Error));
    expect(toastErrorMock).toHaveBeenCalledWith("rejected");
  });

  it("non-Error throw -> String(err) captured into state.error", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue("plain-string");
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(result.current.state.error).toBe("plain-string");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.12 txExplorerUrl
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — §3.12 txExplorerUrl (§15.x)", () => {
  it("null when no tx hash", () => {
    const { result } = renderHook(() => useCrowdfund());
    expect(result.current.txExplorerUrl).toBeNull();
  });

  it("after successful createCampaign -> URL contains the tx hash", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(result.current.txExplorerUrl).not.toBeNull();
    expect(result.current.txExplorerUrl).toContain("0xtxhash");
  });

  it("after successful contribute -> URL contains the tx hash", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.contribute(contribParams());
    });
    expect(result.current.txExplorerUrl).toContain("0xtxhash");
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — reset (§15.x)", () => {
  it("reset clears state + calls pipeline.reset", async () => {
    const { result } = renderHook(() => useCrowdfund());
    await act(async () => {
      await result.current.createCampaign(createParams());
    });
    expect(result.current.state.step).toBe("success");
    act(() => result.current.reset());
    expect(result.current.state.step).toBe("idle");
    expect(result.current.state.txHash).toBeNull();
    expect(result.current.state.lastCampaignId).toBeNull();
    expect(pipelineResetMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  Concurrent invocation guard
// ───────────────────────────────────────────────────────────

describe("useCrowdfund — concurrent-invocation guard (§15.x)", () => {
  it("second createCampaign while first is in-flight -> short-circuits via state.isProcessing", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useCrowdfund());
    let p1!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.createCampaign(createParams());
      await Promise.resolve();
    });
    let secondResult: number | null = 0;
    await act(async () => {
      secondResult = await result.current.createCampaign(
        createParams({ title: "second" }),
      );
    });
    expect(secondResult).toBeNull();
    resolveFirst({
      hash: "0x",
      receipt: { status: "success", logs: [] },
    });
    await act(async () => {
      await p1;
    });
  });
});
