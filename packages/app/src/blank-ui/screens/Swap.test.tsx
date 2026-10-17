import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// Exchange screen: DEX (default) | Bridge | P2P (retired).
//
// Pins:
//   - ?tab= is the source of truth; invalid or missing falls back to "dex",
//     setTab("dex") clears the param, others set it with replace:true.
//   - P2PExchange is retired on-chain (createOffer/fillOffer revert). The
//     P2P tab has no create form and no Fill button. It keeps the exits
//     the contract still supports: cancel my open offers, verify past fills.
//   - The retired banner links to the fiat offramp.

const useSearchParamsMock = vi.hoisted(() => vi.fn());
const useExchangeMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useSearchParams: useSearchParamsMock,
  Link: (props: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={props.to} className={props.className}>{props.children}</a>
  ),
}));
vi.mock("@/hooks/useExchange", () => ({ useExchange: useExchangeMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({ useEffectiveAddress: useEffectiveAddressMock }));
vi.mock("./DexSwapTab", () => ({
  default: () => <div data-testid="dex-tab-sentinel">DexSwap rendered</div>,
}));
vi.mock("./Bridge", () => ({
  default: (props: { embedded?: boolean }) => (
    <div data-testid="bridge-tab-sentinel" data-embedded={props.embedded ? "true" : "false"}>
      Bridge rendered
    </div>
  ),
}));

import Swap from "./Swap";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let setSearchParamsMock: ReturnType<typeof vi.fn>;
let cancelOfferMock: ReturnType<typeof vi.fn>;
let verifyTradeMock: ReturnType<typeof vi.fn>;

function setSearchParams(tab: string | null) {
  const params = new URLSearchParams();
  if (tab !== null) params.set("tab", tab);
  setSearchParamsMock = vi.fn();
  useSearchParamsMock.mockReturnValue([params, setSearchParamsMock]);
}

type OfferRow = {
  id: number;
  offer_id: number;
  maker_address: string;
  amount_give: number;
  amount_want: number;
  status: "active" | "filled" | "cancelled";
  created_at: string;
  expiry: string | null;
};

function buildOffer(over: Partial<OfferRow> = {}): OfferRow {
  return {
    id: 1,
    offer_id: 11,
    maker_address: ALICE.toLowerCase(),
    amount_give: 1_000_000,
    amount_want: 2_000_000,
    status: "active",
    created_at: new Date().toISOString(),
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    ...over,
  };
}

function setExchange(over: Partial<{ offers: OfferRow[]; filledOffers: OfferRow[]; isLoadingOffers: boolean; verifyingOfferId: number | null }> = {}) {
  useExchangeMock.mockReturnValue({
    offers: over.offers ?? [],
    filledOffers: over.filledOffers ?? [],
    isLoadingOffers: over.isLoadingOffers ?? false,
    isCancelling: false,
    cancelOffer: cancelOfferMock,
    verifyTrade: verifyTradeMock,
    verifyingOfferId: over.verifyingOfferId ?? null,
  });
}

beforeEach(() => {
  useExchangeMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  cancelOfferMock = vi.fn();
  verifyTradeMock = vi.fn();
  setSearchParams(null);
  setExchange();
});

describe("Swap — page chrome + tabs", () => {
  it("renders 'Exchange' heading with DEX / Bridge / P2P (Retired) tabs", () => {
    const { container, getByTestId } = render(<Swap />);
    expect(container.textContent).toContain("Exchange");
    expect(getByTestId("exchange-tab-dex").textContent).toContain("Uniswap v3");
    expect(getByTestId("exchange-tab-bridge").textContent).toContain("CCTP V2");
    expect(getByTestId("exchange-tab-p2p").textContent).toContain("Retired");
  });

  it("default (no ?tab=) -> DEX selected", () => {
    const { getByTestId } = render(<Swap />);
    expect(getByTestId("dex-tab-sentinel")).toBeDefined();
    expect(getByTestId("exchange-tab-dex").getAttribute("aria-selected")).toBe("true");
  });

  it("invalid ?tab= falls back to DEX", () => {
    setSearchParams("garbage");
    const { getByTestId } = render(<Swap />);
    expect(getByTestId("dex-tab-sentinel")).toBeDefined();
  });

  it("?tab=bridge renders the embedded Bridge", () => {
    setSearchParams("bridge");
    const { getByTestId } = render(<Swap />);
    expect(getByTestId("bridge-tab-sentinel").getAttribute("data-embedded")).toBe("true");
  });

  it("setTab('dex') clears ?tab=; setTab('p2p') sets it with replace:true", () => {
    setSearchParams("bridge");
    const { getByTestId } = render(<Swap />);
    fireEvent.click(getByTestId("exchange-tab-dex"));
    expect((setSearchParamsMock.mock.calls[0][0] as URLSearchParams).get("tab")).toBeNull();
    fireEvent.click(getByTestId("exchange-tab-p2p"));
    expect((setSearchParamsMock.mock.calls[1][0] as URLSearchParams).get("tab")).toBe("p2p");
    expect(setSearchParamsMock.mock.calls[1][1]).toEqual({ replace: true });
  });
});

describe("Swap — retired P2P tab", () => {
  beforeEach(() => setSearchParams("p2p"));

  it("shows the retired banner with a link to the offramp, and no create form or Fill button", () => {
    setExchange({ offers: [buildOffer()] });
    const { getByTestId, container, queryByText } = render(<Swap />);
    expect(getByTestId("p2p-retired-banner").textContent).toContain("retired");
    expect(container.querySelector("a[href='/app/offramp']")).not.toBeNull();
    expect(queryByText("Create Swap Offer")).toBeNull();
    expect(queryByText("Fill Offer")).toBeNull();
    // Someone else's open offer is not actionable any more.
    expect(container.textContent).not.toContain("Available Offers");
  });

  it("lists MY open offers with a Cancel exit that calls cancelOffer after confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    setExchange({ offers: [buildOffer({ maker_address: ME, offer_id: 42 }), buildOffer({ id: 2, offer_id: 43 })] });
    const { getByTestId, getByLabelText } = render(<Swap />);
    expect(getByTestId("p2p-my-open-offers").textContent).toContain("#42");
    expect(getByTestId("p2p-my-open-offers").textContent).not.toContain("#43");
    fireEvent.click(getByLabelText("Cancel offer"));
    expect(cancelOfferMock).toHaveBeenCalledWith(42);
    confirmSpy.mockRestore();
  });

  it("cancel aborted at the confirm dialog -> no cancel call", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    setExchange({ offers: [buildOffer({ maker_address: ME, offer_id: 42 })] });
    const { getByLabelText } = render(<Swap />);
    fireEvent.click(getByLabelText("Cancel offer"));
    expect(cancelOfferMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("past fills keep the Verify trade action", () => {
    setExchange({ filledOffers: [buildOffer({ status: "filled", offer_id: 7, maker_address: ME })] });
    const { getByLabelText, container } = render(<Swap />);
    expect(container.textContent).toContain("Sold");
    fireEvent.click(getByLabelText("Verify trade on-chain"));
    expect(verifyTradeMock).toHaveBeenCalledWith(7);
  });

  it("nothing open and no history -> honest empty state", () => {
    const { getByTestId } = render(<Swap />);
    expect(getByTestId("p2p-retired-empty").textContent).toContain("no open offers");
  });

  it("loading -> spinner copy", () => {
    setExchange({ isLoadingOffers: true });
    const { container } = render(<Swap />);
    expect(container.textContent).toContain("Loading your offers");
  });
});
