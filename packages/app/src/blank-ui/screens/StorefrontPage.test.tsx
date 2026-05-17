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

function makeReadContract(listing: readonly unknown[], bidCount = 0) {
  return vi.fn().mockImplementation(async (args: { functionName: string }) => {
    if (args.functionName === "getListing") return listing;
    if (args.functionName === "getBidCount") return BigInt(bidCount);
    return null;
  });
}

function setHook(overrides: Partial<{
  step: "idle" | "encrypting" | "sending" | "success" | "error";
  isProcessing: boolean;
  error: string | null;
  pipelinePhase: string;
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
    refundLoserBid: refundLoserBidMock,
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

  it("readContract throws Error -> error.message rendered", async () => {
    readContractMock = vi.fn().mockRejectedValue(new Error("RPC down"));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("RPC down")).toBeDefined();
  });

  it("readContract throws non-Error -> 'Failed to load listing' fallback", async () => {
    readContractMock = vi.fn().mockRejectedValue("rejection string");
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<StorefrontPage />);
    expect(await findByText("Failed to load listing")).toBeDefined();
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

  it("closed state (closed=true) + viewer is winner -> 'Winner:' banner + 'Claim your win' + 'Refund my losing bid' buttons", async () => {
    // C6 fix: Claim CTA is now gated to the actual winner. Connect as
    // WINNER to see the Claim flow + 'You' badge.
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: WINNER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Claim your win");
    expect(container.textContent).toContain("Winner:");
    expect(container.textContent).toContain("You");
    expect(container.textContent).toContain("Refund my losing bid");
    expect(container.textContent).toMatch(/0xcccc.{1,3}cccc/i);
  });

  it("CRITICAL closed-state priority: closed=true overrides past-closesAt + !closed boundary", async () => {
    // Both closed=true AND past-closesAt (would trigger needsClose if cascade reversed)
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: WINNER });
    readContractMock = makeReadContract(
      buildListing({
        mode: MODE_AUCTION,
        closed: true,
        closesAt: BigInt(Math.floor(Date.now() / 1000) - 100),
        winner: WINNER,
      }),
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

  it("C6: viewer is NOT winner -> Claim CTA hidden, explanation banner shown, refund still works", async () => {
    const NON_WINNER = "0xdddddddddddddddddddddddddddddddddddddddd";
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: NON_WINNER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container, queryByText } = render(<StorefrontPage />);
    await findByText(/aren't the winner/i);
    expect(queryByText("Claim your win")).toBeNull();
    expect(container.textContent).toContain("Refund my losing bid");
  });

  it("C11: closed state with zero winner (no bids) -> 'closed without bids' state, no Claim, no refund", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: WINNER });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: ZERO }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container, queryByText } = render(<StorefrontPage />);
    await findByText(/closed without bids/i);
    expect(queryByText("Claim your win")).toBeNull();
    expect(queryByText("Refund my losing bid")).toBeNull();
    expect(container.textContent).not.toContain("Winner:");
  });

  it("C6: no connected wallet on closed auction -> 'Connect your wallet' fallback (no Claim CTA, refund disabled)", async () => {
    // Default beforeEach already sets effectiveAddress: undefined.
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, queryByText } = render(<StorefrontPage />);
    await findByText(/Connect your wallet to claim/i);
    expect(queryByText("Claim your win")).toBeNull();
    // Refund button is rendered but disabled.
    const refundBtn = await findByText("Refund my losing bid");
    expect((refundBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("StorefrontPage — refund prompt validation (mirrors CrowdfundPage) (§15.x)", () => {
  beforeEach(() => {
    // Refund requires a connected viewer per the C6 fix (button is
    // disabled otherwise). The validation tests below all assume a
    // connected wallet.
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
    });
    readContractMock = makeReadContract(
      buildListing({ mode: MODE_AUCTION, closed: true, winner: WINNER }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  });

  it("user cancel (null) -> silent, no toast + no refund call", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const { findByText } = render(<StorefrontPage />);
    fireEvent.click(await findByText("Refund my losing bid"));
    expect(refundLoserBidMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("empty trimmed -> 'Bid index required' toast", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("   ");
    const { findByText } = render(<StorefrontPage />);
    fireEvent.click(await findByText("Refund my losing bid"));
    expect(toastErrorMock).toHaveBeenCalledWith("Bid index required");
  });

  it("non-numeric -> 'non-negative integer' toast", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("abc");
    const { findByText } = render(<StorefrontPage />);
    fireEvent.click(await findByText("Refund my losing bid"));
    expect((toastErrorMock.mock.calls[0][0] as string)).toContain("non-negative integer");
  });

  it("CRITICAL fractional '1.5' rejected (String(idx)!==trimmed guard)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("1.5");
    const { findByText } = render(<StorefrontPage />);
    fireEvent.click(await findByText("Refund my losing bid"));
    expect(toastErrorMock).toHaveBeenCalled();
    expect(refundLoserBidMock).not.toHaveBeenCalled();
  });

  it("CRITICAL leading-zero '007' rejected (same guard)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("007");
    const { findByText } = render(<StorefrontPage />);
    fireEvent.click(await findByText("Refund my losing bid"));
    expect(toastErrorMock).toHaveBeenCalled();
    expect(refundLoserBidMock).not.toHaveBeenCalled();
  });

  it("valid '3' -> refundLoserBid(listingId, 3)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("3");
    const { findByText } = render(<StorefrontPage />);
    const btn = await findByText("Refund my losing bid");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(refundLoserBidMock).toHaveBeenCalledWith(5, 3);
  });

  it("valid '0' -> refundLoserBid(listingId, 0)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("0");
    const { findByText } = render(<StorefrontPage />);
    const btn = await findByText("Refund my losing bid");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(refundLoserBidMock).toHaveBeenCalledWith(5, 0);
  });
});

describe("StorefrontPage — success terminal + pipeline + error (§15.x)", () => {
  it("state.step === 'success' shows 'Done' + delivery channel + Open Blank link", async () => {
    setHook({ step: "success" });
    readContractMock = makeReadContract(buildListing({ deliveryChannel: "DM @alice" }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Done");
    expect(container.textContent).toContain("encrypted payment is locked in");
    expect(container.textContent).toContain("DM @alice");
    const link = (await findByText("Open Blank")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/app");
  });

  it("success state: delivery channel HIDDEN when empty string", async () => {
    setHook({ step: "success" });
    readContractMock = makeReadContract(buildListing({ deliveryChannel: "" }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<StorefrontPage />);
    await findByText("Done");
    expect(container.textContent).not.toContain("Delivery:");
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
