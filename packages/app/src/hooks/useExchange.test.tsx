import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useExchange. P2P swap offer hook driving the Swap
// screen's offer-listing surface: createOffer (PUBLIC amounts for
// discovery), fillOffer (encrypted taker + maker amounts), cancelOffer,
// verifyTrade (threshold-decrypt amount-match verdict + publish),
// getTradeValidation (read on-chain verdict). Also exposes the offer
// list + realtime supabase subscription.
//
// CRITICAL pins:
//   - 3-state Step ladder (idle / approving / sending / success /
//     error). Concurrent-submit guard via `step === "approving" || step
//     === "sending"` on createOffer; fillOffer uses `step === "sending"`.
//   - createOffer: PUBLIC amounts intentionally — exchange_offers.sql
//     has plaintext amount_give + amount_want columns because the
//     contract P2PExchange.sol uses public uint256 amounts for order
//     matching. The encryption-on-fill design preserves privacy of
//     INTENT (no on-chain link from offer to filler's identity) without
//     hiding the orderbook itself.
//   - createOffer fallback for missing tokenWant vault: if
//     contracts.FHERC20Vault_USDT is undefined, falls back to
//     FHERC20Vault_USDC; the contract will revert "same token" but the
//     fallback surfaces missing-deployment as an actionable error
//     rather than a silent UI hang.
//   - 4-branch amount validation: empty give, empty want, NaN/<=0 give,
//     NaN/<=0 want each toast + setStep("idle") + return. Fires AFTER
//     approval but BEFORE encryption so the approval flow is wasted
//     in the bad-input case — minor UX concern documented in source.
//   - First-time approval flow: unifiedWriteAndWait for the approve +
//     wait receipt + markVaultApproved + 3_000ms RPC settlement sleep
//     (audit fix for "two consecutive UserOps see same nonce" AA25);
//     subsequent createOffer calls skip approve.
//   - Error-discriminator pattern: only allowance/approve/insufficient/
//     transfer-amount errors trigger clearVaultApproval (covers
//     external-revoke); unrelated errors (rpc timeout) leave cache
//     alone.
//   - fillOffer verifyVaultApproved CHECK pattern (different from
//     other hooks): reads ON-CHAIN allowance before deciding whether
//     to fire approve — covers cross-device recovery + fresh
//     localStorage; markVaultApproved cache becomes a HINT not the
//     only signal.
//   - fillOffer DUAL-ROW activity insert: primary maker-side row
//     (taker -> maker, "your offer was filled" notif) + secondary
//     taker-side row (user_from=user_to=taker, ":taker" tx_hash
//     suffix for dedup) ONLY when taker !== maker; self-fill (rare)
//     inserts ONE row.
//   - fillOffer offer-state error mapping: /not active|cancelled|
//     expired|already filled/i regex -> "This offer is no longer
//     available — it was cancelled or filled by another user"
//     (specific). Other errors fall through to "Transaction failed:
//     <truncated>".
//   - cancelOffer single-flight via isCancelling ref (separate from
//     step state because user might be filling another offer while
//     cancelling).
//   - verifyTrade 60s threshold-decrypt poll + plaintext normalization
//     (boolean / bigint 0n / bigint nonzero); validPlaintext drives
//     distinct activity_type (EXCHANGE_VERIFIED vs EXCHANGE_INVALID)
//     + note text + toast copy.
//   - verifyTrade single-flight via verifyingOfferId state — prevents
//     two concurrent decrypt-polls on different offers (could happen
//     if user mashes Verify on multiple rows).
//   - extractEventId null on createOffer -> throws "offerId could not
//     be read; check History tab" rather than silently inserting with
//     no id.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useCofheDecryptForTxMock = vi.hoisted(() => vi.fn());
const supabaseMock = vi.hoisted(() => ({
  channel: vi.fn(),
  removeChannel: vi.fn(),
}));
const insertExchangeOfferMock = vi.hoisted(() => vi.fn());
const fetchActiveOffersMock = vi.hoisted(() => vi.fn());
const fetchFilledOffersForUserMock = vi.hoisted(() => vi.fn());
const updateOfferStatusMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const extractEventIdMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const clearVaultApprovalMock = vi.hoisted(() => vi.fn());
const verifyVaultApprovedMock = vi.hoisted(() => vi.fn());
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
vi.mock("@/lib/supabase", () => ({
  supabase: supabaseMock,
  insertExchangeOffer: insertExchangeOfferMock,
  fetchActiveOffers: fetchActiveOffersMock,
  fetchFilledOffersForUser: fetchFilledOffersForUserMock,
  updateOfferStatus: updateOfferStatusMock,
  insertActivity: insertActivityMock,
}));
vi.mock("@/lib/abis", () => ({ P2PExchangeAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/event-parser", () => ({ extractEventId: extractEventIdMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
  clearVaultApproval: clearVaultApprovalMock,
  verifyVaultApproved: verifyVaultApprovedMock,
}));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useExchange } from "./useExchange";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const MAKER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const P2P = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const VAULT_USDC = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const VAULT_USDT = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const SIGNATURE = ("0x" + "01".repeat(65)) as `0x${string}`;

const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const encryptInputsAsyncMock = vi.fn();
const decryptForTxMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const readContractMock = vi.fn();

let supabaseChannelHandler: ((payload: unknown) => void) | undefined;

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheEncryptMock.mockReset();
  useCofheDecryptForTxMock.mockReset();
  supabaseMock.channel.mockReset();
  supabaseMock.removeChannel.mockReset();
  insertExchangeOfferMock.mockReset();
  fetchActiveOffersMock.mockReset();
  fetchFilledOffersForUserMock.mockReset();
  updateOfferStatusMock.mockReset();
  insertActivityMock.mockReset();
  extractEventIdMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  verifyVaultApprovedMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  decryptForTxMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  readContractMock.mockReset();
  supabaseChannelHandler = undefined;

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      P2PExchange: P2P,
      FHERC20Vault_USDC: VAULT_USDC,
      FHERC20Vault_USDT: VAULT_USDT,
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
  isVaultApprovedMock.mockReturnValue(true);
  verifyVaultApprovedMock.mockResolvedValue(true);
  fetchActiveOffersMock.mockResolvedValue([]);
  fetchFilledOffersForUserMock.mockResolvedValue([]);
  insertExchangeOfferMock.mockResolvedValue(undefined);
  updateOfferStatusMock.mockResolvedValue(undefined);
  insertActivityMock.mockResolvedValue(undefined);
  extractEventIdMock.mockReturnValue(42);
  toastLoadingMock.mockReturnValue("toast-id");
  unifiedWriteMock.mockResolvedValue("0xtxhash" as `0x${string}`);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash" as `0x${string}`,
    receipt: { status: "success", blockNumber: 1n, logs: [] },
  });
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 1n,
    logs: [],
  });
  encryptInputsAsyncMock.mockResolvedValue([
    { ctHash: 0x42n, securityZone: 0, utype: 5, signature: "0xenc1" },
    { ctHash: 0x43n, securityZone: 0, utype: 5, signature: "0xenc2" },
  ]);
  decryptForTxMock.mockResolvedValue({
    decryptedValue: true,
    signature: SIGNATURE,
  });
  // Supabase realtime mock: capture the postgres_changes handler
  supabaseMock.channel.mockReturnValue({
    on: (_event: string, _filter: unknown, handler: (p: unknown) => void) => {
      supabaseChannelHandler = handler;
      return {
        subscribe: () => ({ id: "ch-1" }),
      };
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────
//  Initial state + offer loading
// ───────────────────────────────────────────────────────────

describe("useExchange — initial state (§15.x)", () => {
  it("returns idle step + empty offers + 6 callable handlers + verifyingOfferId=null", async () => {
    const { result } = renderHook(() => useExchange());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.offers).toEqual([]);
    expect(result.current.filledOffers).toEqual([]);
    expect(result.current.verifyingOfferId).toBeNull();
    expect(typeof result.current.createOffer).toBe("function");
    expect(typeof result.current.fillOffer).toBe("function");
    expect(typeof result.current.cancelOffer).toBe("function");
    expect(typeof result.current.verifyTrade).toBe("function");
    expect(typeof result.current.getTradeValidation).toBe("function");
    expect(typeof result.current.loadOffers).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });

  it("loadOffers fires on mount + populates offers + filledOffers", async () => {
    fetchActiveOffersMock.mockResolvedValue([
      { offer_id: 1, maker_address: MAKER, amount_give: 100, amount_want: 50, status: "active" },
    ]);
    fetchFilledOffersForUserMock.mockResolvedValue([
      { offer_id: 2, maker_address: ME, status: "filled" },
    ]);
    const { result } = renderHook(() => useExchange());
    await waitFor(() => expect(result.current.offers).toHaveLength(1));
    expect(result.current.filledOffers).toHaveLength(1);
    expect(fetchActiveOffersMock).toHaveBeenCalled();
    expect(fetchFilledOffersForUserMock).toHaveBeenCalledWith(ME);
  });

  it("no address -> filledOffers stays empty (no fetch for filled)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    fetchActiveOffersMock.mockResolvedValue([{ offer_id: 1 }]);
    const { result } = renderHook(() => useExchange());
    await waitFor(() => expect(result.current.offers).toHaveLength(1));
    expect(result.current.filledOffers).toEqual([]);
    expect(fetchFilledOffersForUserMock).toHaveBeenCalledTimes(0);
  });

  it("isLoadingOffers flips true during fetch + false after", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    fetchActiveOffersMock.mockReturnValue(
      new Promise((res) => {
        resolveFetch = res;
      }),
    );
    const { result } = renderHook(() => useExchange());
    await waitFor(() => expect(result.current.isLoadingOffers).toBe(true));
    resolveFetch([]);
    await waitFor(() => expect(result.current.isLoadingOffers).toBe(false));
  });
});

// ───────────────────────────────────────────────────────────
//  Realtime subscription
// ───────────────────────────────────────────────────────────

describe("useExchange — realtime subscription (§15.x)", () => {
  it("subscribes to exchange_offers postgres_changes channel on mount", async () => {
    renderHook(() => useExchange());
    await waitFor(() => expect(supabaseMock.channel).toHaveBeenCalled());
    expect(supabaseMock.channel).toHaveBeenCalledWith("exchange_offers_realtime");
  });

  it("postgres_changes event -> re-fetches offers", async () => {
    fetchActiveOffersMock.mockResolvedValue([]);
    renderHook(() => useExchange());
    await waitFor(() => expect(supabaseChannelHandler).toBeDefined());
    const before = fetchActiveOffersMock.mock.calls.length;
    await act(async () => {
      supabaseChannelHandler!({ eventType: "INSERT", new: {} });
    });
    await waitFor(() => {
      expect(fetchActiveOffersMock.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("unmount removes the channel", async () => {
    const { unmount } = renderHook(() => useExchange());
    await waitFor(() => expect(supabaseMock.channel).toHaveBeenCalled());
    unmount();
    expect(supabaseMock.removeChannel).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────
//  createOffer
// ───────────────────────────────────────────────────────────

describe("useExchange — createOffer guards (§15.x)", () => {
  it("no address -> no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> no write", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("empty amountGive -> 'Enter an amount to give' toast + step back to idle", async () => {
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("", "50", "2030-01-01");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount to give");
    expect(result.current.step).toBe("idle");
  });

  it("empty amountWant -> 'Enter an amount to receive' toast + step back to idle", async () => {
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "", "2030-01-01");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount to receive");
    expect(result.current.step).toBe("idle");
  });

  it("non-numeric amountGive -> 'valid amount to give' toast", async () => {
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("not-a-number", "50", "2030-01-01");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a valid amount to give");
  });

  it("zero amountGive -> 'valid amount to give' toast (parseFloat <= 0)", async () => {
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("0", "50", "2030-01-01");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a valid amount to give");
  });

  it("negative amountWant -> 'valid amount to receive' toast", async () => {
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "-5", "2030-01-01");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a valid amount to receive");
  });
});

describe("useExchange — createOffer happy path (§15.x)", () => {
  it("first-time approval flow: approve + 3s settlement sleep + markVaultApproved + createOffer", async () => {
    vi.useFakeTimers();
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useExchange());
    await vi.advanceTimersByTimeAsync(100);
    let p!: Promise<void>;
    act(() => {
      p = result.current.createOffer("100", "50", "2030-01-01");
    });
    // Approve fires; settlement sleep is 3s
    await vi.advanceTimersByTimeAsync(3_500);
    await act(async () => {
      await p;
    });
    expect(markVaultApprovedMock).toHaveBeenCalledWith(P2P);
    // First call: approve, second call: createOffer
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(2);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe(
      "approvePlaintext",
    );
    expect(unifiedWriteAndWaitMock.mock.calls[1][0].functionName).toBe(
      "createOffer",
    );
  });

  it("pre-approved -> single createOffer call, no approve", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe("createOffer");
  });

  it("createOffer args: (tokenGive=USDC, tokenWant=USDT, giveWei, wantWei, expirySeconds)", async () => {
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01T00:00:00Z");
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("createOffer");
    expect(call.address).toBe(P2P);
    expect(call.args[0]).toBe(VAULT_USDC);
    expect(call.args[1]).toBe(VAULT_USDT);
    expect(call.args[2]).toBe(100_000_000n); // 100 USDC at 6dp
    expect(call.args[3]).toBe(50_000_000n);
    expect(call.args[4]).toBe(BigInt(Math.floor(new Date("2030-01-01T00:00:00Z").getTime() / 1000)));
    expect(call.gas).toBe(5_000_000n);
  });

  it("no FHERC20Vault_USDT in contracts -> falls back to FHERC20Vault_USDC (will revert 'same token' but surfaces the missing-deployment)", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: {
        P2PExchange: P2P,
        FHERC20Vault_USDC: VAULT_USDC,
        // FHERC20Vault_USDT missing
      },
    });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.args[0]).toBe(VAULT_USDC); // tokenGive
    expect(call.args[1]).toBe(VAULT_USDC); // tokenWant fallback
  });

  it("happy path: insertExchangeOffer + insertActivity + broadcastAction TWICE + invalidateBalanceQueries", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(insertExchangeOfferMock).toHaveBeenCalledTimes(1);
    const offerRow = insertExchangeOfferMock.mock.calls[0][0];
    expect(offerRow.offer_id).toBe(7);
    expect(offerRow.maker_address).toBe(ME.toLowerCase());
    expect(offerRow.amount_give).toBe(100);
    expect(offerRow.amount_want).toBe(50);
    expect(offerRow.status).toBe("active");
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe("offer_created");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith("Swap offer created!");
    expect(result.current.step).toBe("success");
  });

  it("extractEventId null -> throws 'offerId could not be read' + no supabase insert", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toContain("offerId could not be read");
    expect(insertExchangeOfferMock).toHaveBeenCalledTimes(0);
  });

  it("reverted receipt -> error toast + no supabase insert", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(result.current.step).toBe("error");
    expect(insertExchangeOfferMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
  });

  it("error-discriminator: 'allowance' -> clearVaultApproval(P2P)", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(P2P);
  });

  it("error-discriminator: 'transfer amount exceeds' -> clearVaultApproval", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(
      new Error("ERC20: transfer amount exceeds balance"),
    );
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(P2P);
  });

  it("error-discriminator: unrelated 'rpc timeout' -> clearVaultApproval NOT called", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rpc timeout"));
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
  });

  it("single-flight: second createOffer while first in-flight short-circuits", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useExchange());
    let p1!: Promise<void>;
    await act(async () => {
      p1 = result.current.createOffer("100", "50", "2030-01-01");
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.createOffer("200", "100", "2030-01-01");
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
//  fillOffer
// ───────────────────────────────────────────────────────────

describe("useExchange — fillOffer (§15.x)", () => {
  function seedOffer() {
    const offer = {
      offer_id: 42,
      maker_address: MAKER,
      amount_give: 100,
      amount_want: 50,
      status: "active",
      token_give: VAULT_USDC,
      token_want: VAULT_USDC,
      tx_hash: "0xseed",
    };
    fetchActiveOffersMock.mockResolvedValue([offer]);
    return offer;
  }

  async function setupWithOffer() {
    seedOffer();
    const { result } = renderHook(() => useExchange());
    await waitFor(() => expect(result.current.offers).toHaveLength(1));
    return result;
  }

  it("no address -> 'Connection lost' toast + no write", async () => {
    seedOffer();
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useExchange());
    await waitFor(() => expect(result.current.offers).toHaveLength(1));
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("offer not found in local list -> throws 'Offer not found' caught + error toast", async () => {
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(999); // not in seeded list
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("Offer not found");
  });

  it("verifyVaultApproved=true -> skips approve, fires fillOffer directly", async () => {
    verifyVaultApprovedMock.mockResolvedValue(true);
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    // Only ONE write (fillOffer) since approve skipped
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe("fillOffer");
  });

  it("verifyVaultApproved=false -> approve THEN fillOffer + markVaultApproved", async () => {
    verifyVaultApprovedMock.mockResolvedValue(false);
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(2);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe(
      "approvePlaintext",
    );
    expect(unifiedWriteAndWaitMock.mock.calls[1][0].functionName).toBe("fillOffer");
    expect(markVaultApprovedMock).toHaveBeenCalledWith(P2P);
  });

  it("fillOffer args: (BigInt(offerId), encTakerPayment, encMakerPayment)", async () => {
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("fillOffer");
    expect(call.args[0]).toBe(42n);
    // takerAmount = parseUnits("50", 6) = 50_000_000n; makerAmount = parseUnits("100", 6) = 100_000_000n
    const encArr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(encArr[0].raw).toBe(50_000_000n); // taker pays amount_want
    expect(encArr[1].raw).toBe(100_000_000n); // maker pays amount_give
  });

  it("DUAL-ROW activity: maker-side row + taker-side row (when taker !== maker)", async () => {
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    const makerRow = insertActivityMock.mock.calls[0][0];
    expect(makerRow.user_from).toBe(ME.toLowerCase()); // taker
    expect(makerRow.user_to).toBe(MAKER.toLowerCase()); // notif goes to maker
    expect(makerRow.activity_type).toBe("offer_filled");
    expect(makerRow.tx_hash).toBe("0xtxhash");
    const takerRow = insertActivityMock.mock.calls[1][0];
    expect(takerRow.user_from).toBe(ME.toLowerCase());
    expect(takerRow.user_to).toBe(ME.toLowerCase()); // self-row for feed
    expect(takerRow.tx_hash).toBe("0xtxhash:taker"); // dedup-key suffix
  });

  it("self-fill (taker === maker) -> only ONE activity row (no dupe)", async () => {
    const offer = {
      offer_id: 42,
      maker_address: ME, // maker is the caller
      amount_give: 100,
      amount_want: 50,
      status: "active",
    };
    fetchActiveOffersMock.mockResolvedValue([offer]);
    const { result } = renderHook(() => useExchange());
    await waitFor(() => expect(result.current.offers).toHaveLength(1));
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("updateOfferStatus('filled', taker) on success", async () => {
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(updateOfferStatusMock).toHaveBeenCalledWith(
      42,
      "filled",
      ME.toLowerCase(),
    );
  });

  it("offer-state error -> specific 'no longer available' toast (cancelled / expired / already filled)", async () => {
    verifyVaultApprovedMock.mockResolvedValue(true);
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("offer not active"));
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "This offer is no longer available — it was cancelled or filled by another user",
    );
  });

  it("'cancelled' error -> same 'no longer available' toast", async () => {
    verifyVaultApprovedMock.mockResolvedValue(true);
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("offer cancelled"));
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "This offer is no longer available — it was cancelled or filled by another user",
    );
  });

  it("'expired' error -> same 'no longer available' toast", async () => {
    verifyVaultApprovedMock.mockResolvedValue(true);
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("offer expired"));
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "This offer is no longer available — it was cancelled or filled by another user",
    );
  });

  it("'already filled' error -> same 'no longer available' toast", async () => {
    verifyVaultApprovedMock.mockResolvedValue(true);
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("already filled by"));
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "This offer is no longer available — it was cancelled or filled by another user",
    );
  });

  it("unrelated error -> 'Transaction failed: <truncated>' fallback (100-char cap)", async () => {
    verifyVaultApprovedMock.mockResolvedValue(true);
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("x".repeat(500)));
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    const errArg = toastErrorMock.mock.calls[0][0] as string;
    expect(errArg.startsWith("Transaction failed: ")).toBe(true);
    expect(errArg.length).toBeLessThanOrEqual(120); // "Transaction failed: " + 100
  });

  it("error-discriminator: allowance error -> clearVaultApproval", async () => {
    verifyVaultApprovedMock.mockResolvedValue(true);
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("insufficient allowance"));
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(P2P);
  });

  it("reverted fill receipt -> 'Transaction reverted on-chain' error + no supabase insert", async () => {
    verifyVaultApprovedMock.mockResolvedValue(true);
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n },
    });
    const result = await setupWithOffer();
    await act(async () => {
      await result.current.fillOffer(42);
    });
    expect(result.current.step).toBe("error");
    expect(updateOfferStatusMock).toHaveBeenCalledTimes(0);
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  cancelOffer
// ───────────────────────────────────────────────────────────

describe("useExchange — cancelOffer (§15.x)", () => {
  it("calls cancelOffer with BigInt(offerId) + gas 5M", async () => {
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.cancelOffer(42);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(P2P);
    expect(call.functionName).toBe("cancelOffer");
    expect(call.args).toEqual([42n]);
    expect(call.gas).toBe(5_000_000n);
  });

  it("updates status to 'cancelled' + inserts activity + broadcasts + toast", async () => {
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.cancelOffer(42);
    });
    expect(updateOfferStatusMock).toHaveBeenCalledWith(42, "cancelled");
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe("offer_cancelled");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(toastSuccessMock).toHaveBeenCalledWith("Offer cancelled");
  });

  it("reverted cancel receipt -> error toast + no supabase", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted" },
    });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.cancelOffer(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Transaction failed"),
    );
    expect(updateOfferStatusMock).toHaveBeenCalledTimes(0);
  });

  it("'cancelled / expired / already filled' error -> specific 'no longer available' toast", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("already filled"));
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.cancelOffer(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "This offer is no longer available — it was cancelled or filled by another user",
    );
  });

  it("single-flight: second cancel while first in-flight short-circuits", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useExchange());
    let p1!: Promise<void>;
    await act(async () => {
      p1 = result.current.cancelOffer(42);
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.cancelOffer(43);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    resolveFirst({
      hash: "0x",
      receipt: { status: "success" },
    });
    await act(async () => {
      await p1;
    });
  });

  it("no address -> no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.cancelOffer(42);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  verifyTrade
// ───────────────────────────────────────────────────────────

describe("useExchange — verifyTrade (§15.x)", () => {
  it("no address -> 'Connection lost' toast + returns null", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useExchange());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.verifyTrade(42);
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost");
  });

  it("getValidationHandle === 0n -> 'No validation handle' error", async () => {
    readContractMock.mockResolvedValue(0n);
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.verifyTrade(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("No validation handle"),
      expect.any(Object),
    );
  });

  it("plaintext=true -> 'Verified — amounts matched' toast + EXCHANGE_VERIFIED activity", async () => {
    readContractMock.mockResolvedValue(999n);
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useExchange());
    let r: boolean | null = null;
    await act(async () => {
      r = await result.current.verifyTrade(42);
    });
    expect(r).toBe(true);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Trade verified — amounts matched",
      expect.any(Object),
    );
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("exchange_verified");
    expect(row.note).toContain("Verified trade #42");
  });

  it("plaintext=false -> 'Flagged — amounts mismatched' toast + EXCHANGE_INVALID activity", async () => {
    readContractMock.mockResolvedValue(999n);
    decryptForTxMock.mockResolvedValue({
      decryptedValue: false,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useExchange());
    let r: boolean | null = null;
    await act(async () => {
      r = await result.current.verifyTrade(42);
    });
    expect(r).toBe(false);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Trade flagged — amounts mismatched",
      expect.any(Object),
    );
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("exchange_invalid");
    expect(row.note).toContain("Flagged trade #42");
  });

  it("publishTradeValidation called with (BigInt(offerId), validPlaintext, signature)", async () => {
    readContractMock.mockResolvedValue(999n);
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.verifyTrade(42);
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.functionName).toBe("publishTradeValidation");
    expect(call.args).toEqual([42n, true, SIGNATURE]);
  });

  it("decryptedValue bigint 1n -> validPlaintext=true", async () => {
    readContractMock.mockResolvedValue(999n);
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 1n,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.verifyTrade(42);
    });
    expect(unifiedWriteMock.mock.calls[0][0].args[1]).toBe(true);
  });

  it("decryptedValue bigint 0n -> validPlaintext=false", async () => {
    readContractMock.mockResolvedValue(999n);
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 0n,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.verifyTrade(42);
    });
    expect(unifiedWriteMock.mock.calls[0][0].args[1]).toBe(false);
  });

  it("decrypt timeout (60s budget) -> 'Decryption timed out' error", async () => {
    vi.useFakeTimers();
    readContractMock.mockResolvedValue(999n);
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useExchange());
    await vi.advanceTimersByTimeAsync(100);
    let r: boolean | null = "init" as unknown as boolean;
    let p!: Promise<boolean | null>;
    act(() => {
      p = result.current.verifyTrade(42);
    });
    await vi.advanceTimersByTimeAsync(70_000);
    await act(async () => {
      r = await p;
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      // mapError catches /timeout|timed out/i and returns the
      // humanized "Timeout — ..." copy. Assert the title is right.
      expect.stringContaining("Timeout"),
      expect.any(Object),
    );
  });

  it("single-flight: verifyingOfferId blocks concurrent verifies", async () => {
    let resolveDecrypt: (v: unknown) => void = () => {};
    readContractMock.mockResolvedValue(999n);
    decryptForTxMock.mockReturnValue(
      new Promise((res) => {
        resolveDecrypt = res;
      }),
    );
    const { result } = renderHook(() => useExchange());
    let p1!: Promise<boolean | null>;
    act(() => {
      p1 = result.current.verifyTrade(42);
    });
    await waitFor(() => expect(result.current.verifyingOfferId).toBe(42));
    // Second verify on a different offer ID short-circuits
    let r2: unknown = "x";
    await act(async () => {
      r2 = await result.current.verifyTrade(99);
    });
    expect(r2).toBeNull();
    expect(readContractMock).toHaveBeenCalledTimes(1); // only the first read
    // Clean up
    resolveDecrypt({ decryptedValue: true, signature: SIGNATURE });
    await act(async () => {
      await p1;
    });
  });

  it("publishTradeValidation reverted -> 'Publish reverted' error + no activity", async () => {
    readContractMock.mockResolvedValue(999n);
    waitForTransactionReceiptMock.mockResolvedValue({ status: "reverted" });
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.verifyTrade(42);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Publish reverted"),
      expect.any(Object),
    );
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("verifyingOfferId resets to null in finally (even on failure)", async () => {
    readContractMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.verifyTrade(42);
    });
    expect(result.current.verifyingOfferId).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  getTradeValidation
// ───────────────────────────────────────────────────────────

describe("useExchange — getTradeValidation (§15.x)", () => {
  it("returns { isValid, isReady } from getTradeValidation tuple", async () => {
    readContractMock.mockResolvedValue([true, true]);
    const { result } = renderHook(() => useExchange());
    let r: { isValid: boolean; isReady: boolean } | null = null;
    await act(async () => {
      r = await result.current.getTradeValidation(42);
    });
    expect(r).toEqual({ isValid: true, isReady: true });
    expect(readContractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: P2P,
        functionName: "getTradeValidation",
        args: [42n],
      }),
    );
  });

  it("isReady=false -> not-yet-resolved verdict still returned", async () => {
    readContractMock.mockResolvedValue([false, false]);
    const { result } = renderHook(() => useExchange());
    let r: { isValid: boolean; isReady: boolean } | null = null;
    await act(async () => {
      r = await result.current.getTradeValidation(42);
    });
    expect(r).toEqual({ isValid: false, isReady: false });
  });

  it("no publicClient -> returns null", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useExchange());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.getTradeValidation(42);
    });
    expect(r).toBeNull();
  });

  it("readContract throw -> returns null (defensive, no crash)", async () => {
    readContractMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useExchange());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.getTradeValidation(42);
    });
    expect(r).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useExchange — reset (§15.x)", () => {
  it("reset clears step + error back to idle/null", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("fail"));
    const { result } = renderHook(() => useExchange());
    await act(async () => {
      await result.current.createOffer("100", "50", "2030-01-01");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("fail");
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});
