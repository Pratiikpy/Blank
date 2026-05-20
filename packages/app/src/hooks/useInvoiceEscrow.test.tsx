import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useInvoiceEscrow. PR-C trustless-invoice-escrow flow:
//   payEscrow(invoiceId, amount) — encrypt the client's payment, ensure
//     vault allowance, call payInvoiceEscrow. Funds sit in BusinessHub
//     until releaseEscrow finalizes.
//   releaseEscrow(invoiceId) — read the on-chain validation handle,
//     threshold-decrypt the match-vs-mismatch flag off-chain, call
//     releaseInvoiceEscrow. Contract routes funds: vendor on match,
//     client refund on mismatch.
//
// CRITICAL pins:
//   - Single-flight gate via `step !== "idle"` — both payEscrow AND
//     releaseEscrow short-circuit when the hook is already busy. A
//     rapid double-click on the Finalize button mid-decrypt would
//     otherwise trigger two concurrent threshold polls (wasteful) and
//     two contract calls (one would revert "already-finalized").
//   - Approval cache via isVaultApproved/markVaultApproved (BusinessHub
//     spender). First payEscrow approves MAX_UINT64; subsequent skip.
//     Approval failure -> toast + throws + payInvoiceEscrow NOT called.
//   - 8-state ladder (idle / approving / encrypting / paying /
//     decrypting / finalizing / success / error) with finishTransiently
//     auto-resetting back to idle after 5s on success (6s on
//     releaseEscrow success) so the UI doesn't stay stuck on a stale
//     "Success" state across multiple operations. resetTimer.current
//     cleanup-on-unmount prevents the leaked setTimeout.
//   - Reverted receipt path on BOTH operations: payEscrow throws
//     "Escrow funding reverted on-chain"; releaseEscrow throws
//     "Finalize reverted on-chain". Each gets a distinct toast +
//     SKIPS updateInvoiceStatus + insertActivity + broadcast (audit
//     invariant: supabase updates only after on-chain confirm).
//   - Threshold decrypt 180s poll budget (NOT 60s) — Sepolia threshold
//     network can take 90+s under load; 60s timeout was hitting the
//     timeout error on legitimate transactions. Pinned with fake-timer
//     advance through the poll loop.
//   - Decrypted-value normalization: result.decryptedValue can come back
//     as boolean OR bigint (0n/1n). The matched flag uses ternary:
//     boolean -> raw value; bigint -> non-zero check. A naive `Boolean(0n)`
//     would still be falsy but `Boolean(1n)` is truthy — so the explicit
//     non-zero compare is documentation, not strictly necessary, but the
//     pattern survives if the SDK ever returns string "true"/"false".
//   - releaseEscrow updateInvoiceStatus call args differ by match: true
//     -> "paid", false -> "refunded". The UI distinguishes these in the
//     status badge + activity feed copy.
//   - releaseEscrow activity note copy differs by match: matched ->
//     "Released escrow #N to vendor"; mismatched -> "Refunded escrow
//     #N (amount mismatch)". User needs to see WHY the refund fired —
//     amount didn't match the invoice's stored amount.
//   - getInvoiceValidationHandle === 0n check fires BEFORE the decrypt
//     poll so users get an immediate "Invoice not funded yet" error
//     instead of a 180s wait that ends in "decryption timed out".

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useCofheDecryptForTxMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const updateInvoiceStatusMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
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
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheEncrypt: useCofheEncryptMock,
  useCofheDecryptForTx: useCofheDecryptForTxMock,
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/abis", () => ({ BusinessHubAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
}));
vi.mock("@/lib/supabase", () => ({
  insertActivity: insertActivityMock,
  updateInvoiceStatus: updateInvoiceStatusMock,
}));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
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

import { useInvoiceEscrow } from "./useInvoiceEscrow";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HUB = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const SIGNATURE = ("0x" + "01".repeat(65)) as `0x${string}`;

const encryptInputsAsyncMock = vi.fn();
const decryptForTxMock = vi.fn();
const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const readContractMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheEncryptMock.mockReset();
  useCofheDecryptForTxMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  insertActivityMock.mockReset();
  updateInvoiceStatusMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  decryptForTxMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  readContractMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { BusinessHub: HUB, FHERC20Vault_USDC: VAULT },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    readContract: readContractMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useCofheEncryptMock.mockReturnValue({
    encryptInputsAsync: encryptInputsAsyncMock,
  });
  useCofheDecryptForTxMock.mockReturnValue({
    decryptForTx: decryptForTxMock,
  });
  isVaultApprovedMock.mockReturnValue(true);
  toastLoadingMock.mockReturnValue("toast-id");
  insertActivityMock.mockResolvedValue(undefined);
  updateInvoiceStatusMock.mockResolvedValue(undefined);
  encryptInputsAsyncMock.mockResolvedValue([
    { ctHash: 0x42n, securityZone: 0, utype: 5, signature: "0xenc" },
  ]);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: { status: "success", blockNumber: 1n },
  });
  // Default release path: handle exists, decrypt returns matched=true
  readContractMock.mockResolvedValue(123n);
  decryptForTxMock.mockResolvedValue({
    decryptedValue: true,
    signature: SIGNATURE,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — initial state (§15.x)", () => {
  it("returns idle step + isPaying=false + isReleasing=false + 2 callable handlers", () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    expect(result.current.step).toBe("idle");
    expect(result.current.isPaying).toBe(false);
    expect(result.current.isReleasing).toBe(false);
    expect(typeof result.current.payEscrow).toBe("function");
    expect(typeof result.current.releaseEscrow).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  payEscrow guards
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — payEscrow guards (§15.x)", () => {
  it("no address -> 'Connect a wallet first' toast + null return + no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: string | null = null;
    await act(async () => {
      r = await result.current.payEscrow(42, "100");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connect a wallet first");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> 'Connection lost — please refresh' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: string | null = null;
    await act(async () => {
      r = await result.current.payEscrow(42, "100");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost. Please refresh.");
  });

  it("empty amount -> 'Enter an amount' toast", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(42, "");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("whitespace-only amount -> 'Enter an amount' toast", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(42, "   ");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
  });

  it("single-flight: second call while step != idle returns null without re-firing", async () => {
    // Stall the first call's unifiedWriteAndWait so step stays != "idle"
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useInvoiceEscrow());
    let p1!: Promise<string | null>;
    await act(async () => {
      p1 = result.current.payEscrow(1, "10");
      await Promise.resolve();
    });
    // Second concurrent call returns null without firing another write
    let r2: string | null = null;
    await act(async () => {
      r2 = await result.current.payEscrow(2, "20");
    });
    expect(r2).toBeNull();
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    // Resolve the first call so test cleans up
    resolveFirst({ hash: "0xtx", receipt: { status: "success", blockNumber: 1n } });
    await act(async () => {
      await p1;
    });
  });
});

// ───────────────────────────────────────────────────────────
//  payEscrow approval cache
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — payEscrow vault approval (§15.x)", () => {
  it("first payEscrow: approves via unifiedWrite + markVaultApproved", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "10");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    const approveCall = unifiedWriteMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
    expect(approveCall.address).toBe(VAULT);
    expect(approveCall.args[0]).toBe(HUB);
    expect(approveCall.args[1]).toBe(BigInt("18446744073709551615")); // MAX_UINT64
    expect(markVaultApprovedMock).toHaveBeenCalledWith(HUB);
  });

  it("pre-approved -> approval skipped", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "10");
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval failure -> error toast + payInvoiceEscrow NOT called", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteMock.mockRejectedValue(new Error("user rejected approval"));
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: string | null = "x";
    await act(async () => {
      r = await result.current.payEscrow(1, "10");
    });
    expect(r).toBeNull();
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  payEscrow happy path + AA/EOA receipt paths
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — payEscrow happy path (§15.x)", () => {
  it("calls payInvoiceEscrow with (BigInt(invoiceId), encAmount) + gas=5_000_000", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(42, "100");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(HUB);
    expect(call.functionName).toBe("payInvoiceEscrow");
    expect(call.args[0]).toBe(42n);
    expect(call.gas).toBe(5_000_000n);
  });

  it("parseUnits with 6 decimals applied to amount before encrypt", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "1.5");
    });
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(1_500_000n);
  });

  it("AA path: result.receipt present -> skips waitForTransactionReceipt", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xaa",
      receipt: { status: "success", blockNumber: 999n },
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "10");
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
    expect(insertActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ block_number: 999 }),
    );
  });

  it("EOA path: no receipt -> falls back to waitForTransactionReceipt with 300s timeout", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xeoa",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "success",
      blockNumber: 5555n,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "10");
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
      timeout: 300_000,
    });
    expect(insertActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ block_number: 5555 }),
    );
  });

  it("updates invoice status to 'payment_pending' on success", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(42, "100");
    });
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "payment_pending");
  });

  it("inserts activity row with INVOICE_PAYMENT type + invoice id in note", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(42, "100");
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.tx_hash).toBe("0xtxhash");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ME.toLowerCase());
    expect(row.activity_type).toBe("invoice_payment");
    expect(row.note).toContain("invoice #42");
    expect(row.contract_address).toBe(HUB);
    expect(row.token_address).toBe(VAULT);
  });

  it("broadcastAction fires TWICE: balance_changed + activity_added", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "10");
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("invalidateBalanceQueries + success toast fire on success", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "10");
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Payment funded. Finalize to release to vendor.",
    );
  });

  it("returns the tx hash on success", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xreturned",
      receipt: { status: "success", blockNumber: 1n },
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: string | null = null;
    await act(async () => {
      r = await result.current.payEscrow(1, "10");
    });
    expect(r).toBe("0xreturned");
  });
});

// ───────────────────────────────────────────────────────────
//  payEscrow error path (audit invariant: NO supabase on revert)
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — payEscrow error path (§15.x)", () => {
  it("reverted receipt -> 'Escrow funding reverted on-chain' toast + NO supabase write", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n },
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: string | null = "x";
    await act(async () => {
      r = await result.current.payEscrow(1, "10");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Escrow funding reverted on-chain");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(updateInvoiceStatusMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
  });

  it("write rejection -> error toast + no supabase write", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "10");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("rpc fail");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("non-Error throw -> 'Escrow funding failed' fallback copy", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue("plain-string");
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.payEscrow(1, "10");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Escrow funding failed");
  });
});

// ───────────────────────────────────────────────────────────
//  releaseEscrow guards
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — releaseEscrow guards (§15.x)", () => {
  it("no address -> 'Connect a wallet first' + null", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: { hash: string; matched: boolean } | null = null;
    await act(async () => {
      r = await result.current.releaseEscrow(42);
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connect a wallet first");
  });

  it("no publicClient -> 'Connection lost' + null", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: { hash: string; matched: boolean } | null = null;
    await act(async () => {
      r = await result.current.releaseEscrow(42);
    });
    expect(r).toBeNull();
  });

  it("validation handle === 0n -> 'Invoice not funded yet' + no decrypt + no write", async () => {
    readContractMock.mockResolvedValue(0n);
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Invoice not funded yet — nothing to finalize",
    );
    expect(decryptForTxMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("validation handle null/undefined -> same 'not funded yet' error", async () => {
    readContractMock.mockResolvedValue(null);
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Invoice not funded yet — nothing to finalize",
    );
  });
});

// ───────────────────────────────────────────────────────────
//  releaseEscrow happy paths (matched + mismatched)
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — releaseEscrow matched=true path (§15.x)", () => {
  it("calls releaseInvoiceEscrow with (BigInt(id), matched=true, signature)", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: { hash: string; matched: boolean } | null = null;
    await act(async () => {
      r = await result.current.releaseEscrow(42);
    });
    expect(r!.matched).toBe(true);
    const releaseCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(releaseCall.functionName).toBe("releaseInvoiceEscrow");
    expect(releaseCall.args[0]).toBe(42n);
    expect(releaseCall.args[1]).toBe(true);
    expect(releaseCall.args[2]).toBe(SIGNATURE);
  });

  it("updates invoice status to 'paid' on match", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "paid");
  });

  it("activity note: 'Released escrow #N to vendor' on match", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("invoice_finalized");
    expect(row.note).toBe("Released escrow #42 to vendor");
  });

  it("success toast: 'Vendor paid — escrow released' on match", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Vendor paid — escrow released",
    );
  });
});

describe("useInvoiceEscrow — releaseEscrow matched=false path (§15.x)", () => {
  it("calls releaseInvoiceEscrow with matched=false on amount mismatch", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: false,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: { hash: string; matched: boolean } | null = null;
    await act(async () => {
      r = await result.current.releaseEscrow(42);
    });
    expect(r!.matched).toBe(false);
    const releaseCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(releaseCall.args[1]).toBe(false);
  });

  it("updates invoice status to 'refunded' on mismatch", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: false,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "refunded");
  });

  it("activity note explains WHY: 'Refunded escrow #N (amount mismatch)'", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: false,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.note).toBe("Refunded escrow #42 (amount mismatch)");
  });

  it("toast: 'Refunded — amount didn't match' on mismatch", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: false,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Refunded — amount didn't match",
    );
  });
});

// ───────────────────────────────────────────────────────────
//  Decrypted-value normalization (bigint vs boolean)
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — decryptedValue normalization (§15.x)", () => {
  it("bigint 1n -> matched=true", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 1n,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: { hash: string; matched: boolean } | null = null;
    await act(async () => {
      r = await result.current.releaseEscrow(1);
    });
    expect(r!.matched).toBe(true);
  });

  it("bigint 0n -> matched=false", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 0n,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: { hash: string; matched: boolean } | null = null;
    await act(async () => {
      r = await result.current.releaseEscrow(1);
    });
    expect(r!.matched).toBe(false);
  });

  it("boolean true -> matched=true (no coercion needed)", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: { hash: string; matched: boolean } | null = null;
    await act(async () => {
      r = await result.current.releaseEscrow(1);
    });
    expect(r!.matched).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────
//  Threshold-decrypt poll budget (180s)
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — threshold decrypt poll (§15.x)", () => {
  it("decrypt returns null then result on retry -> success without timeout", async () => {
    let callCount = 0;
    decryptForTxMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount < 3) return null; // not ready yet
      return { decryptedValue: true, signature: SIGNATURE };
    });
    vi.useFakeTimers();
    const { result } = renderHook(() => useInvoiceEscrow());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.releaseEscrow(42);
    });
    // Run the poll loop: 2 misses x 5s wait = ~10s + final hit
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => {
      await p;
    });
    expect(decryptForTxMock).toHaveBeenCalledTimes(3);
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "paid");
  });

  it("decrypt always null -> 180s budget elapses + 'Decryption timed out' error", async () => {
    decryptForTxMock.mockResolvedValue(null);
    vi.useFakeTimers();
    const { result } = renderHook(() => useInvoiceEscrow());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.releaseEscrow(42);
    });
    // Advance well past the 180s budget
    await vi.advanceTimersByTimeAsync(200_000);
    await act(async () => {
      await p;
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Decryption timed out — try again in a moment",
    );
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("read handle uses getInvoiceValidationHandle(BigInt(invoiceId))", async () => {
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(readContractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: HUB,
        functionName: "getInvoiceValidationHandle",
        args: [42n],
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────
//  releaseEscrow error path
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — releaseEscrow error path (§15.x)", () => {
  it("reverted release receipt -> 'Finalize reverted' + NO supabase write", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n },
    });
    const { result } = renderHook(() => useInvoiceEscrow());
    let r: { hash: string; matched: boolean } | null = null;
    await act(async () => {
      r = await result.current.releaseEscrow(42);
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Finalize reverted on-chain");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(updateInvoiceStatusMock).toHaveBeenCalledTimes(0);
  });

  it("write rejection -> error toast + no supabase write", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("user rejected");
  });

  it("non-Error throw -> 'Finalize failed' fallback", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue("string-error");
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      await result.current.releaseEscrow(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Finalize failed");
  });
});

// ───────────────────────────────────────────────────────────
//  Derived flags (isPaying / isReleasing)
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — isPaying / isReleasing flags (§15.x)", () => {
  it("isPaying=true during in-flight payEscrow + false after", async () => {
    let resolveWrite: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValue(
      new Promise((res) => {
        resolveWrite = res;
      }),
    );
    const { result } = renderHook(() => useInvoiceEscrow());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.payEscrow(1, "10");
    });
    await waitFor(() => expect(result.current.isPaying).toBe(true));
    expect(result.current.isReleasing).toBe(false);
    resolveWrite({ hash: "0xtx", receipt: { status: "success", blockNumber: 1n } });
    await act(async () => {
      await p;
    });
    expect(result.current.isPaying).toBe(false);
  });

  it("isReleasing=true during in-flight releaseEscrow + false after", async () => {
    // Stall the release write so step stays "finalizing"
    let resolveRelease: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValue(
      new Promise((res) => {
        resolveRelease = res;
      }),
    );
    const { result } = renderHook(() => useInvoiceEscrow());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.releaseEscrow(42);
    });
    await waitFor(() => expect(result.current.isReleasing).toBe(true));
    expect(result.current.isPaying).toBe(false);
    resolveRelease({ hash: "0xtx", receipt: { status: "success", blockNumber: 1n } });
    await act(async () => {
      await p;
    });
    expect(result.current.isReleasing).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  finishTransiently auto-reset
// ───────────────────────────────────────────────────────────

describe("useInvoiceEscrow — finishTransiently auto-reset (§15.x)", () => {
  it("step flips back to idle after 5s on payEscrow success", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      const p = result.current.payEscrow(1, "10");
      await vi.advanceTimersByTimeAsync(0); // flush microtasks for the awaits
      await p;
    });
    expect(result.current.step).toBe("success");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.step).toBe("idle");
  });

  it("step flips back to idle after 6s on releaseEscrow success", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      const p = result.current.releaseEscrow(42);
      await vi.advanceTimersByTimeAsync(0);
      await p;
    });
    expect(result.current.step).toBe("success");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(result.current.step).toBe("idle");
  });

  it("unmount clears the reset timer (no leaked setTimeout)", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useInvoiceEscrow());
    await act(async () => {
      const p = result.current.payEscrow(1, "10");
      await vi.advanceTimersByTimeAsync(0);
      await p;
    });
    unmount();
    // Advance past the 5s reset — should NOT throw or leak
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
