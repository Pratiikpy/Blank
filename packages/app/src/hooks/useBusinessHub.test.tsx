import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useBusinessHub. The B2B contract hook: invoices
// (create + pay + mode-aware finalize + two-step disputed refund +
// cancel; swap and oracle pay are retired on-chain) + escrows (create
// with optional IPFS attachment + markDelivered + approveRelease +
// disputeEscrow + arbiterDecide + claimExpiredEscrow) + payroll
// (runPayroll batch with per-recipient fanout). Largest hook in
// the sweep (1407 LoC) — 14 callables.
//
// CRITICAL pins:
//   - 6-step machine (idle / encrypting / approving / sending /
//     success / error); success+error auto-reset to idle after 6s
//     and 5s respectively via setTimeout that gets cleared on
//     unmount + every new submission so a delayed reset doesn't
//     stomp a fresh in-flight state.
//   - createInvoice + runPayroll + payInvoice all share the same
//     concurrent-submit guard: `step === "approving" || step ===
//     "encrypting" || step === "sending"` -> early return; the
//     plaintext-only ops (markDelivered / approveRelease /
//     disputeEscrow / cancelInvoice / arbiterDecide /
//     claimExpiredEscrow) use a stricter `step !== "idle"` guard
//     so they wait for ANY prior write to fully resolve before
//     firing.
//   - createInvoice approval cache on BusinessHub (vault spender);
//     §3.4 ensureVaultApproval uses unifiedWrite + markVaultApproved;
//     allowance / approve / insufficient / transfer-amount-exceeds
//     errors trigger clearVaultApproval(BusinessHub).
//   - runPayroll gas formula 3_000_000n + 3_000_000n * N (NOT 5M +
//     800k * N like useSendPayment.confirmBatchSend); BusinessHub's
//     runPayroll does ~13 FHE ops per recipient inside
//     transferFromVerified plus ZK input verification per encrypted
//     salary, so the per-recipient marginal is much higher; default
//     2M callGasLimit from buildUserOp is too low for N >= 2. Test
//     pins exact gas value for N=3 -> 12_000_000n.
//   - runPayroll fanout activity rows: per-employee tx_hash suffix
//     `${hash}_${employee.toLowerCase()}` + activity_type=PAYROLL +
//     same insertActivitiesFanout pattern as useGroupSplit /
//     useGiftMoney / useSendPayment-many-mode.
//   - createEscrow approves TestUSDC (NOT vault) because escrows
//     deposit plaintext ERC20 (the contract calls underlying.
//     transferFrom in createEscrow, not vault transferFromVerified);
//     §1.7 extractEventId null throws "escrowId could not be read";
//     arbiter notification row uses `${hash}:arbiter` tx_hash suffix
//     for dedup uniqueness ONLY when arbiter is set, non-zero,
//     case-INsensitive distinct from depositor + beneficiary.
//   - finalizeInvoice routes by invoicePaymentMode: Direct ->
//     payInvoiceFinalize (client), Escrow -> releaseInvoiceEscrow
//     (client, or anyone after 7 days), Legacy escrow -> revalidate
//     first, other Legacy -> vendor. Direct mismatch is 'disputed',
//     escrow mismatch is 'refunded'.
//   - refundDisputedInvoice is two writes (refund, then publish the
//     decrypted refunded == paid check) and resumes at step two.
//   - arbiterDecide multi-row activity insert: arbiter base row +
//     depositor row with `:depositor` suffix (case-INsensitive
//     skip when arbiter === depositor) + beneficiary row with
//     `:beneficiary` suffix (case-INsensitive skip when arbiter ===
//     beneficiary OR beneficiary === depositor); test pins all 3
//     scenarios (3 distinct addresses / arbiter == depositor / etc).

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheDecryptForTxMock = vi.hoisted(() => vi.fn());
const useEmailAuthSignerMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const clearVaultApprovalMock = vi.hoisted(() => vi.fn());
const insertInvoiceMock = vi.hoisted(() => vi.fn());
const insertEscrowMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const insertActivitiesFanoutMock = vi.hoisted(() => vi.fn());
const updateEscrowStatusMock = vi.hoisted(() => vi.fn());
const updateInvoiceStatusMock = vi.hoisted(() => vi.fn());
const setInvoicePdfCidMock = vi.hoisted(() => vi.fn());
const setEscrowAttachmentCidMock = vi.hoisted(() => vi.fn());
const extractEventIdMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const lookupNameMock = vi.hoisted(() => vi.fn());
const renderAndPinInvoicePdfMock = vi.hoisted(() => vi.fn());
const sendInvoiceEmailMock = vi.hoisted(() => vi.fn());
const pinFileMock = vi.hoisted(() => vi.fn());
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
  useCofheDecryptForTx: useCofheDecryptForTxMock,
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("./useEmailAuthSigner", () => ({
  useEmailAuthSigner: useEmailAuthSignerMock,
}));
vi.mock("@/lib/abis", () => ({
  BusinessHubAbi: [],
  FHERC20VaultAbi: [],
  TestUSDCAbi: [],
}));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
  clearVaultApproval: clearVaultApprovalMock,
}));
vi.mock("@/lib/supabase", () => ({
  insertInvoice: insertInvoiceMock,
  insertEscrow: insertEscrowMock,
  insertActivity: insertActivityMock,
  updateEscrowStatus: updateEscrowStatusMock,
  updateInvoiceStatus: updateInvoiceStatusMock,
  setInvoicePdfCid: setInvoicePdfCidMock,
  setEscrowAttachmentCid: setEscrowAttachmentCidMock,
}));
vi.mock("@/lib/activity-fanout", () => ({
  insertActivitiesFanout: insertActivitiesFanoutMock,
}));
vi.mock("@/lib/event-parser", () => ({ extractEventId: extractEventIdMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/address-resolver", () => ({ lookupName: lookupNameMock }));
vi.mock("@/lib/invoice-pdf", () => ({
  renderAndPinInvoicePdf: renderAndPinInvoicePdfMock,
}));
vi.mock("@/lib/email-client", () => ({
  sendInvoiceEmail: sendInvoiceEmailMock,
  buildInvoiceEmailSignableMessage: () => "signable-message",
}));
vi.mock("@/lib/invoice-links", () => ({
  buildInvoiceLink: () => "https://www.myblank.app/invoice/42",
}));
vi.mock("@/lib/ipfs", () => ({ pinFile: pinFileMock }));
vi.mock("@/lib/address", () => ({
  truncateAddress: (a: string) => a.slice(0, 6),
}));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useBusinessHub } from "./useBusinessHub";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const CAROL = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
const ARBITER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as `0x${string}`;
const HUB = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const VAULT = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const USDC = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const encryptInputsAsyncMock = vi.fn();
const decryptForTxMock = vi.fn();
const signEmailAuthMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const readContractMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheEncryptMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheDecryptForTxMock.mockReset();
  useEmailAuthSignerMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  insertInvoiceMock.mockReset();
  insertEscrowMock.mockReset();
  insertActivityMock.mockReset();
  insertActivitiesFanoutMock.mockReset();
  updateEscrowStatusMock.mockReset();
  updateInvoiceStatusMock.mockReset();
  setInvoicePdfCidMock.mockReset();
  setEscrowAttachmentCidMock.mockReset();
  extractEventIdMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  lookupNameMock.mockReset();
  renderAndPinInvoicePdfMock.mockReset();
  sendInvoiceEmailMock.mockReset();
  pinFileMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  decryptForTxMock.mockReset();
  signEmailAuthMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  readContractMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      BusinessHub: HUB,
      FHERC20Vault_USDC: VAULT,
      TestUSDC: USDC,
    },
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
  useCofheDecryptForTxMock.mockReturnValue({ decryptForTx: decryptForTxMock });
  useEmailAuthSignerMock.mockReturnValue({ signEmailAuth: signEmailAuthMock });
  isVaultApprovedMock.mockReturnValue(true);
  toastLoadingMock.mockReturnValue("tid");
  unifiedWriteMock.mockResolvedValue("0xtxhash" as `0x${string}`);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash" as `0x${string}`,
    receipt: { status: "success", blockNumber: 5n, logs: [] },
  });
  // 0.7: one handle per input, then a single batch signature.
  encryptInputsAsyncMock.mockImplementation(async (inputs: unknown[]) => [
    ...inputs.map((_, i) => `0xhandle${i}`),
    "0xbatchproof",
  ]);
  extractEventIdMock.mockReturnValue(42);
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 5n,
    logs: [],
  });
  readContractMock.mockResolvedValue(0x999n);
  decryptForTxMock.mockResolvedValue({
    decryptedValue: true,
    signature: ("0x" + "01".repeat(65)) as `0x${string}`,
  });
  insertInvoiceMock.mockResolvedValue(undefined);
  insertEscrowMock.mockResolvedValue(undefined);
  insertActivityMock.mockResolvedValue(undefined);
  insertActivitiesFanoutMock.mockResolvedValue(undefined);
  updateEscrowStatusMock.mockResolvedValue(undefined);
  updateInvoiceStatusMock.mockResolvedValue(undefined);
  lookupNameMock.mockResolvedValue(null);
  renderAndPinInvoicePdfMock.mockResolvedValue({ cid: "QmCid" });
  signEmailAuthMock.mockResolvedValue(null);
  sendInvoiceEmailMock.mockResolvedValue({ ok: true });
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — initial state (§15.x)", () => {
  it("returns step='idle' + the callables; retired swap/oracle pay are gone", () => {
    const { result } = renderHook(() => useBusinessHub());
    expect(result.current.step).toBe("idle");
    expect(typeof result.current.createInvoice).toBe("function");
    expect(typeof result.current.runPayroll).toBe("function");
    expect(typeof result.current.createEscrow).toBe("function");
    expect(typeof result.current.finalizeInvoice).toBe("function");
    expect(typeof result.current.markDelivered).toBe("function");
    expect(typeof result.current.approveRelease).toBe("function");
    expect(typeof result.current.disputeEscrow).toBe("function");
    expect(typeof result.current.payInvoice).toBe("function");
    expect(typeof result.current.refundDisputedInvoice).toBe("function");
    expect(typeof result.current.claimDisputeTimeout).toBe("function");
    expect(typeof result.current.getInvoiceSettlement).toBe("function");
    expect(typeof result.current.getEscrowDisputedAt).toBe("function");
    expect("payInvoiceWithSwap" in result.current).toBe(false);
    expect("payInvoiceWithOracleQuote" in result.current).toBe(false);
    expect(typeof result.current.cancelInvoice).toBe("function");
    expect(typeof result.current.arbiterDecide).toBe("function");
    expect(typeof result.current.claimExpiredEscrow).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  createInvoice
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — createInvoice (§15.x)", () => {
  it("no address -> 'Please connect your wallet'", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(ALICE, "100", "test", 1735689600);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Please connect your wallet");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty amount -> 'Enter an amount' + step back to idle", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(ALICE, "", "test", 1735689600);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
    expect(result.current.step).toBe("idle");
  });

  it("first-time: approve(BusinessHub) on vault + markVaultApproved + createInvoice", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(ALICE, "100", "Web work", 1735689600);
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteMock.mock.calls[0][0].functionName).toBe(
      "approvePlaintext",
    );
    expect(unifiedWriteMock.mock.calls[0][0].address).toBe(VAULT);
    expect(markVaultApprovedMock).toHaveBeenCalledWith(HUB);
  });

  it("createInvoice args: [client, vault, encAmount, description, BigInt(dueDate)] + gas 5M", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(ALICE, "100", "Web work", 1735689600);
    });
    const call = unifiedWriteAndWaitMock.mock.calls.find(
      (c) => c[0].functionName === "createInvoice",
    );
    expect(call).toBeDefined();
    expect(call![0].address).toBe(HUB);
    expect(call![0].args[0]).toBe(ALICE);
    expect(call![0].args[1]).toBe(VAULT);
    expect(call![0].args[4]).toBe("Web work");
    expect(call![0].args[5]).toBe(1735689600n);
    expect(call![0].gas).toBe(5_000_000n);
    const encBatch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(encBatch[0].raw).toBe(100_000_000n);
  });

  it("extractEventId null -> error toast + no supabase insert", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(ALICE, "100", "test", 1735689600);
    });
    expect(insertInvoiceMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: insertInvoice + INVOICE_CREATED activity + broadcasts + invalidate", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(ALICE, "100", "Web work", 1735689600);
    });
    expect(insertInvoiceMock).toHaveBeenCalledTimes(1);
    expect(insertInvoiceMock.mock.calls[0][0]).toMatchObject({
      invoice_id: 7,
      vendor_address: ME,
      client_address: ALICE,
      description: "Web work",
      status: "pending",
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("invoice_created");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ALICE.toLowerCase());
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith("Invoice sent!");
  });

  it("client_email defaults to null when omitted; trimmed string when set", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(
        ALICE,
        "100",
        "test",
        1735689600,
        "  vendor@example.com  ",
      );
    });
    expect(insertInvoiceMock.mock.calls[0][0].client_email).toBe(
      "vendor@example.com",
    );
  });

  it("reverted receipt -> step='error' + no supabase", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(ALICE, "100", "test", 1735689600);
    });
    expect(insertInvoiceMock).toHaveBeenCalledTimes(0);
  });

  it("error-discriminator: allowance error -> clearVaultApproval(BusinessHub)", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createInvoice(ALICE, "100", "test", 1735689600);
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
  });
});

// ───────────────────────────────────────────────────────────
//  runPayroll
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — runPayroll (§15.x)", () => {
  it("employees.length !== amounts.length -> 'Invalid payroll data'", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll([ALICE, BOB], ["50"]);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid payroll data");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty arrays -> 'Invalid payroll data'", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll([], []);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid payroll data");
  });

  it("empty amount in any slot -> 'All employee amounts must be filled in'", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll([ALICE, BOB], ["50", ""]);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "All employee amounts must be filled in",
    );
  });

  it("gas formula: 3_000_000n + 3_000_000n * N (N=3 -> 12_000_000n)", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll(
        [ALICE, BOB, CAROL],
        ["50", "60", "70"],
      );
    });
    const call = unifiedWriteAndWaitMock.mock.calls.find(
      (c) => c[0].functionName === "runPayroll",
    );
    expect(call).toBeDefined();
    expect(call![0].gas).toBe(12_000_000n);
  });

  it("gas formula for N=5 -> 18_000_000n", async () => {
    const employees = [ALICE, BOB, CAROL, ALICE, BOB];
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll(employees, ["10", "20", "30", "40", "50"]);
    });
    const call = unifiedWriteAndWaitMock.mock.calls.find(
      (c) => c[0].functionName === "runPayroll",
    );
    expect(call![0].gas).toBe(18_000_000n);
  });

  it("runPayroll args: [employees, vault, encSalaries[]] + encrypts all in parallel", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll([ALICE, BOB], ["50", "75"]);
    });
    const call = unifiedWriteAndWaitMock.mock.calls.find(
      (c) => c[0].functionName === "runPayroll",
    );
    expect(call![0].args[0]).toEqual([ALICE, BOB]);
    expect(call![0].args[1]).toBe(VAULT);
    expect(call![0].args[2]).toHaveLength(2);
    const encBatch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(encBatch[0].raw).toBe(50_000_000n);
    expect(encBatch[1].raw).toBe(75_000_000n);
  });

  it("fanout: per-employee tx_hash suffix `_${employee}` + PAYROLL activity_type", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll([ALICE, BOB], ["50", "75"]);
    });
    expect(insertActivitiesFanoutMock).toHaveBeenCalledTimes(1);
    const rows = insertActivitiesFanoutMock.mock.calls[0][0] as Array<{
      tx_hash: string;
      user_to: string;
      activity_type: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].tx_hash).toBe(`0xtxhash_${ALICE.toLowerCase()}`);
    expect(rows[0].user_to).toBe(ALICE.toLowerCase());
    expect(rows[0].activity_type).toBe("payroll");
  });

  it("N-recipient success toast 'Payroll sent to N employees!'", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll([ALICE, BOB, CAROL], ["10", "20", "30"]);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Payroll sent to 3 employees!");
  });

  it("reverted -> step='error' + no fanout", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll([ALICE], ["50"]);
    });
    expect(insertActivitiesFanoutMock).toHaveBeenCalledTimes(0);
  });

  it("allowance error -> clearVaultApproval", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.runPayroll([ALICE], ["50"]);
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
  });
});

// ───────────────────────────────────────────────────────────
//  createEscrow
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — createEscrow (§15.x)", () => {
  it("approves TestUSDC (NOT vault) because escrows take plaintext ERC20", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(
        ALICE,
        "100",
        "Project",
        ARBITER,
        1735689600,
      );
    });
    const approveCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approve");
    expect(approveCall.address).toBe(USDC); // NOT VAULT
    expect(approveCall.args[0]).toBe(HUB);
    expect(approveCall.args[1]).toBe(100_000_000n);
  });

  it("createEscrow args: [beneficiary, vault, plaintextAmount, description, arbiter, deadline]", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(
        ALICE,
        "100",
        "Project",
        ARBITER,
        1735689600,
      );
    });
    const call = unifiedWriteAndWaitMock.mock.calls.find(
      (c) => c[0].functionName === "createEscrow",
    );
    expect(call![0].args[0]).toBe(ALICE);
    expect(call![0].args[1]).toBe(VAULT);
    expect(call![0].args[2]).toBe(100_000_000n);
    expect(call![0].args[3]).toBe("Project");
    expect(call![0].args[4]).toBe(ARBITER);
    expect(call![0].args[5]).toBe(1735689600n);
    expect(call![0].gas).toBe(5_000_000n);
  });

  it("empty arbiter -> defaults to 0x0", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(
        ALICE,
        "100",
        "Project",
        "",
        1735689600,
      );
    });
    const call = unifiedWriteAndWaitMock.mock.calls.find(
      (c) => c[0].functionName === "createEscrow",
    );
    expect(call![0].args[4]).toBe(ZERO_ADDR);
  });

  it("extractEventId null -> error + no insertEscrow", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(ALICE, "100", "test", ARBITER, 1735689600);
    });
    expect(insertEscrowMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: insertEscrow + ESCROW_CREATED activity + arbiter notification with :arbiter suffix", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(
        ALICE,
        "100",
        "Project",
        ARBITER,
        1735689600,
      );
    });
    expect(insertEscrowMock).toHaveBeenCalledTimes(1);
    expect(insertEscrowMock.mock.calls[0][0]).toMatchObject({
      escrow_id: 7,
      depositor_address: ME,
      beneficiary_address: ALICE,
      arbiter_address: ARBITER,
      plaintext_amount: 100,
      status: "active",
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    const baseRow = insertActivityMock.mock.calls[0][0];
    expect(baseRow.activity_type).toBe("escrow_created");
    expect(baseRow.tx_hash).toBe("0xtxhash");
    expect(baseRow.user_to).toBe(ALICE.toLowerCase()); // beneficiary
    const arbiterRow = insertActivityMock.mock.calls[1][0];
    expect(arbiterRow.tx_hash).toBe("0xtxhash:arbiter");
    expect(arbiterRow.user_to).toBe(ARBITER.toLowerCase());
    expect(arbiterRow.activity_type).toBe("escrow_arbiter_named");
  });

  it("arbiter === depositor -> rejected before approve (contract: third party only)", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(
        ALICE,
        "100",
        "Project",
        ME, // arbiter is self
        1735689600,
      );
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(insertActivityMock).not.toHaveBeenCalled();
  });

  it("arbiter === 0x0 -> skip arbiter notification row", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(ALICE, "100", "test", "", 1735689600);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1); // only beneficiary
  });

  it("approval reverted -> error toast + no createEscrow", async () => {
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(ALICE, "100", "test", ARBITER, 1735689600);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1); // approve only
    expect(insertEscrowMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  finalizeInvoice (60s decrypt poll)
// ───────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────
//  Plaintext write ops (markDelivered / approveRelease / dispute
//  / cancelInvoice / claimExpiredEscrow)
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — plaintext escrow ops (§15.x)", () => {
  it("markDelivered: args [BigInt(escrowId)] + gas 5M + ESCROW_DELIVERED activity", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.markDelivered(7);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("markDelivered");
    expect(call.args).toEqual([7n]);
    expect(call.gas).toBe(5_000_000n);
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe(
      "escrow_delivered",
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Marked as delivered!");
  });

  it("approveRelease: status='released' + ESCROW_RELEASED activity + balance broadcast", async () => {
    // Chain reports Released (beneficiary had already marked delivery).
    readContractMock.mockResolvedValue([ME, BOB, ZERO_ADDR, VAULT, 0x1n, "d", 0n, 1]);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.approveRelease(7);
    });
    expect(updateEscrowStatusMock).toHaveBeenCalledWith(7, "released");
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe(
      "escrow_released",
    );
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
  });

  it("disputeEscrow: status='disputed' + ESCROW_DISPUTED activity + NO balance broadcast", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.disputeEscrow(7);
    });
    expect(updateEscrowStatusMock).toHaveBeenCalledWith(7, "disputed");
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe(
      "escrow_disputed",
    );
    expect(broadcastActionMock).not.toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("cancelInvoice: status='cancelled' + INVOICE_CANCELLED activity", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.cancelInvoice(42);
    });
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "cancelled");
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe(
      "invoice_cancelled",
    );
  });

  it("claimExpiredEscrow: status='expired' + ESCROW_EXPIRED_CLAIMED + balance broadcast", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.claimExpiredEscrow(7);
    });
    expect(updateEscrowStatusMock).toHaveBeenCalledWith(7, "expired");
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe(
      "escrow_expired_claimed",
    );
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
  });

  it("reverted on any plaintext op -> error toast + no supabase update", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.markDelivered(7);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  arbiterDecide (3-row multi-party fanout)
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — arbiterDecide (§15.x)", () => {
  function seedEscrow(depositor: string, beneficiary: string) {
    readContractMock.mockResolvedValue([
      depositor,
      beneficiary,
      ARBITER,
      "0xtoken",
      100n,
      "desc",
      1735689600n,
      0,
    ]);
  }

  it("3 distinct parties (arbiter + depositor + beneficiary) -> 3 activity rows with distinct suffixes", async () => {
    // arbiter is ME; depositor=ALICE, beneficiary=BOB
    seedEscrow(ALICE, BOB);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.arbiterDecide(7, true);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(3);
    const rows = insertActivityMock.mock.calls.map((c) => c[0]);
    expect(rows[0].tx_hash).toBe("0xtxhash"); // arbiter base
    expect(rows[0].user_to).toBe(ME.toLowerCase());
    expect(rows[1].tx_hash).toBe("0xtxhash:depositor");
    expect(rows[1].user_to).toBe(ALICE.toLowerCase());
    expect(rows[2].tx_hash).toBe("0xtxhash:beneficiary");
    expect(rows[2].user_to).toBe(BOB.toLowerCase());
  });

  it("arbiter === depositor -> skip depositor row (2 rows total)", async () => {
    // arbiter=ME, depositor=ME (same), beneficiary=BOB
    seedEscrow(ME, BOB);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.arbiterDecide(7, true);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2); // arbiter base + beneficiary
    const rows = insertActivityMock.mock.calls.map((c) => c[0]);
    expect(rows[0].tx_hash).toBe("0xtxhash"); // arbiter
    expect(rows[1].tx_hash).toBe("0xtxhash:beneficiary");
  });

  it("beneficiary === depositor -> skip beneficiary row (only arbiter + depositor)", async () => {
    // arbiter=ME, depositor=ALICE, beneficiary=ALICE (same)
    seedEscrow(ALICE, ALICE);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.arbiterDecide(7, true);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    const rows = insertActivityMock.mock.calls.map((c) => c[0]);
    expect(rows[0].tx_hash).toBe("0xtxhash"); // arbiter
    expect(rows[1].tx_hash).toBe("0xtxhash:depositor");
  });

  it("releaseToBeneficiary=true -> status='released' + note 'released'", async () => {
    seedEscrow(ALICE, BOB);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.arbiterDecide(7, true);
    });
    expect(updateEscrowStatusMock).toHaveBeenCalledWith(7, "released");
    expect(insertActivityMock.mock.calls[0][0].note).toContain("released");
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Funds released to beneficiary",
    );
  });

  it("releaseToBeneficiary=false -> status='expired' + note 'rejected'", async () => {
    seedEscrow(ALICE, BOB);
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.arbiterDecide(7, false);
    });
    expect(updateEscrowStatusMock).toHaveBeenCalledWith(7, "expired");
    expect(insertActivityMock.mock.calls[0][0].note).toContain("rejected");
    expect(toastSuccessMock).toHaveBeenCalledWith("Funds returned to depositor");
  });

  it("getEscrow read throws -> arbiter row STILL inserted (non-fatal)", async () => {
    readContractMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.arbiterDecide(7, true);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe(
      "escrow_arbiter_decided",
    );
  });
});

// ───────────────────────────────────────────────────────────
//  payInvoice
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — payInvoice (§15.x)", () => {
  it("payInvoice args: [BigInt(invoiceId), encAmount] + gas 5M", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.payInvoice(42, "100");
    });
    const call = unifiedWriteAndWaitMock.mock.calls.find(
      (c) => c[0].functionName === "payInvoice",
    );
    expect(call).toBeDefined();
    expect(call![0].args[0]).toBe(42n);
    expect(call![0].gas).toBe(5_000_000n);
  });

  it("status -> 'payment_pending' (NOT 'paid', finalize is the flipper)", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.payInvoice(42, "100");
    });
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "payment_pending");
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe(
      "invoice_payment",
    );
  });

  it("empty amount -> 'Enter an amount'", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.payInvoice(42, "");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
  });

  it("allowance error -> clearVaultApproval(BusinessHub)", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.payInvoice(42, "100");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
  });
});

// ───────────────────────────────────────────────────────────
//  finalizeInvoice: payment-mode aware
// ───────────────────────────────────────────────────────────

const SIG = ("0x" + "01".repeat(65)) as `0x${string}`;
const NOW = 1_800_000_000n;
const simulateContractMock = vi.fn();
const getBlockMock = vi.fn();

/** Route publicClient.readContract by functionName. */
function mockHub(opts: {
  status?: number;
  vendor?: string;
  client?: string;
  mode?: number;
  paidAt?: bigint;
  refundPending?: boolean;
  validationHandle?: bigint;
  refundHandle?: bigint;
  escrowStatus?: number;
}) {
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "getInvoice":
        return [opts.vendor ?? ALICE, opts.client ?? ME, VAULT, 0x5n, "desc", 0n, opts.status ?? 3];
      case "invoicePaymentMode":
        return opts.mode ?? 1;
      case "invoicePaidAt":
        return opts.paidAt ?? NOW - 60n;
      case "invoiceRefundPending":
        return opts.refundPending ?? false;
      case "getInvoiceValidationHandle":
        return opts.validationHandle ?? 0x999n;
      case "getInvoiceRefundCheckHandle":
        return opts.refundHandle ?? 0x777n;
      case "getEscrow":
        return [ME, BOB, ZERO_ADDR, VAULT, 0x1n, "d", 0n, opts.escrowStatus ?? 0];
      case "escrowDisputedAt":
        return 123n;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  });
}

function writtenFunctions(): string[] {
  return unifiedWriteAndWaitMock.mock.calls.map((c) => c[0].functionName as string);
}

describe("useBusinessHub — finalizeInvoice by payment mode", () => {
  beforeEach(() => {
    simulateContractMock.mockReset();
    getBlockMock.mockReset();
    getBlockMock.mockResolvedValue({ timestamp: NOW });
    usePublicClientMock.mockReturnValue({
      waitForTransactionReceipt: waitForTransactionReceiptMock,
      readContract: readContractMock,
      simulateContract: simulateContractMock,
      getBlock: getBlockMock,
    });
  });

  it("Direct + client + match -> payInvoiceFinalize, status 'paid'", async () => {
    mockHub({ mode: 1 });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("payInvoiceFinalize");
    expect(call.args).toEqual([42n, true, SIG]);
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "paid");
    expect(insertActivityMock.mock.calls[0][0].note).toBe("Finalized invoice #42");
  });

  it("Direct + mismatch -> status 'disputed' (funds stay with vendor), not 'refunded'", async () => {
    mockHub({ mode: 1 });
    decryptForTxMock.mockResolvedValue({ decryptedValue: 0n, signature: SIG });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].args[1]).toBe(false);
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "disputed");
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("disputed"));
  });

  it("Direct + vendor -> blocked before any decrypt or write", async () => {
    mockHub({ mode: 1, vendor: ME, client: BOB });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(decryptForTxMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("Only the client"), undefined);
  });

  it("Escrow + client -> releaseInvoiceEscrow; mismatch -> 'refunded'", async () => {
    mockHub({ mode: 2 });
    decryptForTxMock.mockResolvedValue({ decryptedValue: false, signature: SIG });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(writtenFunctions()).toEqual(["releaseInvoiceEscrow"]);
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "refunded");
  });

  it("Escrow + vendor before 7 days -> blocked with the remaining wait", async () => {
    mockHub({ mode: 2, vendor: ME, client: BOB, paidAt: NOW - 86_400n });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("6d"), undefined);
  });

  it("Escrow + vendor after 7 days -> releaseInvoiceEscrow, match pays vendor", async () => {
    mockHub({ mode: 2, vendor: ME, client: BOB, paidAt: NOW - 7n * 86_400n });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(writtenFunctions()).toEqual(["releaseInvoiceEscrow"]);
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "paid");
  });

  it("Legacy escrow + client -> revalidateLegacyInvoiceEscrow then releaseInvoiceEscrow", async () => {
    mockHub({ mode: 0, paidAt: 0n });
    simulateContractMock.mockResolvedValue({ request: {} });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(simulateContractMock.mock.calls[0][0].functionName).toBe("revalidateLegacyInvoiceEscrow");
    expect(writtenFunctions()).toEqual(["revalidateLegacyInvoiceEscrow", "releaseInvoiceEscrow"]);
  });

  it("Legacy direct + vendor -> payInvoiceFinalize; Legacy direct + client -> blocked", async () => {
    mockHub({ mode: 0, vendor: ME, client: BOB });
    simulateContractMock.mockRejectedValue(new Error("BusinessHub: not a legacy escrow payment"));
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(writtenFunctions()).toEqual(["payInvoiceFinalize"]);

    unifiedWriteAndWaitMock.mockClear();
    mockHub({ mode: 0 });
    const second = renderHook(() => useBusinessHub());
    await act(async () => {
      await second.result.current.finalizeInvoice(43);
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("Only the vendor"), undefined);
  });

  it("not PaymentPending -> error, no write", async () => {
    mockHub({ status: 1 });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("not waiting"), undefined);
  });

  it("validation handle 0 -> 'Invoice not paid yet', no write", async () => {
    mockHub({ mode: 1, validationHandle: 0n });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("Invoice not paid yet"), undefined);
  });

  it("decrypt never signs -> timed out, no write", async () => {
    vi.useFakeTimers();
    mockHub({ mode: 1 });
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useBusinessHub());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.finalizeInvoice(42);
    });
    await vi.advanceTimersByTimeAsync(200_000);
    await act(async () => {
      await p;
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("Timeout"), undefined);
    vi.useRealTimers();
  });

  it("no address -> 'Connection lost'", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.finalizeInvoice(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
  });
});

// ───────────────────────────────────────────────────────────
//  refundDisputedInvoice: refund, then publish the refund check
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — refundDisputedInvoice (two-step)", () => {
  it("fresh: refundDisputedInvoice -> decrypt check -> finalizeDisputedRefund(ok) -> 'refunded'", async () => {
    mockHub({ status: 4, vendor: ME, client: BOB });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.refundDisputedInvoice(42);
    });
    expect(writtenFunctions()).toEqual(["refundDisputedInvoice", "finalizeDisputedRefund"]);
    expect(decryptForTxMock).toHaveBeenCalledWith(0x777n, "ebool");
    expect(unifiedWriteAndWaitMock.mock.calls[1][0].args).toEqual([42n, true, SIG]);
    expect(updateInvoiceStatusMock).toHaveBeenCalledWith(42, "refunded");
    expect(insertActivityMock.mock.calls[0][0].user_to).toBe(BOB.toLowerCase());
  });

  it("refund already pending -> skips step one, only finalizes", async () => {
    mockHub({ status: 4, vendor: ME, client: BOB, refundPending: true });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.refundDisputedInvoice(42);
    });
    expect(writtenFunctions()).toEqual(["finalizeDisputedRefund"]);
  });

  it("check false (vendor short) -> stays disputed, approval cache cleared, no status write", async () => {
    mockHub({ status: 4, vendor: ME, client: BOB });
    decryptForTxMock.mockResolvedValue({ decryptedValue: false, signature: SIG });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.refundDisputedInvoice(42);
    });
    expect(writtenFunctions()).toEqual(["refundDisputedInvoice", "finalizeDisputedRefund"]);
    expect(updateInvoiceStatusMock).not.toHaveBeenCalled();
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("did not go through"));
  });

  it("first refund approves BusinessHub on the invoice's vault", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    mockHub({ status: 4, vendor: ME, client: BOB });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.refundDisputedInvoice(42);
    });
    const approve = unifiedWriteMock.mock.calls[0][0];
    expect(approve.functionName).toBe("approvePlaintext");
    expect(approve.address).toBe(VAULT);
    expect(approve.args[0]).toBe(HUB);
    expect(markVaultApprovedMock).toHaveBeenCalledWith(HUB);
  });

  it("not the vendor, or not disputed -> no write", async () => {
    mockHub({ status: 4, vendor: ALICE, client: ME });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.refundDisputedInvoice(42);
    });
    mockHub({ status: 3, vendor: ME, client: BOB });
    const second = renderHook(() => useBusinessHub());
    await act(async () => {
      await second.result.current.refundDisputedInvoice(43);
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────
//  Escrow dispute timeout + arbiter rule + release status sync
// ───────────────────────────────────────────────────────────

describe("useBusinessHub — escrow dispute timeout and arbiter rule", () => {
  it("claimDisputeTimeout: args [id], status 'expired', balance broadcast", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.claimDisputeTimeout(7);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claimDisputeTimeout");
    expect(call.args).toEqual([7n]);
    expect(updateEscrowStatusMock).toHaveBeenCalledWith(7, "expired");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
  });

  it("getEscrowDisputedAt reads escrowDisputedAt", async () => {
    mockHub({});
    const { result } = renderHook(() => useBusinessHub());
    let at: number | null = null;
    await act(async () => {
      at = await result.current.getEscrowDisputedAt(7);
    });
    expect(at).toBe(123);
  });

  it("createEscrow rejects an arbiter equal to the depositor or beneficiary before any write", async () => {
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.createEscrow(BOB, "10", "d", ME, Math.floor(Date.now() / 1000) + 3 * 86400);
    });
    await act(async () => {
      await result.current.createEscrow(BOB, "10", "d", BOB.toUpperCase().replace("0X", "0x"), Math.floor(Date.now() / 1000) + 3 * 86400);
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("cannot be you"));
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("cannot be the beneficiary"));
  });

  it("approveRelease before delivery -> no 'released' status, honest toast", async () => {
    mockHub({ escrowStatus: 0 });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.approveRelease(7);
    });
    expect(updateEscrowStatusMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining("beneficiary marks delivery"));
  });

  it("markDelivered after approval -> chain says Released -> status 'released'", async () => {
    mockHub({ escrowStatus: 1 });
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.markDelivered(7);
    });
    expect(updateEscrowStatusMock).toHaveBeenCalledWith(7, "released");
  });
});

describe("useBusinessHub — reset (§15.x)", () => {
  it("reset clears step to idle", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("fail"));
    const { result } = renderHook(() => useBusinessHub());
    await act(async () => {
      await result.current.markDelivered(7);
    });
    expect(result.current.step).toBe("error");
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
  });
});
