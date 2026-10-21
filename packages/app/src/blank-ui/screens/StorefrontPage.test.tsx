import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for StorefrontPage. Third public Wave 4 deep-link
// landing (after ClaimLinkPage + CrowdfundPage) for /shop/:chainId/
// :listingId. The page renders a DIFFERENT buyer UI per
// SaleMode discriminant: FixedPrice / Auction / PayWhatYouWant.
//
// CRITICAL pins:
//   - 3-mode discriminated UI (FixedPrice -> "Buy now" exact-
//     price hint; PayWhatYouWant -> "Send" tip-jar hint; Auction
//     -> AuctionView with its own 3-substate machine)
//   - Auction 3-substate machine: open / needsClose / closed
//     derived from on-chain closed flag + closesAt deadline
//   - CRITICAL: !active gate is BYPASSED for auctions. An auction
//     that closed legitimately MUST still render the claim+refund
//     subview even though active=false; without this special-case
//     the winner can never collect.
//   - 4-branch load error pattern matching ClaimLinkPage + Crowdfund
//   - getBidCount only fetched when mode === Auction (the other
//     two modes don't have a bid concept)
//   - Refund-bid prompt 8-branch validation matrix (mirrors
//     Crowdfund's refund prompt, same String(idx)!==trimmed guard)
//   - cancellation guard via spyOn(console, "error")

const useParamsMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useStorefrontMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useParams: useParamsMock }));
vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useStorefront", () => ({
  useStorefront: useStorefrontMock,
  SALE_MODE: { FixedPrice: 0, Auction: 1, PayWhatYouWant: 2 },
}));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/constants", () => ({
  CONTRACTS_BY_CHAIN: {
    11155111: { Storefront: "0x1111111111111111111111111111111111111111" },
    84532: { Storefront: "0x2222222222222222222222222222222222222222" },
    9999: { Storefront: "0x0000000000000000000000000000000000000000" },
  },
}));
vi.mock("@/lib/abis", () => ({ StorefrontAbi: [] }));
vi.mock("@/components/payment/FhePipelineProgress", () => ({
  FhePipelineProgress: (props: { state: { phase: string } }) => (
    <div data-testid="fhe-pipeline-progress" data-phase={props.state.phase} />
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: vi.fn() },
}));

import StorefrontPage from "./StorefrontPage";

const SELLER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WINNER = "0xcccccccccccccccccccccccccccccccccccccccc";
const ZERO = "0x0000000000000000000000000000000000000000";

const MODE_FIXED = 0;
const MODE_AUCTION = 1;
const MODE_PWYW = 2;

let readContractMock: ReturnType<typeof vi.fn>;
let buyFixedMock: ReturnType<typeof vi.fn>;
let placeBidMock: ReturnType<typeof vi.fn>;
let payPWYWMock: ReturnType<typeof vi.fn>;
let closeAuctionMock: ReturnType<typeof vi.fn>;
let claimAuctionWinMock: ReturnType<typeof vi.fn>;
let refundLoserBidMock: ReturnType<typeof vi.fn>;
let revealWinnerMock: ReturnType<typeof vi.fn>;
let decryptPaidByBuyerMock: ReturnType<typeof vi.fn>;
let finishPendingPurchasesMock: ReturnType<typeof vi.fn>;

function buildListing(over: Partial<{
  seller: string;
  vault: string;
  mode: number;
  closesAt: bigint;
  winner: string;
  active: boolean;
  closed: boolean;
  title: string;
  descriptionCidHash: string;
  deliveryChannel: string;
  createdAt: bigint;
}> = {}): readonly unknown[] {
  const o = {
    seller: SELLER,
    vault: VAULT,
    mode: MODE_FIXED,
    closesAt: BigInt(Math.floor(Date.now() / 1000) + 86400 * 5),
    winner: ZERO,
    active: true,
    closed: false,
    title: "Limited print, 100 copies",
    descriptionCidHash: "0x" + "11".repeat(32),
    deliveryChannel: "ship to your stealth address",
    createdAt: 1000n,
    ...over,
  };
  return [
    o.seller, o.vault, o.mode, o.closesAt, o.winner, o.active, o.closed,
    o.title, o.descriptionCidHash, o.deliveryChannel, o.createdAt,
  ];
}

function makeReadContract(
  listing: readonly unknown[],
  bidCount = 0,
  // Per-index bid (bidder, refunded) for the "Your bids" list loader.
  // Defaults to all-zero-addr / not-refunded; tests that want a viewer's
  // bid to appear in the list override here.
  bids: ReadonlyArray<readonly [`0x${string}`, boolean]> = [],
  // Storefront.auctionHasNoWinner. undefined = a pre-gate Storefront without the view.
  noWinner?: boolean,
) {
  return vi.fn().mockImplementation(async (args: { functionName: string; args?: readonly unknown[] }) => {
    if (args.functionName === "getListing") return listing;
    if (args.functionName === "getBidCount") return BigInt(bidCount);
    if (args.functionName === "auctionHasNoWinner") {
      if (noWinner === undefined) throw new Error("execution reverted");
      return noWinner;
    }
    if (args.functionName === "getBid") {
      const i = Number((args.args ?? [])[1] ?? 0);
      return bids[i] ?? (["0x0000000000000000000000000000000000000000", false] as const);
    }
    return null;
  });
}

function setHook(overrides: Partial<{
  step: "idle" | "encrypting" | "sending" | "success" | "error";
  isProcessing: boolean;
  error: string | null;
  pipelinePhase: string;
  pendingPurchases: Array<{ purchaseId: string; listingId: number; hash: string }>;
  fheReady: boolean;
}> = {}) {
  useStorefrontMock.mockReturnValue({
    state: {
      step: overrides.step ?? "idle",
      isProcessing: overrides.isProcessing ?? false,
      error: overrides.error ?? null,
    },
    pipeline: { phase: overrides.pipelinePhase ?? "idle" },
    buyFixed: buyFixedMock,
    placeBid: placeBidMock,
    payPWYW: payPWYWMock,
    closeAuction: closeAuctionMock,
    claimAuctionWin: claimAuctionWinMock,
    revealWinner: revealWinnerMock,
    refundLoserBid: refundLoserBidMock,
    decryptPaidByBuyer: decryptPaidByBuyerMock,
    pendingPurchases: overrides.pendingPurchases ?? [],
    finishPendingPurchases: finishPendingPurchasesMock,
    fheReady: overrides.fheReady ?? true,
  });
}

beforeEach(() => {
  useParamsMock.mockReset();
  usePublicClientMock.mockReset();
  useStorefrontMock.mockReset();
  useEffectiveAddressMock.mockReset();
  toastErrorMock.mockReset();

  useParamsMock.mockReturnValue({ chainId: "11155111", listingId: "5" });
  // Default: no connected wallet. Tests that need a specific viewer
  // (winner / non-winner / no-bids) override per case.
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });

  readContractMock = makeReadContract(buildListing(), 0);
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });

  buyFixedMock = vi.fn().mockResolvedValue(undefined);
  placeBidMock = vi.fn().mockResolvedValue(undefined);
  payPWYWMock = vi.fn().mockResolvedValue(undefined);
  closeAuctionMock = vi.fn().mockResolvedValue(undefined);
  claimAuctionWinMock = vi.fn().mockResolvedValue(undefined);
  refundLoserBidMock = vi.fn().mockResolvedValue(undefined);
  revealWinnerMock = vi.fn().mockResolvedValue(true);
  decryptPaidByBuyerMock = vi.fn().mockResolvedValue(0n);
  finishPendingPurchasesMock = vi.fn().mockResolvedValue({ sold: 0, voided: 0, pending: 0 });
  setHook();
});

afterEach(() => {
  // Do NOT call vi.restoreAllMocks() -- it undoes vi.mock() module
  // replacements per the CrowdfundPage test's documented gotcha.
  vi.useRealTimers();
});

describe("StorefrontPage — load-error branches (§15.x)", () => {
  it("invalid chainId -> 'Invalid URL'", async () => {
    useParamsMock.mockReturnValue({ chainId: "abc", listingId: "5" });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Invalid URL")).toBeDefined();
  });

  it("invalid listingId -> 'Invalid URL'", async () => {
    useParamsMock.mockReturnValue({ chainId: "11155111", listingId: "xyz" });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Invalid URL")).toBeDefined();
  });

  it("unsupported chain -> 'Unsupported chain'", async () => {
    useParamsMock.mockReturnValue({ chainId: "1", listingId: "5" });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Unsupported chain")).toBeDefined();
  });

  it("zero Storefront address -> 'Storefront not deployed on this chain yet'", async () => {
    useParamsMock.mockReturnValue({ chainId: "9999", listingId: "5" });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Storefront not deployed on this chain yet")).toBeDefined();
  });

  it("seller = address(0) -> 'Listing not found'", async () => {
    readContractMock = makeReadContract(buildListing({ seller: ZERO }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Listing not found")).toBeDefined();
  });

  it("F1: readContract throws transient (rate-limit) -> 'Network busy' + Retry CTA, no raw err.message in headline", async () => {
    readContractMock = vi.fn().mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    expect(await findByText("Network busy")).toBeDefined();
    expect(await findByText("Retry")).toBeDefined();
    const headline = container.querySelector("h1");
    expect(headline?.textContent).toBe("Network busy");
    expect(headline?.textContent).not.toContain("429");
  });

  it("F1: readContract throws permanent (revert) -> 'Listing not found' + Go home CTA (no retry)", async () => {
    readContractMock = vi.fn().mockRejectedValue(
      new Error("execution reverted: Storefront: not found"),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, queryByText } = render(<StorefrontPage />);
    expect(await findByText("Listing not found")).toBeDefined();
    expect(await findByText("Go home")).toBeDefined();
    expect(queryByText("Retry")).toBeNull();
  });

  it("F1: unknown error defaults to transient (recoverable)", async () => {
    readContractMock = vi.fn().mockRejectedValue("rejection string");
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Couldn't load")).toBeDefined();
    expect(await findByText("Retry")).toBeDefined();
  });
});

describe("StorefrontPage — loading + inactive-listing states (§15.x)", () => {
  it("pending readContract -> 'Loading listing…'", async () => {
    readContractMock = vi.fn().mockReturnValue(new Promise(() => {}));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { container } = render(<StorefrontPage />);
    await waitFor(() => expect(container.textContent).toContain("Loading listing"));
  });

  it("!active + mode=FixedPrice -> 'Listing closed' card with deactivated copy", async () => {
    readContractMock = makeReadContract(buildListing({ active: false, mode: MODE_FIXED }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Listing closed");
    expect(container.textContent).toContain("seller deactivated this listing");
  });

  it("!active + mode=PayWhatYouWant -> 'Listing closed' card", async () => {
    readContractMock = makeReadContract(buildListing({ active: false, mode: MODE_PWYW }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Listing closed")).toBeDefined();
  });

  it("CRITICAL: !active + mode=Auction BYPASSES 'Listing closed' (auction lifecycle continues after close)", async () => {
    readContractMock = makeReadContract(
      buildListing({ active: false, mode: MODE_AUCTION, closed: true, winner: WINNER }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { container, findByText } = render(<StorefrontPage />);
    await findByText("Limited print, 100 copies");
    expect(container.textContent).not.toContain("seller deactivated this listing");
    // Closed-auction subview still rendered (winner banner visible).
    expect(container.textContent).toContain("Winner:");
  });
});

describe("StorefrontPage — mode meta + header (§15.x)", () => {
  it("FixedPrice renders 'Fixed price' eyebrow label", async () => {
    readContractMock = makeReadContract(buildListing({ mode: MODE_FIXED }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Fixed price")).toBeDefined();
  });

  it("Auction renders 'Sealed-bid auction' label", async () => {
    readContractMock = makeReadContract(buildListing({ mode: MODE_AUCTION }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Sealed-bid auction")).toBeDefined();
  });

  it("PayWhatYouWant renders 'Pay what you want' label", async () => {
    readContractMock = makeReadContract(buildListing({ mode: MODE_PWYW }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Pay what you want")).toBeDefined();
  });

  it("header: title + truncated seller + delivery channel", async () => {
    readContractMock = makeReadContract(buildListing({
      title: "Print",
      seller: SELLER,
      deliveryChannel: "ship to stealth",
    }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Print");
    expect(container.textContent).toMatch(/0xaaaa.{1,3}aaaa/i);
    expect(container.textContent).toContain("ship to stealth");
  });
});

describe("StorefrontPage — FixedPrice mode (§15.x)", () => {
  beforeEach(() => {
    readContractMock = makeReadContract(buildListing({ mode: MODE_FIXED }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  });

  it("renders 'Buy now' CTA + exact-price hint", async () => {
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Buy now");
    expect(container.textContent).toContain("must equal the seller's price exactly");
    expect(container.textContent).toContain("via FHE");
  });

  it("input sanitizer strips non-numeric (third independent enforcement after Receive + Requests + SendAmount + Crowdfund)", async () => {
    const { findByPlaceholderText } = render(<StorefrontPage />);
    const input = (await findByPlaceholderText("10.00")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc12.34$" } });
    expect(input.value).toBe("12.34");
  });

  it("Buy now disabled when amount empty + when amount <= 0", async () => {
    const { findByText, findByPlaceholderText } = render(<StorefrontPage />);
    let btn = (await findByText("Buy now")).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const input = (await findByPlaceholderText("10.00")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });
    btn = (await findByText("Buy now")).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Buy now click calls buyFixed with listingId/vault/offerTokens/decimals=6", async () => {
    const { findByText, findByPlaceholderText } = render(<StorefrontPage />);
    fireEvent.change(await findByPlaceholderText("10.00"), { target: { value: "25.50" } });
    const btn = await findByText("Buy now");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(buyFixedMock).toHaveBeenCalledWith({
      listingId: 5,
      vault: VAULT,
      offerTokens: "25.50",
      decimals: 6,
    });
  });
});

describe("StorefrontPage — PayWhatYouWant mode (§15.x)", () => {
  beforeEach(() => {
    readContractMock = makeReadContract(buildListing({ mode: MODE_PWYW }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  });

  it("renders 'Send' CTA + tip-jar hint (different copy from FixedPrice)", async () => {
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Send");
    expect(container.textContent).toContain("Tip jar");
    expect(container.textContent).toContain("never individual amounts");
    expect(container.textContent).not.toContain("must equal the seller's price exactly");
  });

  it("Send click calls payPWYW with listingId/vault/amountTokens/decimals=6", async () => {
    const { findByText, findByPlaceholderText } = render(<StorefrontPage />);
    fireEvent.change(await findByPlaceholderText("any amount"), { target: { value: "7" } });
    const btn = await findByText("Send");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(payPWYWMock).toHaveBeenCalledWith({
      listingId: 5,
      vault: VAULT,
      amountTokens: "7",
      decimals: 6,
    });
  });
});

describe("StorefrontPage — Auction mode 3-substate machine (§15.x)", () => {
  it("getBidCount IS fetched when mode === Auction", async () => {
    readContractMock = makeReadContract(buildListing({ mode: MODE_AUCTION }), 3);
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Place bid");
    expect(container.textContent).toContain("3 bids so far");
  });

  it("getBidCount NOT fetched when mode === FixedPrice (per-mode call gate)", async () => {
    readContractMock = makeReadContract(buildListing({ mode: MODE_FIXED }), 99);
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    await findByText("Buy now");
    const calls = readContractMock.mock.calls.map((c) => c[0].functionName);
    expect(calls).not.toContain("getBidCount");
    expect(calls).toContain("getListing");
  });

  it("open auction (now < closesAt + !closed) -> 'Place bid' + 'left' time pill", async () => {
    const future = Math.floor(Date.now() / 1000) + 86400 * 3 + 3600 * 5; // 3d 5h
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closesAt: BigInt(future), closed: false }),
      2,
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Place bid");
    expect(container.textContent).toMatch(/3d \d+h \d+m left/);
    expect(container.textContent).toContain("2 bids so far");
  });

  it("singular '1 bid' when bidCount=1 (plural/singular split)", async () => {
    readContractMock = makeReadContract(
      buildListing({
        mode: MODE_AUCTION,
        closesAt: BigInt(Math.floor(Date.now() / 1000) + 86400),
      }),
      1,
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Place bid");
    expect(container.textContent).toContain("1 bid so far");
    expect(container.textContent).not.toContain("1 bids so far");
  });

  it("Place bid click calls placeBid with listingId/vault/bidTokens/decimals=6", async () => {
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closesAt: BigInt(Math.floor(Date.now() / 1000) + 86400) }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, findByPlaceholderText } = render(<StorefrontPage />);
    fireEvent.change(await findByPlaceholderText("enter your max"), { target: { value: "100" } });
    const btn = await findByText("Place bid");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(placeBidMock).toHaveBeenCalledWith({
      listingId: 5,
      vault: VAULT,
      bidTokens: "100",
      decimals: 6,
    });
  });

  it("open auction hint mentions 'encrypted', 'can't see', 'highest bid wins'", async () => {
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closesAt: BigInt(Math.floor(Date.now() / 1000) + 86400) }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Place bid");
    expect(container.textContent).toContain("Bids are encrypted");
    expect(container.textContent).toContain("Highest bid wins at close");
  });

  it("needsClose state (past closesAt + !closed) -> 'Close auction' CTA + 'Anyone can finalize' copy", async () => {
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closesAt: BigInt(Math.floor(Date.now() / 1000) - 1), closed: false }),
      5,
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Close auction");
    expect(container.textContent).toContain("Anyone can finalize");
    expect(container.textContent).toContain("5 total bids");
  });

  it("Close auction click calls closeAuction(listingId)", async () => {
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closesAt: BigInt(Math.floor(Date.now() / 1000) - 1), closed: false }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    const btn = await findByText("Close auction");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(closeAuctionMock).toHaveBeenCalledWith(5);
  });

  // closeAuction requires >= 1 bid, so every closed auction below has bids.
  it("closed + revealed + viewer is winner -> 'Winner:' banner + 'Claim your win'", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: WINNER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      1,
      [[WINNER, false]],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Claim your win");
    expect(container.textContent).toContain("Winner:");
    expect(container.textContent).toContain("You");
    expect(container.textContent).toMatch(/0xcccc.{1,3}cccc/i);
  });

  it("CRITICAL closed-state priority: closed=true overrides past-closesAt + !closed boundary", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: WINNER });
    readContractMock = makeReadContract(
      buildListing({
        mode: MODE_AUCTION,
        closed: true,
        closesAt: BigInt(Math.floor(Date.now() / 1000) - 100),
        winner: WINNER,
      }),
      1,
      [[WINNER, false]],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Claim your win");
    expect(container.textContent).not.toContain("Close auction");
  });

  it("Claim click calls claimAuctionWin(listingId)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: WINNER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      1,
      [[WINNER, false]],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    const btn = await findByText("Claim your win");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(claimAuctionWinMock).toHaveBeenCalledWith(5);
  });

  it("anyone can settle: non-winner sees 'Settle auction (pay the seller)' and it calls claimAuctionWin", async () => {
    const NON_WINNER = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: NON_WINNER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      1,
      [[WINNER, false]],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, queryByText } = render(<StorefrontPage />);
    const btn = await findByText("Settle auction (pay the seller)");
    expect(queryByText("Claim your win")).toBeNull();
    await findByText(/didn't bid on this auction/i);
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(claimAuctionWinMock).toHaveBeenCalledWith(5);
  });

  it("winning bid already settled -> 'Settled' banner, no settle CTA", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: WINNER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      1,
      [[WINNER, true]],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByTestId, queryByText } = render(<StorefrontPage />);
    await findByTestId("auction-settled");
    expect(queryByText("Claim your win")).toBeNull();
  });

  it("closed but winner not revealed (zero winner) -> 'Reveal winner' CTA, no settle, no refund", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: WINNER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: ZERO }),
      2,
      [[WINNER, false], [ZERO, false]],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container, queryByText } = render(<StorefrontPage />);
    const btn = await findByText("Reveal winner");
    expect(container.textContent).toContain("Refunds and settlement open after the reveal");
    expect(queryByText("Claim your win")).toBeNull();
    expect(queryByText(/Your bid/)).toBeNull();
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(revealWinnerMock).toHaveBeenCalledWith(5);
  });

  it("no connected wallet on revealed auction -> 'Connect your wallet' fallback (no settle CTA, no bid list)", async () => {
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      1,
      [[WINNER, false]],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, queryByText } = render(<StorefrontPage />);
    await findByText(/Connect your wallet to settle/i);
    expect(queryByText("Claim your win")).toBeNull();
    expect(queryByText(/Your bid/)).toBeNull();
  });
});

describe("StorefrontPage — refund via on-chain bid list (§15.x, replaces prompt validation)", () => {
  const VIEWER = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
  const OTHER  = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as `0x${string}`;

  beforeEach(() => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
  });

  it("viewer has no bids on this closed auction -> 'You didn't bid on this auction.'", async () => {
    // 3 bids on chain, none placed by the viewer.
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      3,
      [
        [OTHER, false],
        [OTHER, false],
        [OTHER, false],
      ],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, queryByTestId } = render(<StorefrontPage />);
    await findByText(/didn't bid on this auction/i);
    expect(queryByTestId("my-bids-list")).toBeNull();
    expect(refundLoserBidMock).not.toHaveBeenCalled();
  });

  it("viewer has a single losing bid -> 'Bid #N' row appears + click calls refundLoserBid", async () => {
    // Three bids; viewer placed bid #1.
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      3,
      [
        [OTHER, false],
        [VIEWER, false],
        [OTHER, false],
      ],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, findByTestId } = render(<StorefrontPage />);
    await findByTestId("my-bids-list");
    const row = await findByText("Bid #1");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    expect(refundLoserBidMock).toHaveBeenCalledWith(5, 1);
  });

  it("already-refunded bids render as 'Refunded' and the button is disabled", async () => {
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      2,
      [
        [VIEWER, true],   // already refunded
        [VIEWER, false],
      ],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByTestId, findByText } = render(<StorefrontPage />);
    await findByTestId("my-bids-list");
    const refundedRow = await findByText("Bid #0");
    expect((refundedRow.closest("button") as HTMLButtonElement).disabled).toBe(true);
    // Sibling row shows "Refund" text (the unrefunded one).
    await findByText("Refund");
  });

  it("loading state: while getBid is pending, 'Checking bids…' is shown", async () => {
    // getListing + getBidCount resolve, getBid never resolves.
    let resolveBid!: (v: unknown) => void;
    readContractMock = vi.fn().mockImplementation((args: { functionName: string }) => {
      if (args.functionName === "getListing")
        return Promise.resolve(buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }));
      if (args.functionName === "getBidCount") return Promise.resolve(BigInt(1));
      return new Promise((res) => { resolveBid = res; });
    });
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    await findByText(/Checking bids/);
    // Resolve so the test doesn't leak a pending promise.
    await act(async () => { resolveBid([OTHER, false]); await Promise.resolve(); });
  });
});

describe("StorefrontPage — success terminal + pipeline + error (§15.x)", () => {
  it("state.step === 'success' shows payment confirmation, seller handoff, and refresh controls", async () => {
    setHook({ step: "success" });
    readContractMock = makeReadContract(buildListing({ deliveryChannel: "DM @alice" }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Payment confirmed");
    expect(container.textContent).toContain("Delivery pending");
    expect(container.textContent).toContain("encrypted payment is on-chain");
    expect(container.textContent).toContain("Seller handoff");
    expect(container.textContent).toContain("DM @alice");
    expect(container.textContent).toContain("Copy reference");
    expect(container.textContent).toContain("Refresh listing");
    const link = (await findByText("Open Blank")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/app");
  });

  it("success state: delivery channel HIDDEN when empty string", async () => {
    setHook({ step: "success" });
    readContractMock = makeReadContract(buildListing({ deliveryChannel: "" }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Payment confirmed");
    expect(container.textContent).not.toContain("Seller handoff");
    expect(container.textContent).not.toContain("DM @alice");
  });

  it("pipeline.phase !== 'idle' renders FhePipelineProgress", async () => {
    setHook({ pipelinePhase: "encrypting" });
    const { findByTestId } = render(<StorefrontPage />);
    const pipe = await findByTestId("fhe-pipeline-progress");
    expect(pipe.getAttribute("data-phase")).toBe("encrypting");
  });

  it("state.error renders inline (not silent)", async () => {
    setHook({ error: "auction already closed" });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("auction already closed")).toBeDefined();
  });
});

describe("StorefrontPage — cancellation guard (§15.x)", () => {
  it("CRITICAL: unmount during pending readContract does NOT setState on unmounted component", async () => {
    let resolveRead!: (v: unknown) => void;
    readContractMock = vi.fn().mockReturnValue(new Promise((res) => { resolveRead = res; }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<StorefrontPage />);
    unmount();

    await act(async () => {
      resolveRead(buildListing());
      await Promise.resolve();
      await Promise.resolve();
    });

    const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(calls.some((c) => c.includes("unmounted component"))).toBe(false);
    consoleErrorSpy.mockRestore();
  });
});

describe("StorefrontPage — paid-by-buyer check (audit fix)", () => {
  const SELLER_ADDR = "0x9999999999999999999999999999999999999999" as `0x${string}`;
  const BUYER = "0x8888888888888888888888888888888888888888" as `0x${string}`;

  it("seller on a FixedPrice listing sees the buyer check instead of the buy form, and it decrypts", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: SELLER_ADDR });
    readContractMock = makeReadContract(buildListing({ seller: SELLER_ADDR }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    decryptPaidByBuyerMock.mockResolvedValue(3_000_000n);
    const { findByTestId, container, queryByText } = render(<StorefrontPage />);
    const panel = await findByTestId("storefront-seller-check");
    expect(queryByText("Buy now")).toBeNull();
    const input = panel.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: BUYER } });
    const btn = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent?.includes("Decrypt payment")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(decryptPaidByBuyerMock).toHaveBeenCalledWith(5, BUYER);
    await waitFor(() => expect(container.textContent).toContain("Paid in total: 3 USDC"));
  });

  it("paid 0 -> honest 'Nothing was paid' copy", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: SELLER_ADDR });
    readContractMock = makeReadContract(buildListing({ seller: SELLER_ADDR }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    decryptPaidByBuyerMock.mockResolvedValue(0n);
    const { findByTestId, container } = render(<StorefrontPage />);
    const panel = await findByTestId("storefront-seller-check");
    fireEvent.change(panel.querySelector("input") as HTMLInputElement, { target: { value: BUYER } });
    const btn = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent?.includes("Decrypt payment")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    await waitFor(() => expect(container.textContent).toContain("Nothing was paid"));
  });
});

describe("StorefrontPage — funding gate", () => {
  const VIEWER = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
  const pending = [{ purchaseId: "4", listingId: 5, hash: "0xbuy" }];

  it("a pending payment for this listing shows the banner and finishes on its own", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    setHook({ pendingPurchases: pending });
    const { findByTestId } = render(<StorefrontPage />);
    const banner = await findByTestId("storefront-pending-payment");
    expect(banner.textContent).toContain("not confirmed yet");
    await waitFor(() => expect(finishPendingPurchasesMock).toHaveBeenCalledWith(5));
    expect(finishPendingPurchasesMock).toHaveBeenCalledTimes(1);
  });

  it("the Finish button retries by hand", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    setHook({ pendingPurchases: pending });
    const { findByTestId } = render(<StorefrontPage />);
    await waitFor(() => expect(finishPendingPurchasesMock).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(await findByTestId("storefront-finish-payment")); });
    expect(finishPendingPurchasesMock).toHaveBeenCalledTimes(2);
    expect(finishPendingPurchasesMock).toHaveBeenLastCalledWith(5);
  });

  it("waits for the FHE session instead of failing", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    setHook({ pendingPurchases: pending, fheReady: false });
    const { findByTestId } = render(<StorefrontPage />);
    const btn = (await findByTestId("storefront-finish-payment")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Connecting");
    expect(finishPendingPurchasesMock).not.toHaveBeenCalled();
  });

  it("a pending payment on another listing does not show a banner here", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    setHook({ pendingPurchases: [{ purchaseId: "9", listingId: 77, hash: "0xother" }] });
    const { findByText, queryByTestId } = render(<StorefrontPage />);
    await findByText("Buy now");
    expect(queryByTestId("storefront-pending-payment")).toBeNull();
  });

  it("no pending payment: no banner (the hook is asked once and finds nothing)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    const { findByText, queryByTestId } = render(<StorefrontPage />);
    await findByText("Buy now");
    expect(queryByTestId("storefront-pending-payment")).toBeNull();
    await waitFor(() => expect(finishPendingPurchasesMock).toHaveBeenCalledTimes(1));
    expect(finishPendingPurchasesMock).toHaveBeenCalledWith(5);
  });

  it("the automatic resume runs once per visit, not again when a payment fails during it", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    const { findByText, rerender } = render(<StorefrontPage />);
    await findByText("Buy now");
    await waitFor(() => expect(finishPendingPurchasesMock).toHaveBeenCalledTimes(1));
    setHook({ pendingPurchases: pending });
    rerender(<StorefrontPage />);
    await act(async () => { await Promise.resolve(); });
    expect(finishPendingPurchasesMock).toHaveBeenCalledTimes(1);
  });
});

describe("StorefrontPage — auction closed with no winner", () => {
  const VIEWER = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
  const OTHER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as `0x${string}`;

  function noWinnerAuction(bids: ReadonlyArray<readonly [`0x${string}`, boolean]>) {
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: ZERO }),
      bids.length,
      bids,
      true,
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  }

  it("says nobody won, offers no reveal and no settle", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    noWinnerAuction([[OTHER, false], [VIEWER, false]]);
    const { findByTestId, queryByTestId, queryByText } = render(<StorefrontPage />);
    const banner = await findByTestId("auction-no-winner");
    expect(banner.textContent).toContain("No winning bid: all bids refundable");
    expect(queryByText("Reveal winner")).toBeNull();
    expect(queryByTestId("auction-reveal")).toBeNull();
    expect(queryByTestId("auction-settle")).toBeNull();
    expect(queryByText("Claim your win")).toBeNull();
  });

  it("refund is offered for bid #0 and the click refunds index 0", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    noWinnerAuction([[VIEWER, false], [OTHER, false]]);
    const { findByTestId, findByText } = render(<StorefrontPage />);
    await findByTestId("my-bids-list");
    const row = await findByText("Bid #0");
    expect((row.closest("button") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(row); await Promise.resolve(); });
    expect(refundLoserBidMock).toHaveBeenCalledWith(5, 0);
  });

  it("a refunded bid is shown as refunded", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    noWinnerAuction([[VIEWER, true]]);
    const { findByText } = render(<StorefrontPage />);
    const row = await findByText("Bid #0");
    expect((row.closest("button") as HTMLButtonElement).disabled).toBe(true);
    await findByText("Refunded");
  });

  it("no wallet connected: asks to connect to refund", async () => {
    noWinnerAuction([[OTHER, false]]);
    const { findByText } = render(<StorefrontPage />);
    await findByText(/Connect your wallet to refund your bid/);
  });

  it("a viewer who did not bid is told so", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    noWinnerAuction([[OTHER, false]]);
    const { findByText } = render(<StorefrontPage />);
    await findByText(/didn't bid on this auction/i);
  });

  it("pre-gate Storefront (no auctionHasNoWinner view): unrevealed auction still offers Reveal winner", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: ZERO }),
      1,
      [[VIEWER, false]],
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, queryByTestId } = render(<StorefrontPage />);
    await findByText("Reveal winner");
    expect(queryByTestId("auction-no-winner")).toBeNull();
  });

  it("an auction with a winner is not flagged no-winner", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VIEWER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
      1,
      [[WINNER, false]],
      false,
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByTestId, queryByTestId } = render(<StorefrontPage />);
    await findByTestId("auction-settle");
    expect(queryByTestId("auction-no-winner")).toBeNull();
  });
});
