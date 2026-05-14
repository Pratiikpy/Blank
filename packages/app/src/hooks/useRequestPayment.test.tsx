import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useRequestPayment. Phase 1.3 payment-request flow:
//   createRequest(payer, amount, note, payerEmail?) — requester asks for
//     encrypted USDC. Emits onchain row + supabase row + optional email
//     to the payer's address.
//   fulfillRequest(reqId, amount, requesterAddress) — payer fulfills the
//     ask with their own encrypted amount.
//   cancelRequest(reqId) — requester cancels a pending request.
//
// CRITICAL pins:
//   - Semantics named in the source comment: `from`=PAYER (being asked
//     to pay), `address` (current user)=REQUESTER. Supabase columns:
//     from_address=payer, to_address=requester. Inverting these would
//     send the request to the wrong inbox.
//   - createRequest extractEventId returns the on-chain requestId from
//     event logs; null result throws "Tx mined but requestId could not
//     be read" rather than silently inserting a row with no id.
//   - #89 fix: createRequest fires broadcastAction("activity_added") +
//     broadcastAction("balance_changed") + invalidateBalanceQueries.
//     Previously skipped, leaving the payer's notification hook + feed
//     + balance cache stale until next full reload.
//   - #234 fix: cancelRequest ALSO fires both broadcasts +
//     invalidateBalanceQueries. Previously skipped, so the requester's
//     own list kept the cancelled row visible until reload.
//   - Phase 1.3 email pipeline is fire-and-forget — the on-chain
//     request is already recorded by the time it runs, so a failed
//     signEmailAuth / lookupName / sendPaymentRequestEmail call MUST
//     NOT throw / reject / fail the surrounding createRequest. Each
//     failure surfaces a log.warn but the user sees "Payment request
//     sent" toast regardless.
//   - signEmailAuth failure (passphrase cancel, wrong pass, etc.) is
//     caught and email sent WITHOUT auth (server falls through to
//     soft-mode). Without this try/catch, the user's cancel-passphrase
//     click would crash the email pipeline (which was already async).
//   - fulfillRequest approval cache + error-discriminator pattern:
//     first call approves MAX_UINT64; subsequent skip. Allowance /
//     approve / insufficient / transfer-amount errors trigger
//     clearVaultApproval(PaymentHub) so the next attempt re-approves
//     (covers external-revoke + contract-upgrade). Unrelated errors
//     (rpc timeout) leave the cache alone.
//   - Reverted receipt on all three ops -> throws + sets step=error +
//     SKIPS supabase write + SKIPS broadcastAction (audit invariant).
//   - Single-flight gate via `step === "encrypting" || step === "sending"`
//     on createRequest + fulfillRequest. cancelRequest uses the SAME
//     check (defensive) so a user can't accidentally cancel mid-create.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useEmailAuthSignerMock = vi.hoisted(() => vi.fn());
const insertPaymentRequestMock = vi.hoisted(() => vi.fn());
const updateRequestStatusMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const extractEventIdMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const clearVaultApprovalMock = vi.hoisted(() => vi.fn());
const lookupNameMock = vi.hoisted(() => vi.fn());
const sendPaymentRequestEmailMock = vi.hoisted(() => vi.fn());
const buildRequestEmailSignableMessageMock = vi.hoisted(() => vi.fn());
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
vi.mock("./useEmailAuthSigner", () => ({
  useEmailAuthSigner: useEmailAuthSignerMock,
}));
vi.mock("@/lib/supabase", () => ({
  insertPaymentRequest: insertPaymentRequestMock,
  updateRequestStatus: updateRequestStatusMock,
  insertActivity: insertActivityMock,
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
vi.mock("@/lib/address-resolver", () => ({ lookupName: lookupNameMock }));
vi.mock("@/lib/address", () => ({
  truncateAddress: (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`,
}));
vi.mock("@/lib/email-client", () => ({
  sendPaymentRequestEmail: sendPaymentRequestEmailMock,
  buildRequestEmailSignableMessage: buildRequestEmailSignableMessageMock,
}));
vi.mock("@/lib/abis", () => ({ PaymentHubAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), debug: vi.fn() } }));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useRequestPayment } from "./useRequestPayment";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HUB = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";

const encryptInputsAsyncMock = vi.fn();
const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const signEmailAuthMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheEncryptMock.mockReset();
  useCofheConnectionMock.mockReset();
  useEmailAuthSignerMock.mockReset();
  insertPaymentRequestMock.mockReset();
  updateRequestStatusMock.mockReset();
  insertActivityMock.mockReset();
  extractEventIdMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  lookupNameMock.mockReset();
  sendPaymentRequestEmailMock.mockReset();
  buildRequestEmailSignableMessageMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  signEmailAuthMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { PaymentHub: HUB, FHERC20Vault_USDC: VAULT },
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
  useEmailAuthSignerMock.mockReturnValue({ signEmailAuth: signEmailAuthMock });
  toastLoadingMock.mockReturnValue("toast-id");
  isVaultApprovedMock.mockReturnValue(true);
  encryptInputsAsyncMock.mockResolvedValue([
    { ctHash: 0x42n, securityZone: 0, utype: 5, signature: "0xenc" },
  ]);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: { status: "success", blockNumber: 12345n, logs: [] },
  });
  extractEventIdMock.mockReturnValue(42);
  insertPaymentRequestMock.mockResolvedValue(undefined);
  updateRequestStatusMock.mockResolvedValue(undefined);
  insertActivityMock.mockResolvedValue(undefined);
  lookupNameMock.mockResolvedValue(null);
  buildRequestEmailSignableMessageMock.mockReturnValue("signable-message");
  signEmailAuthMock.mockResolvedValue({
    signature: "0xsig",
    signerAddress: ME,
    signedAt: 1234,
    signerChainId: 11155111,
  });
  sendPaymentRequestEmailMock.mockResolvedValue({ ok: true });
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useRequestPayment — initial state (§15.x)", () => {
  it("returns step='input' + null error + null requestId + 4 callable handlers", () => {
    const { result } = renderHook(() => useRequestPayment());
    expect(result.current.step).toBe("input");
    expect(result.current.error).toBeNull();
    expect(result.current.requestId).toBeNull();
    expect(typeof result.current.createRequest).toBe("function");
    expect(typeof result.current.fulfillRequest).toBe("function");
    expect(typeof result.current.cancelRequest).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  createRequest guards
// ───────────────────────────────────────────────────────────

describe("useRequestPayment — createRequest guards (§15.x)", () => {
  it("no address -> silent early return (no toast, no write)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "note");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledTimes(0);
  });

  it("cofhe not connected -> silent early return", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "note");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "note");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost. Please refresh.");
  });

  it("empty amount -> 'Enter an amount' toast + no write", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "", "note");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("whitespace amount -> 'Enter an amount' toast", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "   ", "note");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
  });
});

// ───────────────────────────────────────────────────────────
//  createRequest happy path
// ───────────────────────────────────────────────────────────

describe("useRequestPayment — createRequest happy path (§15.x)", () => {
  it("calls createRequest with (payer, vault, encAmount, note)", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "50", "Coffee");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(HUB);
    expect(call.functionName).toBe("createRequest");
    expect(call.args[0]).toBe(PAYER);
    expect(call.args[1]).toBe(VAULT);
    expect(call.args[3]).toBe("Coffee");
    expect(call.gas).toBe(5_000_000n);
  });

  it("parseUnits with 6 decimals applied to amount", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "2.5", "n");
    });
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(2_500_000n);
  });

  it("step transitions: input -> encrypting -> sending -> success", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(result.current.step).toBe("success");
  });

  it("supabase semantics: from_address=PAYER (lowercased), to_address=REQUESTER (lowercased)", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER.toUpperCase(), "10", "n");
    });
    const row = insertPaymentRequestMock.mock.calls[0][0];
    expect(row.from_address).toBe(PAYER.toLowerCase());
    expect(row.to_address).toBe(ME.toLowerCase());
    expect(row.status).toBe("pending");
    expect(row.tx_hash).toBe("0xtxhash");
    expect(row.token_address).toBe(VAULT);
  });

  it("supabase row carries the request id from extractEventId", async () => {
    extractEventIdMock.mockReturnValue(99);
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(insertPaymentRequestMock.mock.calls[0][0].request_id).toBe(99);
  });

  it("activity row: REQUEST_CREATED type + user_from=REQUESTER + user_to=PAYER (sender perspective)", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "Lunch");
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("request_created");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(PAYER.toLowerCase());
    expect(row.note).toBe("Lunch");
    expect(row.block_number).toBe(12345);
  });

  it("#89: createRequest fires balance_changed + activity_added broadcasts + invalidateBalanceQueries", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("success toast 'Payment request sent!' fires", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Payment request sent!");
  });

  it("AA path skips waitForTransactionReceipt", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xaa",
      receipt: { status: "success", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("EOA path falls back to waitForTransactionReceipt with 300s timeout", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({ hash: "0xeoa", receipt: undefined });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "success",
      blockNumber: 5555n,
      logs: [],
    });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
      timeout: 300_000,
    });
  });
});

// ───────────────────────────────────────────────────────────
//  createRequest error path
// ───────────────────────────────────────────────────────────

describe("useRequestPayment — createRequest error path (§15.x)", () => {
  it("reverted receipt -> step=error + NO supabase writes + NO broadcast", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("Transaction reverted on-chain");
    expect(insertPaymentRequestMock).toHaveBeenCalledTimes(0);
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith("Request failed");
  });

  it("extractEventId null -> 'requestId could not be read' error", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toContain("requestId could not be read");
    expect(insertPaymentRequestMock).toHaveBeenCalledTimes(0);
  });

  it("write rejection -> step=error + generic 'Request failed' toast", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("user rejected");
    expect(toastErrorMock).toHaveBeenCalledWith("Request failed");
  });
});

// ───────────────────────────────────────────────────────────
//  Email pipeline (Phase 1.3)
// ───────────────────────────────────────────────────────────

describe("useRequestPayment — email pipeline (Phase 1.3) (§15.x)", () => {
  async function flushMicrotasks() {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  }

  it("no email provided -> no signEmailAuth + no sendPaymentRequestEmail", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    await flushMicrotasks();
    expect(signEmailAuthMock).toHaveBeenCalledTimes(0);
    expect(sendPaymentRequestEmailMock).toHaveBeenCalledTimes(0);
  });

  it("empty email string -> no email fired", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "");
    });
    await flushMicrotasks();
    expect(signEmailAuthMock).toHaveBeenCalledTimes(0);
  });

  it("whitespace-only email -> no email (trimmed empty)", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "   ");
    });
    await flushMicrotasks();
    expect(signEmailAuthMock).toHaveBeenCalledTimes(0);
  });

  it("email provided -> signEmailAuth + sendPaymentRequestEmail fired (fire-and-forget)", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "payer@example.com");
    });
    await flushMicrotasks();
    expect(signEmailAuthMock).toHaveBeenCalledTimes(1);
    expect(sendPaymentRequestEmailMock).toHaveBeenCalledTimes(1);
  });

  it("supabase row stores trimmed email under payer_email", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "  payer@example.com  ");
    });
    expect(insertPaymentRequestMock.mock.calls[0][0].payer_email).toBe(
      "payer@example.com",
    );
  });

  it("no email -> payer_email persisted as null", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(insertPaymentRequestMock.mock.calls[0][0].payer_email).toBeNull();
  });

  it("signEmailAuth rejection (e.g. passphrase cancel) -> email still sent WITHOUT auth", async () => {
    signEmailAuthMock.mockRejectedValue(new Error("user cancelled passphrase"));
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "payer@example.com");
    });
    await flushMicrotasks();
    expect(sendPaymentRequestEmailMock).toHaveBeenCalledTimes(1);
    // Verify no signature field passed when auth failed
    const args = sendPaymentRequestEmailMock.mock.calls[0][0];
    expect(args.signature).toBeUndefined();
  });

  it("signEmailAuth returns null -> email still sent WITHOUT auth (server soft-mode)", async () => {
    signEmailAuthMock.mockResolvedValue(null);
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "payer@example.com");
    });
    await flushMicrotasks();
    expect(sendPaymentRequestEmailMock).toHaveBeenCalledTimes(1);
    const args = sendPaymentRequestEmailMock.mock.calls[0][0];
    expect(args.signature).toBeUndefined();
  });

  it("email pipeline failure does NOT affect on-chain success toast", async () => {
    sendPaymentRequestEmailMock.mockResolvedValue({ ok: false, error: "smtp down" });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "payer@example.com");
    });
    await flushMicrotasks();
    // Success toast STILL fires — email is fire-and-forget
    expect(toastSuccessMock).toHaveBeenCalledWith("Payment request sent!");
    expect(result.current.step).toBe("success");
  });

  it("email pipeline throw does NOT crash createRequest", async () => {
    sendPaymentRequestEmailMock.mockRejectedValue(new Error("network unreachable"));
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "payer@example.com");
    });
    await flushMicrotasks();
    expect(toastSuccessMock).toHaveBeenCalledWith("Payment request sent!");
    expect(result.current.step).toBe("success");
  });

  it("requesterName uses ENS lookup when available, truncated address otherwise", async () => {
    lookupNameMock.mockResolvedValue("alice.eth");
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "payer@example.com");
    });
    await flushMicrotasks();
    expect(sendPaymentRequestEmailMock.mock.calls[0][0].requesterName).toBe(
      "alice.eth",
    );
  });

  it("requesterName falls back to truncateAddress when ENS lookup returns null", async () => {
    lookupNameMock.mockResolvedValue(null);
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "payer@example.com");
    });
    await flushMicrotasks();
    const args = sendPaymentRequestEmailMock.mock.calls[0][0];
    expect(args.requesterName).toBe(`${ME.slice(0, 6)}...${ME.slice(-4)}`);
  });

  it("buildRequestEmailSignableMessage gets (requestId, recipient, signedAt, chainId)", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n", "payer@example.com");
    });
    await flushMicrotasks();
    expect(buildRequestEmailSignableMessageMock).toHaveBeenCalledTimes(1);
    const args = buildRequestEmailSignableMessageMock.mock.calls[0][0];
    expect(args.requestId).toBe(42);
    expect(args.recipient).toBe("payer@example.com");
    expect(typeof args.signedAt).toBe("number");
    expect(args.chainId).toBe(11155111);
  });
});

// ───────────────────────────────────────────────────────────
//  fulfillRequest
// ───────────────────────────────────────────────────────────

describe("useRequestPayment — fulfillRequest (§15.x)", () => {
  it("no address -> silent return + no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", PAYER);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty amount -> 'Enter an amount' toast", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "", PAYER);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("first fulfill: approves vault + markVaultApproved + then fulfillRequest", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(2);
    // First call: approve
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe(
      "approvePlaintext",
    );
    expect(markVaultApprovedMock).toHaveBeenCalledWith(HUB);
    // Second call: fulfillRequest
    expect(unifiedWriteAndWaitMock.mock.calls[1][0].functionName).toBe(
      "fulfillRequest",
    );
  });

  it("pre-approved -> single fulfillRequest call, no approval", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe(
      "fulfillRequest",
    );
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval reverted on-chain -> throws + main fulfillRequest NOT called", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xrev",
      receipt: { status: "reverted" },
    });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
    expect(result.current.step).toBe("error");
  });

  it("fulfillRequest call shape: (BigInt(reqId), encAmount) + gas 5M", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(99, "25", ME);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("fulfillRequest");
    expect(call.args[0]).toBe(99n);
    expect(call.gas).toBe(5_000_000n);
  });

  it("reverted fulfill receipt -> step=error + NO supabase write", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n },
    });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(result.current.step).toBe("error");
    expect(updateRequestStatusMock).toHaveBeenCalledTimes(0);
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: updateRequestStatus('fulfilled') + activity row REQUEST_FULFILLED", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(updateRequestStatusMock).toHaveBeenCalledWith("7", "fulfilled");
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("request_fulfilled");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ME.toLowerCase());
  });

  it("broadcastAction TWICE (balance + activity) + invalidate on success", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith("Request fulfilled!");
  });

  it("error-discriminator: allowance error -> clearVaultApproval(HUB)", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
    expect(result.current.step).toBe("error");
  });

  it("error-discriminator: 'transfer amount exceeds' error -> clearVaultApproval fires", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(
      new Error("ERC20: transfer amount exceeds balance"),
    );
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
  });

  it("error-discriminator: unrelated error (rpc timeout) -> clearVaultApproval NOT called", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc timeout"));
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.fulfillRequest(7, "10", ME);
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  cancelRequest (#234 broadcast fix)
// ───────────────────────────────────────────────────────────

describe("useRequestPayment — cancelRequest (§15.x)", () => {
  it("no address -> silent return", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.cancelRequest(7);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> silent return", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.cancelRequest(7);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("calls cancelRequest with BigInt(reqId) + gas 5M", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.cancelRequest(42);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(HUB);
    expect(call.functionName).toBe("cancelRequest");
    expect(call.args[0]).toBe(42n);
    expect(call.gas).toBe(5_000_000n);
  });

  it("updates request status to 'cancelled' + #234 broadcast TWICE + invalidate", async () => {
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.cancelRequest(42);
    });
    expect(updateRequestStatusMock).toHaveBeenCalledWith("42", "cancelled");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith("Request cancelled");
  });

  it("reverted receipt -> 'Failed to cancel' toast + NO status update + NO broadcast", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted" },
    });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.cancelRequest(42);
    });
    expect(updateRequestStatusMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to cancel");
  });

  it("write rejection -> 'Failed to cancel' toast", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.cancelRequest(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to cancel");
    expect(updateRequestStatusMock).toHaveBeenCalledTimes(0);
  });

  it("EOA path: no receipt on result -> waitForTransactionReceipt with 300s timeout", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({ hash: "0xeoa", receipt: undefined });
    waitForTransactionReceiptMock.mockResolvedValue({ status: "success" });
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.cancelRequest(42);
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
      timeout: 300_000,
    });
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useRequestPayment — reset (§15.x)", () => {
  it("reset clears step/error/requestId back to input/null", async () => {
    unifiedWriteAndWaitMock.mockRejectedValueOnce(new Error("test fail"));
    const { result } = renderHook(() => useRequestPayment());
    await act(async () => {
      await result.current.createRequest(PAYER, "10", "n");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("test fail");
    act(() => result.current.reset());
    expect(result.current.step).toBe("input");
    expect(result.current.error).toBeNull();
    expect(result.current.requestId).toBeNull();
  });
});
