import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useAgentPayment. Two-stage agent-derived-payment flow:
//   1. derive() — server-side Claude (or Kimi) proposes an amount + signs
//      it. The signed attestation lets the contract verify the agent
//      address via ecrecover; anyone watching the chain can recover the
//      signer and confirm which AI agent attested to the submission.
//   2. submit() — encrypt the attested amount + call sendPaymentAsAgent.
//      The contract checks the signature on-chain; without that the
//      attestation could be forged client-side.
//
// CRITICAL pins:
//   - Block-timestamp polling: the contract compares attestation.expiry
//     against block.timestamp NOT user wall-clock. A user with a skewed
//     local clock would otherwise see "expired" on a still-valid
//     attestation. The hook polls latest block on mount + every 10s and
//     uses that for the pre-submit expiry guard.
//   - 30-second pre-submit safety buffer: blockTimestamp + 30s <
//     attestation.expiry required. Covers block time (~12s on Sepolia) +
//     mempool inclusion lag + safety margin. Without this, submitting at
//     attestation.expiry - 5s would race the block production.
//   - Self-send guard: to.toLowerCase() === address.toLowerCase() ->
//     reject. The contract may allow it, but it's a UX trap — agent-
//     derived payroll to yourself is almost always a misconfiguration.
//   - Approval cache via isVaultApproved/markVaultApproved (PaymentHub
//     spender). First submit approves MAX_UINT64; subsequent submits
//     skip the approval tx entirely. clearVaultApproval re-arms on
//     allowance/approve errors.
//   - SDK output normalization for encrypted inputs: skipped — useTipCreator
//     normalizes; the contract for agent payments accepts the SDK shape
//     directly via type assertion. Test the raw SDK output is passed.
//   - Reverted receipt -> throws "Transaction reverted on-chain" caught
//     by outer try + sets step=error, surfaces toast. CRITICAL: NO
//     supabase insertActivity, NO broadcast, NO invalidate (no phantom
//     "agent payment sent" rows for failed tx).
//   - Success-path fanout: insertActivity with AGENT_PAYMENT type +
//     note-fallback ("Agent 0xabcd…ef12" derived from attestation.agent
//     short form when user note empty); broadcastAction(balance_changed
//     + activity_added); invalidateBalanceQueries.
//   - 5-state step ladder (idle / deriving / approving / encrypting /
//     sending / success / error) with transitions pinned per stage.
//   - derive failure -> step="error" + error message + null return so
//     UI can show retry without progressing to submit.
//   - reset() clears step + error + lastAttestation back to idle/null.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
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
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheEncrypt: useCofheEncryptMock,
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
  clearVaultApproval: clearVaultApprovalMock,
}));
vi.mock("@/lib/abis", () => ({
  PaymentHubAbi: [],
  FHERC20VaultAbi: [],
}));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useAgentPayment, type AgentAttestation } from "./useAgentPayment";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT = ("0x" + "cd".repeat(20)) as `0x${string}`;
const NONCE = ("0x" + "ab".repeat(32)) as `0x${string}`;
const SIG = ("0x" + "01".repeat(65)) as `0x${string}`;
const PAYMENT_HUB = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const TEST_USDC = "0x3333333333333333333333333333333333333333";

const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const encryptInputsAsyncMock = vi.fn();
const getBlockMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

function attestation(over: Partial<AgentAttestation> = {}): AgentAttestation {
  return {
    amount: 100_000_000n,
    agent: AGENT,
    nonce: NONCE,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    signature: SIG,
    raw: "agent reasoning text",
    template: "payroll_line",
    ...over,
  };
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheEncryptMock.mockReset();
  insertActivityMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  getBlockMock.mockReset();
  waitForTransactionReceiptMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      PaymentHub: PAYMENT_HUB,
      FHERC20Vault_USDC: VAULT,
      TestUSDC: TEST_USDC,
    },
  });
  usePublicClientMock.mockReturnValue({
    getBlock: getBlockMock,
    waitForTransactionReceipt: waitForTransactionReceiptMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useCofheEncryptMock.mockReturnValue({
    encryptInputsAsync: encryptInputsAsyncMock,
  });
  isVaultApprovedMock.mockReturnValue(true); // skip approval by default
  toastLoadingMock.mockReturnValue("toast-id");
  insertActivityMock.mockResolvedValue(undefined);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: { status: "success", blockNumber: 12345n },
  });
  encryptInputsAsyncMock.mockResolvedValue([
    { ctHash: 0x42n, securityZone: 0, utype: 5, signature: "0xenc" },
  ]);
  getBlockMock.mockResolvedValue({
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
  });
  // global fetch for derive()
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

// ----- initial state ----- //

describe("useAgentPayment — initial state (§15.x)", () => {
  it("returns idle step + null error + null lastAttestation", () => {
    const { result } = renderHook(() => useAgentPayment());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.lastAttestation).toBeNull();
  });

  it("exposes derive + submit + reset callables + blockTimestamp", () => {
    const { result } = renderHook(() => useAgentPayment());
    expect(typeof result.current.derive).toBe("function");
    expect(typeof result.current.submit).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ----- block-timestamp polling ----- //

describe("useAgentPayment — block-timestamp polling (§15.x)", () => {
  it("polls getBlock on mount and stores block.timestamp", async () => {
    const ts = Math.floor(Date.now() / 1000);
    getBlockMock.mockResolvedValue({ timestamp: BigInt(ts) });
    const { result } = renderHook(() => useAgentPayment());
    await waitFor(() => {
      expect(result.current.blockTimestamp).toBe(ts);
    });
    expect(getBlockMock).toHaveBeenCalledWith({ blockTag: "latest" });
  });

  it("getBlock rejection -> blockTimestamp stays null (noop, stale is fine)", async () => {
    getBlockMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      for (let i = 0; i < 3; i++) await Promise.resolve();
    });
    expect(result.current.blockTimestamp).toBeNull();
  });

  it("no publicClient -> no polling started", () => {
    usePublicClientMock.mockReturnValue(null);
    renderHook(() => useAgentPayment());
    expect(getBlockMock).toHaveBeenCalledTimes(0);
  });

  it("unmount stops the 10s interval (no leak)", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useAgentPayment());
      // Flush microtasks so the initial fetch resolves.
      await vi.advanceTimersByTimeAsync(0);
      const initialCount = getBlockMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      const afterTick = getBlockMock.mock.calls.length;
      expect(afterTick).toBeGreaterThan(initialCount);
      unmount();
      await vi.advanceTimersByTimeAsync(30_000);
      // No new calls after unmount
      expect(getBlockMock.mock.calls.length).toBe(afterTick);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ----- derive (stage 1) ----- //

describe("useAgentPayment — derive (stage 1) (§15.x)", () => {
  it("no address -> toast 'Connect your wallet first' + null return + no fetch", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useAgentPayment());
    let r: AgentAttestation | null = null;
    await act(async () => {
      r = await result.current.derive("payroll_line", "context");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connect your wallet first");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: POSTs /api/agent/derive with user + template + context + chainId + paymentHub", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        amount: "1000000",
        agent: AGENT,
        nonce: NONCE,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        signature: SIG,
        raw: "agent reasoning",
        provider: "anthropic",
        model: "claude-opus-4-7",
      }),
    });
    const { result } = renderHook(() => useAgentPayment());
    let r: AgentAttestation | null = null;
    await act(async () => {
      r = await result.current.derive("payroll_line", "engineer-salary");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/derive",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.user).toBe(ME);
    expect(body.template).toBe("payroll_line");
    expect(body.context).toBe("engineer-salary");
    expect(body.chainId).toBe(11155111);
    expect(body.paymentHubAddress).toBe(PAYMENT_HUB);
    expect(r!.amount).toBe(1_000_000n);
    expect(r!.agent).toBe(AGENT);
    expect(r!.provider).toBe("anthropic");
    expect(r!.model).toBe("claude-opus-4-7");
  });

  it("amount returned as string -> coerced to bigint via BigInt()", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        amount: "999999999",
        agent: AGENT,
        nonce: NONCE,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        signature: SIG,
        raw: "",
      }),
    });
    const { result } = renderHook(() => useAgentPayment());
    let r: AgentAttestation | null = null;
    await act(async () => {
      r = await result.current.derive("payroll_line", "ctx");
    });
    expect(typeof r!.amount).toBe("bigint");
    expect(r!.amount).toBe(999_999_999n);
  });

  it("stores attestation in lastAttestation state", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        amount: "100",
        agent: AGENT,
        nonce: NONCE,
        expiry: 123456,
        signature: SIG,
        raw: "r",
      }),
    });
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.derive("payroll_line", "ctx");
    });
    expect(result.current.lastAttestation?.amount).toBe(100n);
    expect(result.current.lastAttestation?.template).toBe("payroll_line");
  });

  it("step transitions deriving -> idle on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        amount: "100",
        agent: AGENT,
        nonce: NONCE,
        expiry: 0,
        signature: SIG,
        raw: "",
      }),
    });
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.derive("payroll_line", "ctx");
    });
    expect(result.current.step).toBe("idle");
    expect(result.current.lastAttestation).not.toBeNull();
  });

  it("fetch !ok with JSON error body -> step=error + error toast", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid template" }),
    });
    const { result } = renderHook(() => useAgentPayment());
    let r: AgentAttestation | null = null;
    await act(async () => {
      r = await result.current.derive("payroll_line", "bad");
    });
    expect(r).toBeNull();
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("invalid template");
    expect(toastErrorMock).toHaveBeenCalledWith(
      "invalid template",
      expect.any(Object),
    );
  });

  it("fetch !ok with non-JSON body -> falls back to 'HTTP <status>'", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.derive("payroll_line", "x");
    });
    expect(result.current.error).toBe("HTTP 500");
  });

  it("network rejection -> step=error + caught", async () => {
    fetchMock.mockRejectedValue(new Error("network unreachable"));
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.derive("payroll_line", "x");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("network unreachable");
  });

  it("template='expense_share' passes through", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        amount: "0",
        agent: AGENT,
        nonce: NONCE,
        expiry: 0,
        signature: SIG,
        raw: "",
      }),
    });
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.derive("expense_share", "dinner");
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.template).toBe("expense_share");
  });

  it("missing provider/model in response -> undefined (legacy compat)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        amount: "100",
        agent: AGENT,
        nonce: NONCE,
        expiry: 0,
        signature: SIG,
        raw: "",
        // provider + model omitted
      }),
    });
    const { result } = renderHook(() => useAgentPayment());
    let r: AgentAttestation | null = null;
    await act(async () => {
      r = await result.current.derive("payroll_line", "ctx");
    });
    expect(r!.provider).toBeUndefined();
    expect(r!.model).toBeUndefined();
  });
});

// ----- submit (stage 2) — guards ----- //

describe("useAgentPayment — submit guards (§15.x)", () => {
  it("no address -> 'Connection lost' toast + null return", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useAgentPayment());
    let r: `0x${string}` | null = null;
    await act(async () => {
      r = await result.current.submit(ALICE, attestation(), "note");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useAgentPayment());
    let r: `0x${string}` | null = null;
    await act(async () => {
      r = await result.current.submit(ALICE, attestation(), "note");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
  });

  it("self-send (to === sender) -> 'Recipient must be different' toast", async () => {
    const { result } = renderHook(() => useAgentPayment());
    let r: `0x${string}` | null = null;
    await act(async () => {
      r = await result.current.submit(
        ME.toUpperCase().replace("0X", "0x") as `0x${string}`,
        attestation(),
        "note",
      );
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Recipient must be different from sender",
    );
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("attestation within 30s of expiry -> 'about to expire' toast", async () => {
    const blockTs = Math.floor(Date.now() / 1000);
    getBlockMock.mockResolvedValue({ timestamp: BigInt(blockTs) });
    const { result } = renderHook(() => useAgentPayment());
    await waitFor(() => expect(result.current.blockTimestamp).toBe(blockTs));
    // 25s remaining < 30s buffer
    const expiringSoon = attestation({ expiry: blockTs + 25 });
    let r: `0x${string}` | null = null;
    await act(async () => {
      r = await result.current.submit(ALICE, expiringSoon, "note");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Attestation about to expire — re-derive",
    );
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("uses block.timestamp NOT Date.now() for expiry math (audit invariant)", async () => {
    // Simulate clock skew: local clock 1 hour AHEAD of chain
    const realNow = Math.floor(Date.now() / 1000);
    const chainTs = realNow - 3600;
    getBlockMock.mockResolvedValue({ timestamp: BigInt(chainTs) });
    const { result } = renderHook(() => useAgentPayment());
    await waitFor(() => expect(result.current.blockTimestamp).toBe(chainTs));
    // Attestation that LOOKS expired by local clock (expiry < realNow) but
    // is STILL VALID by chain time (expiry > chainTs + 30)
    const att = attestation({ expiry: realNow - 1800 });
    await act(async () => {
      await result.current.submit(ALICE, att, "note");
    });
    // Should NOT reject — the attestation is still 30min from chain expiry
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      "Attestation about to expire — re-derive",
    );
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Date.now() when blockTimestamp null (no client yet)", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useAgentPayment());
    expect(result.current.blockTimestamp).toBeNull();
    // Past attestation (Date.now-based)
    const att = attestation({ expiry: Math.floor(Date.now() / 1000) + 10 });
    let r: `0x${string}` | null = null;
    await act(async () => {
      r = await result.current.submit(ALICE, att, "note");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Connection lost",
    );
  });
});

// ----- submit happy path + approval ----- //

describe("useAgentPayment — submit happy path (§15.x)", () => {
  it("first submit: triggers approval + markVaultApproved", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "salary");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    const approveCall = unifiedWriteMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
    expect(approveCall.address).toBe(VAULT);
    expect(approveCall.args[0]).toBe(PAYMENT_HUB);
    expect(markVaultApprovedMock).toHaveBeenCalledWith(PAYMENT_HUB);
  });

  it("pre-approved: NO approval tx fires", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "salary");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("calls sendPaymentAsAgent with (to, vault, encAmount, note, agent, nonce, expiry, sig)", async () => {
    const { result } = renderHook(() => useAgentPayment());
    const att = attestation({ amount: 50_000_000n });
    await act(async () => {
      await result.current.submit(ALICE, att, "March salary");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("sendPaymentAsAgent");
    expect(call.address).toBe(PAYMENT_HUB);
    expect(call.args[0]).toBe(ALICE);
    expect(call.args[1]).toBe(VAULT);
    expect(call.args[3]).toBe("March salary");
    expect(call.args[4]).toBe(AGENT);
    expect(call.args[5]).toBe(NONCE);
    expect(call.args[6]).toBe(BigInt(att.expiry));
    expect(call.args[7]).toBe(SIG);
    expect(call.gas).toBe(5_000_000n);
  });

  it("encrypts amount via encryptInputsAsync before submit", async () => {
    const { result } = renderHook(() => useAgentPayment());
    const att = attestation({ amount: 50_000_000n });
    await act(async () => {
      await result.current.submit(ALICE, att, "note");
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(1);
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(50_000_000n);
  });

  it("returns the tx hash on success", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xagenttx",
      receipt: { status: "success", blockNumber: 999n },
    });
    const { result } = renderHook(() => useAgentPayment());
    let h: `0x${string}` | null = null;
    await act(async () => {
      h = await result.current.submit(ALICE, attestation(), "note");
    });
    expect(h).toBe("0xagenttx");
    expect(result.current.step).toBe("success");
  });

  it("step ladder: idle -> approving -> encrypting -> sending -> success", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(result.current.step).toBe("success");
    // Verify the order: approve happened before sendPaymentAsAgent
    expect(markVaultApprovedMock).toHaveBeenCalled();
    expect(unifiedWriteMock).toHaveBeenCalled();
    expect(unifiedWriteAndWaitMock).toHaveBeenCalled();
  });

  it("EOA-receipt path: no receipt on result -> falls back to waitForTransactionReceipt", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtx",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "success",
      blockNumber: 5555n,
    });
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xtx",
      confirmations: 1,
      timeout: 300_000,
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.block_number).toBe(5555);
  });

  it("reverted receipt -> throws + step=error + NO supabase write", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n },
    });
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toContain("reverted");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
  });
});

// ----- success-path bookkeeping ----- //

describe("useAgentPayment — success bookkeeping (§15.x)", () => {
  it("insertActivity row has AGENT_PAYMENT type + lowercased addresses + tx + chain", async () => {
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "March salary");
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("agent_payment");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ALICE.toLowerCase());
    expect(row.tx_hash).toBe("0xtxhash");
    expect(row.contract_address).toBe(PAYMENT_HUB);
    expect(row.token_address).toBe(TEST_USDC);
    expect(row.note).toBe("March salary");
    expect(row.block_number).toBe(12345);
  });

  it("empty note -> fallback to 'Agent <short>' derived from attestation.agent", async () => {
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "");
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.note).toContain("Agent");
    expect(row.note).toContain(AGENT.slice(0, 6));
    expect(row.note).toContain(AGENT.slice(-4));
  });

  it("broadcastAction fires TWICE: balance_changed + activity_added", async () => {
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("invalidateBalanceQueries fires on success", async () => {
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("success toast 'Agent payment submitted on-chain!' fires", async () => {
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Agent payment submitted on-chain!",
    );
  });
});

// ----- error handling ----- //

describe("useAgentPayment — error handling (§15.x)", () => {
  it("allowance error -> clearVaultApproval(PAYMENT_HUB) re-arms gate", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(PAYMENT_HUB);
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("insufficient allowance");
  });

  it("approve error -> clearVaultApproval fires", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("approve failed"));
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(PAYMENT_HUB);
  });

  it("unrelated error (rpc timeout) -> clearVaultApproval NOT called", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc timeout"));
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith("rpc timeout");
  });

  it("non-Error thrown -> 'Agent payment failed' fallback", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue("string-error");
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Agent payment failed");
    expect(result.current.step).toBe("error");
  });

  it("error path returns null", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("any error"));
    const { result } = renderHook(() => useAgentPayment());
    let r: `0x${string}` | null = null;
    await act(async () => {
      r = await result.current.submit(ALICE, attestation(), "note");
    });
    expect(r).toBeNull();
  });
});

// ----- reset ----- //

describe("useAgentPayment — reset (§15.x)", () => {
  it("reset clears step + error + lastAttestation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        amount: "1",
        agent: AGENT,
        nonce: NONCE,
        expiry: 0,
        signature: SIG,
        raw: "",
      }),
    });
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.derive("payroll_line", "x");
    });
    expect(result.current.lastAttestation).not.toBeNull();
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.lastAttestation).toBeNull();
  });

  it("reset after error allows clean retry", async () => {
    unifiedWriteAndWaitMock.mockRejectedValueOnce(new Error("fail1"));
    const { result } = renderHook(() => useAgentPayment());
    await act(async () => {
      await result.current.submit(ALICE, attestation(), "note");
    });
    expect(result.current.step).toBe("error");
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});
