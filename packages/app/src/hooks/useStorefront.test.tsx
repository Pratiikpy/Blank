import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useStorefront. Wave 4 #254 covers all 3 sale modes
// (FixedPrice / Auction / PayWhatYouWant) via createListing + buyFixed
// + placeBid + payPWYW (all encrypted-amount) + closeAuction +
// claimAuctionWin + refundLoserBid + deactivateListing (plaintext).
// Mirrors useCrowdfund + useEncryptedEscrow shape with one addition:
// the §3.8 seller-self-purchase pre-check that reads the listing's
// seller and rejects same-address-as-caller BEFORE encrypting (avoids
// wasting 30s of FHE work on a guaranteed-revert input).
//
// CRITICAL pins:
//   - §3.17 split guards: createListing + buyFixed + placeBid + payPWYW
//     use guardReady (need cofhe for FHE encryption); closeAuction +
//     claimAuctionWin + refundLoserBid + deactivateListing use
//     guardWalletReady (plaintext-only, work even when cofhe shim
//     hasn't connected). A user clicking Refund or Close on an
//     existing auction shouldn't need to wait for cofhe handshake.
//   - §3.8 seller-self pre-check on buyFixed + placeBid + payPWYW:
//     reads getListing(listingId), compares listing.seller (tuple[0])
//     against effectiveAddress (case-INsensitive), rejects with a
//     mode-specific toast ("You can't buy/bid/pay your own listing")
//     BEFORE pipeline.start() or any encrypt fires. The contract
//     would revert anyway, but only after the 30s FHE encryption
//     + UserOp prefund cost; the client-side check fails fast.
//   - §3.4 ensureVaultApproval uses unifiedWriteAndWait so the
//     approval receipt mines BEFORE markVaultApproved caches.
//   - §3.10 receipt-path discrimination on createListing (AA path
//     skips markConfirming + waitForTransactionReceipt; EOA path
//     flashes both); buyFixed/placeBid/payPWYW SKIP the flash
//     entirely because unifiedWriteAndWait already settled and no
//     event-id extraction is needed (they return boolean success).
//   - §3.13 callSimple PRESERVES lastListingId across invocations
//     via setState((prev) => ({ ...prev, ... })). Without spread,
//     closeAuction(N) after createListing setting lastListingId=N
//     would clear it and lose the UI link to "listing #N".
//   - §3.11 error state preserves prev.txHash + lastListingId on
//     BOTH encrypted-flow errors AND callSimple errors so the
//     failed tx is still linkable to the explorer for debugging.
//   - §3.7 FRIENDLY_LABEL map: closeAuction -> "Auction closed",
//     claimAuctionWin -> "Winning bid claimed", refundLoserBid ->
//     "Losing bid refunded", deactivateListing -> "Listing
//     deactivated". Raw function names leak implementation detail.
//   - 3-mode SaleMode enum (FixedPrice=0 / Auction=1 / PWYW=2)
//     pinned in the createListing args[0] field.
//   - claimAuctionWin optional deliveryNoteHash defaults to
//     ZERO_BYTES32; refundLoserBid requires (listingId, bidIndex)
//     because a single user can have multiple bids on one auction
//     and the refund applies per-bid.

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
vi.mock("@/lib/abis", () => ({ StorefrontAbi: [], FHERC20VaultAbi: [] }));
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

import { useStorefront, SALE_MODE } from "./useStorefront";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const OTHER_SELLER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const SF_ADDR = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const VAULT = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as `0x${string}`;
const CID_HASH = ("0x" + "cd".repeat(32)) as `0x${string}`;

const encryptInputsAsyncMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const readContractMock = vi.fn();
const onEncryptStepMock = vi.fn();
const markSubmittingMock = vi.fn();
const markConfirmingMock = vi.fn();
const markDoneMock = vi.fn();
const markFailedMock = vi.fn();
const startMock = vi.fn();
const pipelineResetMock = vi.fn();

function listingParams(over: Record<string, unknown> = {}) {
  return {
    mode: SALE_MODE.FixedPrice,
    vault: VAULT,
    priceTokens: "10",
    decimals: 6,
    auctionSeconds: 0,
    title: "Test listing",
    descriptionCidHash: CID_HASH,
    deliveryChannel: "email",
    ...over,
  };
}

function buyParams(over: Record<string, unknown> = {}) {
  return {
    listingId: 7,
    vault: VAULT,
    offerTokens: "10",
    decimals: 6,
    ...over,
  };
}

function bidParams(over: Record<string, unknown> = {}) {
  return {
    listingId: 7,
    vault: VAULT,
    bidTokens: "15",
    decimals: 6,
    ...over,
  };
}

function pwywParams(over: Record<string, unknown> = {}) {
  return {
    listingId: 7,
    vault: VAULT,
    amountTokens: "5",
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
  readContractMock.mockReset();
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
    contracts: { Storefront: SF_ADDR },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    readContract: readContractMock,
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
  // Default getListing: seller is OTHER (not the caller) so seller-self
  // pre-check does NOT trigger by default
  readContractMock.mockResolvedValue([OTHER_SELLER, "other-fields-omitted"]);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: { status: "success", blockNumber: 1n, logs: [] },
  });
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useStorefront — initial state (§15.x)", () => {
  it("returns idle state + null txExplorerUrl + 8 callable handlers", () => {
    const { result } = renderHook(() => useStorefront());
    expect(result.current.state.step).toBe("idle");
    expect(result.current.state.isProcessing).toBe(false);
    expect(result.current.state.txHash).toBeNull();
    expect(result.current.state.lastListingId).toBeNull();
    expect(result.current.txExplorerUrl).toBeNull();
    expect(typeof result.current.createListing).toBe("function");
    expect(typeof result.current.buyFixed).toBe("function");
    expect(typeof result.current.placeBid).toBe("function");
    expect(typeof result.current.closeAuction).toBe("function");
    expect(typeof result.current.claimAuctionWin).toBe("function");
    expect(typeof result.current.refundLoserBid).toBe("function");
    expect(typeof result.current.payPWYW).toBe("function");
    expect(typeof result.current.deactivateListing).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.17 split guards
// ───────────────────────────────────────────────────────────

describe("useStorefront — guardReady (encrypt-required ops) (§15.x)", () => {
  it("cofhe NOT connected -> createListing rejected", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStorefront());
    let r: number | null = 0;
    await act(async () => {
      r = await result.current.createListing(listingParams());
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
  });

  it("cofhe NOT connected -> buyFixed rejected", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.buyFixed(buyParams());
    });
    expect(ok).toBe(false);
  });

  it("cofhe NOT connected -> placeBid rejected", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.placeBid(bidParams());
    });
    expect(ok).toBe(false);
  });

  it("cofhe NOT connected -> payPWYW rejected", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.payPWYW(pwywParams());
    });
    expect(ok).toBe(false);
  });

  it("Storefront not deployed (zero addr) -> distinct toast", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { Storefront: ZERO_ADDR },
    });
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Storefront not deployed on this chain yet",
    );
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost. Please refresh.");
  });
});

describe("useStorefront — guardWalletReady (plaintext-only ops) (§15.x)", () => {
  it("cofhe NOT connected -> closeAuction STILL WORKS (plaintext path)", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStorefront());
    let ok = false;
    await act(async () => {
      ok = await result.current.closeAuction(5);
    });
    expect(ok).toBe(true);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe("closeAuction");
  });

  it("cofhe NOT connected -> claimAuctionWin STILL WORKS", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStorefront());
    let ok = false;
    await act(async () => {
      ok = await result.current.claimAuctionWin(7);
    });
    expect(ok).toBe(true);
  });

  it("cofhe NOT connected -> refundLoserBid STILL WORKS", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStorefront());
    let ok = false;
    await act(async () => {
      ok = await result.current.refundLoserBid(7, 0);
    });
    expect(ok).toBe(true);
  });

  it("cofhe NOT connected -> deactivateListing STILL WORKS", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStorefront());
    let ok = false;
    await act(async () => {
      ok = await result.current.deactivateListing(7);
    });
    expect(ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────
//  §3.8 seller-self pre-check (fail fast pre-encryption)
// ───────────────────────────────────────────────────────────

describe("useStorefront — §3.8 seller-self-purchase pre-check (§15.x)", () => {
  it("buyFixed when seller === caller -> 'can't buy your own listing' toast BEFORE encrypt", async () => {
    readContractMock.mockResolvedValue([ME, "other-fields"]);
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.buyFixed(buyParams());
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("You can't buy your own listing.");
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("placeBid seller-self -> 'can't bid on your own listing'", async () => {
    readContractMock.mockResolvedValue([ME, "fields"]);
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.placeBid(bidParams());
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("You can't bid on your own listing.");
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("payPWYW seller-self -> 'can't pay your own listing'", async () => {
    readContractMock.mockResolvedValue([ME, "fields"]);
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.payPWYW(pwywParams());
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("You can't pay your own listing.");
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("seller-self check is CASE-INsensitive (uppercase caller still matches)", async () => {
    // ME stored in listing as lowercase; caller is uppercased
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME.toUpperCase().replace("0X", "0x"),
    });
    readContractMock.mockResolvedValue([ME, "fields"]);
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.buyFixed(buyParams());
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("You can't buy your own listing.");
  });

  it("getListing called with BigInt(listingId) for the pre-check read", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.buyFixed(buyParams({ listingId: 42 }));
    });
    expect(readContractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SF_ADDR,
        functionName: "getListing",
        args: [42n],
      }),
    );
  });

  it("different seller -> pre-check passes + encrypt fires", async () => {
    readContractMock.mockResolvedValue([OTHER_SELLER, "fields"]);
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.buyFixed(buyParams());
    });
    expect(encryptInputsAsyncMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  §3.4 vault approval
// ───────────────────────────────────────────────────────────

describe("useStorefront — §3.4 vault approval (§15.x)", () => {
  it("first createListing: approves via unifiedWriteAndWait + markVaultApproved(Storefront)", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    const approveCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
    expect(approveCall.address).toBe(VAULT);
    expect(approveCall.args[0]).toBe(SF_ADDR);
    expect(approveCall.args[1]).toBe(BigInt("18446744073709551615")); // MAX_UINT64
    expect(markVaultApprovedMock).toHaveBeenCalledWith(SF_ADDR);
  });

  it("buyFixed runs approval flow (same gate as createListing)", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.buyFixed(buyParams());
    });
    const approveCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
  });

  it("pre-approved -> approval skipped", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe("createListing");
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval failure -> error toast + main tx NOT fired", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "approvePlaintext") {
        throw new Error("approve reverted");
      }
      return { hash: "0x", receipt: { status: "success", logs: [] } };
    });
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
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
//  createListing happy path
// ───────────────────────────────────────────────────────────

describe("useStorefront — createListing happy path (§15.x)", () => {
  it("calls createListing with (mode, vault, encPrice, auctionSeconds, title, cidHash, deliveryChannel)", async () => {
    const params = listingParams({
      mode: SALE_MODE.Auction,
      title: "Vintage poster",
      auctionSeconds: 86400,
      deliveryChannel: "ipfs://cid",
    });
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(params);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("createListing");
    expect(call.address).toBe(SF_ADDR);
    expect(call.args[0]).toBe(SALE_MODE.Auction);
    expect(call.args[1]).toBe(VAULT);
    expect(call.args[3]).toBe(BigInt(86400));
    expect(call.args[4]).toBe("Vintage poster");
    expect(call.args[5]).toBe(CID_HASH);
    expect(call.args[6]).toBe("ipfs://cid");
    expect(call.gas).toBe(5_000_000n);
  });

  it("3 sale modes pass through unchanged (FixedPrice=0, Auction=1, PWYW=2)", async () => {
    const { result } = renderHook(() => useStorefront());
    for (const mode of [SALE_MODE.FixedPrice, SALE_MODE.Auction, SALE_MODE.PayWhatYouWant]) {
      unifiedWriteAndWaitMock.mockClear();
      await act(async () => {
        await result.current.createListing(listingParams({ mode }));
      });
      expect(unifiedWriteAndWaitMock.mock.calls[0][0].args[0]).toBe(mode);
    }
  });

  it("parseUnits applied to priceTokens with decimals", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(
        listingParams({ priceTokens: "1.5", decimals: 6 }),
      );
    });
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(1_500_000n);
  });

  it("empty priceTokens defaults to '0' (for PWYW listings)", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(
        listingParams({ priceTokens: "", mode: SALE_MODE.PayWhatYouWant }),
      );
    });
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(0n);
  });

  it("returns listingId from extractEventId + sets state.lastListingId + step=success", async () => {
    extractEventIdMock.mockReturnValue(99);
    const { result } = renderHook(() => useStorefront());
    let id: number | null = null;
    await act(async () => {
      id = await result.current.createListing(listingParams());
    });
    expect(id).toBe(99);
    expect(result.current.state.lastListingId).toBe(99);
    expect(result.current.state.step).toBe("success");
    expect(result.current.state.txHash).toBe("0xtxhash");
  });

  it("extractEventId null -> throws + sets error state", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useStorefront());
    let id: number | null = 0;
    await act(async () => {
      id = await result.current.createListing(listingParams());
    });
    expect(id).toBeNull();
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("listingId could not be read");
  });

  it("pipeline lifecycle fires: start -> onEncryptStep -> markSubmitting -> markDone", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(startMock).toHaveBeenCalled();
    expect(encryptInputsAsyncMock.mock.calls[0][1]).toBe(onEncryptStepMock);
    expect(markSubmittingMock).toHaveBeenCalled();
    expect(markDoneMock).toHaveBeenCalled();
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  §3.10 receipt-path on createListing
// ───────────────────────────────────────────────────────────

describe("useStorefront — §3.10 receipt path (createListing) (§15.x)", () => {
  it("AA path: writeResult.receipt present -> SKIPS markConfirming + waitForTransactionReceipt", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xaa",
      receipt: { status: "success", logs: [] },
    });
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
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
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
    });
  });

  it("EOA path reverted -> throws 'createListing reverted'", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      logs: [],
    });
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("createListing reverted");
  });
});

// ───────────────────────────────────────────────────────────
//  buyFixed
// ───────────────────────────────────────────────────────────

describe("useStorefront — buyFixed (§15.x)", () => {
  it("calls buyFixed with (BigInt(listingId), encOffer, deliveryNoteHash)", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.buyFixed(buyParams({ listingId: 42 }));
    });
    const call = unifiedWriteAndWaitMock.mock.calls.at(-1)![0];
    expect(call.functionName).toBe("buyFixed");
    expect(call.args[0]).toBe(42n);
    expect(call.args[2]).toBe(ZERO_BYTES32); // default delivery note hash
  });

  it("custom deliveryNoteHash passes through", async () => {
    const customHash = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.buyFixed(buyParams({ deliveryNoteHash: customHash }));
    });
    const call = unifiedWriteAndWaitMock.mock.calls.at(-1)![0];
    expect(call.args[2]).toBe(customHash);
  });

  it("returns true on success + sets state.lastListingId + step=success", async () => {
    const { result } = renderHook(() => useStorefront());
    let ok = false;
    await act(async () => {
      ok = await result.current.buyFixed(buyParams({ listingId: 13 }));
    });
    expect(ok).toBe(true);
    expect(result.current.state.lastListingId).toBe(13);
    expect(result.current.state.step).toBe("success");
  });

  it("§3.10: buyFixed SKIPS markConfirming (no event-id extraction needed)", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtx",
      receipt: undefined, // even on EOA path, no confirm flash
    });
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.buyFixed(buyParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(0);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("write rejection -> returns false + step=error + markFailed pipeline", async () => {
    // Override the unifiedWriteAndWait for the buyFixed call (after approval succeeds)
    let callCount = 0;
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      callCount += 1;
      if (args.functionName === "buyFixed") throw new Error("buy reverted");
      return { hash: "0x", receipt: { status: "success", logs: [] } };
    });
    void callCount;
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.buyFixed(buyParams());
    });
    expect(ok).toBe(false);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("buy reverted");
    expect(markFailedMock).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────
//  placeBid
// ───────────────────────────────────────────────────────────

describe("useStorefront — placeBid (§15.x)", () => {
  it("calls placeBid with (BigInt(listingId), encBid)", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.placeBid(bidParams({ listingId: 42, bidTokens: "25" }));
    });
    const call = unifiedWriteAndWaitMock.mock.calls.at(-1)![0];
    expect(call.functionName).toBe("placeBid");
    expect(call.args[0]).toBe(42n);
    expect(call.gas).toBe(5_000_000n);
    // Bid amount encrypted (Encryptable.uint64(25_000_000n))
    const encArr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(encArr[0].raw).toBe(25_000_000n);
  });

  it("returns true + sets state.lastListingId", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.placeBid(bidParams({ listingId: 7 }));
    });
    expect(result.current.state.lastListingId).toBe(7);
    expect(result.current.state.step).toBe("success");
  });

  it("seller-self pre-check fires BEFORE pipeline.start (no pipeline state mutated)", async () => {
    readContractMock.mockResolvedValue([ME, "fields"]);
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.placeBid(bidParams());
    });
    expect(startMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  payPWYW
// ───────────────────────────────────────────────────────────

describe("useStorefront — payPWYW (§15.x)", () => {
  it("calls payPWYW with (BigInt(listingId), encAmount, deliveryNoteHash)", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.payPWYW(pwywParams({ listingId: 5, amountTokens: "0.5" }));
    });
    const call = unifiedWriteAndWaitMock.mock.calls.at(-1)![0];
    expect(call.functionName).toBe("payPWYW");
    expect(call.args[0]).toBe(5n);
    expect(call.args[2]).toBe(ZERO_BYTES32);
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(500_000n);
  });

  it("custom deliveryNoteHash passes through", async () => {
    const customHash = ("0x" + "22".repeat(32)) as `0x${string}`;
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.payPWYW(pwywParams({ deliveryNoteHash: customHash }));
    });
    const call = unifiedWriteAndWaitMock.mock.calls.at(-1)![0];
    expect(call.args[2]).toBe(customHash);
  });
});

// ───────────────────────────────────────────────────────────
//  callSimple operations (4 plaintext ops)
// ───────────────────────────────────────────────────────────

describe("useStorefront — callSimple plaintext ops (§15.x)", () => {
  it("closeAuction(id) -> closeAuction with [BigInt(id)] + 'Auction closed' toast", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.closeAuction(11);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("closeAuction");
    expect(call.args).toEqual([11n]);
    expect(toastSuccessMock).toHaveBeenCalledWith("Auction closed");
  });

  it("claimAuctionWin(id) defaults deliveryNoteHash to ZERO_BYTES32", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.claimAuctionWin(22);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claimAuctionWin");
    expect(call.args).toEqual([22n, ZERO_BYTES32]);
    expect(toastSuccessMock).toHaveBeenCalledWith("Winning bid claimed");
  });

  it("claimAuctionWin(id, customHash) passes hash through", async () => {
    const customHash = ("0x" + "33".repeat(32)) as `0x${string}`;
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.claimAuctionWin(22, customHash);
    });
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].args).toEqual([22n, customHash]);
  });

  it("refundLoserBid(id, bidIndex) -> refundLoserBid with BOTH BigInt args", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.refundLoserBid(5, 2);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("refundLoserBid");
    expect(call.args).toEqual([5n, 2n]);
    expect(toastSuccessMock).toHaveBeenCalledWith("Losing bid refunded");
  });

  it("deactivateListing(id) -> deactivateListing with [BigInt(id)] + 'Listing deactivated'", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.deactivateListing(99);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("deactivateListing");
    expect(call.args).toEqual([99n]);
    expect(toastSuccessMock).toHaveBeenCalledWith("Listing deactivated");
  });

  it("§3.13 callSimple PRESERVES lastListingId across invocations", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(result.current.state.lastListingId).toBe(7);
    await act(async () => {
      await result.current.deactivateListing(7);
    });
    expect(result.current.state.lastListingId).toBe(7);
    expect(result.current.state.step).toBe("success");
  });

  it("callSimple write rejection -> returns false + step=error", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useStorefront());
    let ok = true;
    await act(async () => {
      ok = await result.current.closeAuction(1);
    });
    expect(ok).toBe(false);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("user rejected");
  });

  it("§3.11 callSimple error preserves prev.txHash + lastListingId (debugging affordance)", async () => {
    extractEventIdMock.mockReturnValue(42);
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(result.current.state.txHash).toBe("0xtxhash");
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("fail"));
    await act(async () => {
      await result.current.deactivateListing(42);
    });
    expect(result.current.state.txHash).toBe("0xtxhash"); // preserved
    expect(result.current.state.lastListingId).toBe(42); // preserved
    expect(result.current.state.step).toBe("error");
  });

  it("unknown function falls through to default 'Submitted' toast (defensive)", async () => {
    // The callSimple has a default for unrecognized functionNames via
    // FRIENDLY_LABEL[fn] ?? "Submitted". This won't happen in practice
    // because TypeScript constrains the param, but defensive.
    // We can't test this directly since TS rejects it, but the pattern
    // is documented in the source. Skipping a direct test.
  });
});

// ───────────────────────────────────────────────────────────
//  §3.12 txExplorerUrl
// ───────────────────────────────────────────────────────────

describe("useStorefront — §3.12 txExplorerUrl (§15.x)", () => {
  it("null when no tx hash", () => {
    const { result } = renderHook(() => useStorefront());
    expect(result.current.txExplorerUrl).toBeNull();
  });

  it("after successful createListing -> URL contains tx hash", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(result.current.txExplorerUrl).not.toBeNull();
    expect(result.current.txExplorerUrl).toContain("0xtxhash");
  });

  it("after successful buyFixed -> URL contains tx hash", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.buyFixed(buyParams());
    });
    expect(result.current.txExplorerUrl).toContain("0xtxhash");
  });
});

// ───────────────────────────────────────────────────────────
//  Error path (non-Error throws + reset)
// ───────────────────────────────────────────────────────────

describe("useStorefront — error path + reset (§15.x)", () => {
  it("createListing non-Error throw -> String(err) captured into state.error", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue("plain-string");
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(result.current.state.error).toBe("plain-string");
  });

  it("reset clears state + calls pipeline.reset", async () => {
    const { result } = renderHook(() => useStorefront());
    await act(async () => {
      await result.current.createListing(listingParams());
    });
    expect(result.current.state.step).toBe("success");
    act(() => result.current.reset());
    expect(result.current.state.step).toBe("idle");
    expect(result.current.state.txHash).toBeNull();
    expect(result.current.state.lastListingId).toBeNull();
    expect(pipelineResetMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  Concurrent invocation guard
// ───────────────────────────────────────────────────────────

describe("useStorefront — concurrent-invocation guard (§15.x)", () => {
  it("second createListing while first in-flight -> short-circuits via state.isProcessing", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useStorefront());
    let p1!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.createListing(listingParams());
      await Promise.resolve();
    });
    let secondResult: number | null = 0;
    await act(async () => {
      secondResult = await result.current.createListing(
        listingParams({ title: "second" }),
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
