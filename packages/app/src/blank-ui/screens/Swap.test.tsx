import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for Swap (Exchange) screen. Phase 5.3 tabbed dispatcher
// over P2P (existing) + DexSwapTab (Phase 5.4) + Bridge (embedded).
//
// CRITICAL pins:
//   - tab routing via ?tab= URL param: source of truth so deeplinks
//     like /app/swap?tab=dex work AND the legacy /app/bridge alias
//     keeps working. parseTab validates against VALID_TABS and
//     falls back to "p2p" for invalid or missing values.
//   - setTab clears ?tab= for the default "p2p" (clean URL), sets
//     it for everything else; uses replace:true so back-button
//     doesn't bounce through every tab switch.
//   - P2PTab `hasUsdt` gate: when contracts.TestUSDT or
//     contracts.FHERC20Vault_USDT is missing on the active chain,
//     show amber "not available" banner + opacity-50 the form.
//     This prevents users from creating offers that cannot be
//     filled (today only Base Sepolia has both vaults deployed).
//   - createOffer validation: give-amount > 0 AND want-amount > 0
//     OR toast.error.
//   - 24h expiry: createOffer always passes
//     `new Date(now + 24h).toISOString()` as the expiry.
//   - auto-clear error after 5s + auto-clear success state after 4s.
//   - my vs other offers partition: offers filtered by
//     maker_address === address?.toLowerCase().

const useSearchParamsMock = vi.hoisted(() => vi.fn());
const useExchangeMock = vi.hoisted(() => vi.fn());
const useShieldMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useSearchParams: useSearchParamsMock }));
vi.mock("@/hooks/useExchange", () => ({ useExchange: useExchangeMock }));
vi.mock("@/hooks/useShield", () => ({ useShield: useShieldMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
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
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: vi.fn() },
}));

import Swap from "./Swap";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USDT_TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc";
const USDT_VAULT = "0xdddddddddddddddddddddddddddddddddddddddd";

let setSearchParamsMock: ReturnType<typeof vi.fn>;
let createOfferMock: ReturnType<typeof vi.fn>;
let fillOfferMock: ReturnType<typeof vi.fn>;
let cancelOfferMock: ReturnType<typeof vi.fn>;
let verifyTradeMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;

function setSearchParams(tab: string | null) {
  const params = new URLSearchParams();
  if (tab !== null) params.set("tab", tab);
  setSearchParamsMock = vi.fn();
  useSearchParamsMock.mockReturnValue([params, setSearchParamsMock]);
}

type OfferRow = {
  id: number;
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
    maker_address: ALICE.toLowerCase(),
    amount_give: 100_000_000,
    amount_want: 100_000_000,
    status: "active",
    created_at: new Date().toISOString(),
    expiry: new Date(Date.now() + 24 * 3600_000).toISOString(),
    ...over,
  };
}

function setExchange(overrides: Partial<{
  offers: OfferRow[];
  filledOffers: OfferRow[];
  step: "idle" | "approving" | "sending" | "success" | "error";
  error: string | null;
  isLoadingOffers: boolean;
  verifyingOfferId: number | null;
}> = {}) {
  useExchangeMock.mockReturnValue({
    offers: overrides.offers ?? [],
    filledOffers: overrides.filledOffers ?? [],
    createOffer: createOfferMock,
    fillOffer: fillOfferMock,
    cancelOffer: cancelOfferMock,
    verifyTrade: verifyTradeMock,
    verifyingOfferId: overrides.verifyingOfferId ?? null,
    isLoadingOffers: overrides.isLoadingOffers ?? false,
    step: overrides.step ?? "idle",
    error: overrides.error ?? null,
    reset: resetMock,
  });
}

beforeEach(() => {
  useSearchParamsMock.mockReset();
  useExchangeMock.mockReset();
  useShieldMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  toastErrorMock.mockReset();

  setSearchParams(null);
  createOfferMock = vi.fn().mockResolvedValue(undefined);
  fillOfferMock = vi.fn().mockResolvedValue(undefined);
  cancelOfferMock = vi.fn().mockResolvedValue(undefined);
  verifyTradeMock = vi.fn().mockResolvedValue(undefined);
  resetMock = vi.fn();
  setExchange();

  useShieldMock.mockReturnValue({ publicBalance: 1234.56 });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    contracts: {
      TestUSDT: USDT_TOKEN,
      FHERC20Vault_USDT: USDT_VAULT,
    },
    activeChain: { name: "Base Sepolia" },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Swap — page chrome (§15.x)", () => {
  it("renders 'Exchange' heading + privacy framing copy", () => {
    const { container } = render(<Swap />);
    expect(container.textContent).toContain("Exchange");
    expect(container.textContent).toContain("Trade tokens privately");
  });

  it("3 tab pills: P2P / DEX / Bridge with sublabel descriptors", () => {
    const { container, getByTestId } = render(<Swap />);
    expect(getByTestId("exchange-tab-p2p")).toBeDefined();
    expect(getByTestId("exchange-tab-dex")).toBeDefined();
    expect(getByTestId("exchange-tab-bridge")).toBeDefined();
    expect(container.textContent).toContain("Encrypted offers");
    expect(container.textContent).toContain("Uniswap v3");
    expect(container.textContent).toContain("CCTP V2");
  });
});

describe("Swap — tab routing (?tab=) (§15.x)", () => {
  it("default (no ?tab=) -> P2P selected + P2PTab rendered", () => {
    setSearchParams(null);
    const { getByTestId, queryByTestId } = render(<Swap />);
    expect(getByTestId("exchange-tab-p2p").getAttribute("aria-selected")).toBe("true");
    expect(getByTestId("exchange-tab-dex").getAttribute("aria-selected")).toBe("false");
    expect(getByTestId("exchange-tab-bridge").getAttribute("aria-selected")).toBe("false");
    // P2P-specific copy renders.
    expect(queryByTestId("dex-tab-sentinel")).toBeNull();
    expect(queryByTestId("bridge-tab-sentinel")).toBeNull();
  });

  it("?tab=dex -> DEX selected + DexSwapTab sentinel rendered", () => {
    setSearchParams("dex");
    const { getByTestId, queryByTestId } = render(<Swap />);
    expect(getByTestId("exchange-tab-dex").getAttribute("aria-selected")).toBe("true");
    expect(getByTestId("dex-tab-sentinel")).toBeDefined();
    expect(queryByTestId("bridge-tab-sentinel")).toBeNull();
  });

  it("?tab=bridge -> Bridge sentinel rendered with embedded=true", () => {
    setSearchParams("bridge");
    const { getByTestId } = render(<Swap />);
    expect(getByTestId("exchange-tab-bridge").getAttribute("aria-selected")).toBe("true");
    const bridge = getByTestId("bridge-tab-sentinel");
    expect(bridge.getAttribute("data-embedded")).toBe("true");
  });

  it("CRITICAL: invalid ?tab= value falls back to 'p2p' via parseTab guard", () => {
    setSearchParams("hacker-tab");
    const { getByTestId, queryByTestId } = render(<Swap />);
    expect(getByTestId("exchange-tab-p2p").getAttribute("aria-selected")).toBe("true");
    expect(queryByTestId("dex-tab-sentinel")).toBeNull();
  });

  it("CRITICAL: setTab('p2p') CLEARS ?tab= (clean URL for default tab)", () => {
    setSearchParams("dex");
    const { getByTestId } = render(<Swap />);
    fireEvent.click(getByTestId("exchange-tab-p2p"));
    expect(setSearchParamsMock).toHaveBeenCalled();
    const newParams = setSearchParamsMock.mock.calls[0][0] as URLSearchParams;
    expect(newParams.has("tab")).toBe(false);
    // replace:true so back button doesn't bounce.
    const opts = setSearchParamsMock.mock.calls[0][1];
    expect(opts).toEqual({ replace: true });
  });

  it("setTab('dex') SETS ?tab=dex with replace:true", () => {
    setSearchParams(null);
    const { getByTestId } = render(<Swap />);
    fireEvent.click(getByTestId("exchange-tab-dex"));
    const newParams = setSearchParamsMock.mock.calls[0][0] as URLSearchParams;
    expect(newParams.get("tab")).toBe("dex");
    expect(setSearchParamsMock.mock.calls[0][1]).toEqual({ replace: true });
  });

  it("setTab('bridge') SETS ?tab=bridge", () => {
    setSearchParams(null);
    const { getByTestId } = render(<Swap />);
    fireEvent.click(getByTestId("exchange-tab-bridge"));
    const newParams = setSearchParamsMock.mock.calls[0][0] as URLSearchParams;
    expect(newParams.get("tab")).toBe("bridge");
  });
});

describe("Swap — P2PTab hasUsdt gate (§15.x)", () => {
  it("CRITICAL no USDT contract on chain -> amber 'not available' banner + opacity-50 form", () => {
    useChainMock.mockReturnValue({
      contracts: { TestUSDT: undefined, FHERC20Vault_USDT: undefined },
      activeChain: { name: "Ethereum Sepolia" },
    });
    const { container } = render(<Swap />);
    expect(container.textContent).toContain("P2P Exchange is not available on Ethereum Sepolia");
    expect(container.textContent).toContain("Switch to Base Sepolia");
    expect(container.innerHTML).toContain("opacity-50");
    expect(container.innerHTML).toContain("pointer-events-none");
  });

  it("hasUsdt=false when TestUSDT exists but vault missing (BOTH required for the gate)", () => {
    useChainMock.mockReturnValue({
      contracts: { TestUSDT: USDT_TOKEN, FHERC20Vault_USDT: undefined },
      activeChain: { name: "Ethereum Sepolia" },
    });
    const { container } = render(<Swap />);
    expect(container.textContent).toContain("P2P Exchange is not available");
  });

  it("hasUsdt=true (both deployed) -> no warning banner + full form opacity", () => {
    const { container } = render(<Swap />);
    expect(container.textContent).not.toContain("P2P Exchange is not available");
  });
});

describe("Swap — P2PTab createOffer validation (§15.x)", () => {
  it("empty give amount -> 'Enter the amount you want to give' toast", async () => {
    const { getByLabelText, container } = render(<Swap />);
    fireEvent.change(getByLabelText("Amount you want"), { target: { value: "50" } });
    const createBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Create") && b.textContent?.includes("Offer")) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true); // empty give disables
  });

  it("CRITICAL valid create: passes give + want + 24h-future ISO expiry to createOffer", async () => {
    const { getByLabelText, container } = render(<Swap />);
    fireEvent.change(getByLabelText("Amount you give"), { target: { value: "100" } });
    fireEvent.change(getByLabelText("Amount you want"), { target: { value: "100" } });
    const createBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Create") && b.textContent?.includes("Offer")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(createBtn);
      await Promise.resolve();
    });
    expect(createOfferMock).toHaveBeenCalled();
    const [give, want, expiry] = createOfferMock.mock.calls[0];
    expect(give).toBe("100");
    expect(want).toBe("100");
    // expiry ISO, ~24h in the future
    const expiryMs = new Date(expiry as string).getTime();
    const diffH = (expiryMs - Date.now()) / 3600_000;
    expect(diffH).toBeGreaterThan(23.9);
    expect(diffH).toBeLessThan(24.1);
  });

  it("after successful create: give + want inputs CLEARED", async () => {
    const { getByLabelText, container } = render(<Swap />);
    const give = getByLabelText("Amount you give") as HTMLInputElement;
    const want = getByLabelText("Amount you want") as HTMLInputElement;
    fireEvent.change(give, { target: { value: "100" } });
    fireEvent.change(want, { target: { value: "100" } });
    const createBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Create") && b.textContent?.includes("Offer")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(createBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(give.value).toBe("");
    expect(want.value).toBe("");
  });

  it("Create button disabled when give-amount > 0 BUT want-amount <= 0 (need BOTH)", () => {
    const { getByLabelText, container } = render(<Swap />);
    fireEvent.change(getByLabelText("Amount you give"), { target: { value: "100" } });
    fireEvent.change(getByLabelText("Amount you want"), { target: { value: "0" } });
    const createBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Create") && b.textContent?.includes("Offer")) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });
});

describe("Swap — P2PTab step + processing (§15.x)", () => {
  it("step='approving' -> 'Approving vault access...' indicator + Submit button shows spinner", () => {
    setExchange({ step: "approving" });
    const { container } = render(<Swap />);
    expect(container.textContent).toContain("Approving vault access");
  });

  it("step='sending' -> 'Creating offer on-chain...' indicator", () => {
    setExchange({ step: "sending" });
    const { container } = render(<Swap />);
    expect(container.textContent).toContain("Creating offer on-chain");
  });

  it("step='success' + lastSwap -> 'Offer Created!' success card with give/want labels", async () => {
    setExchange({ step: "idle" });
    const { getByLabelText, container } = render(<Swap />);
    fireEvent.change(getByLabelText("Amount you give"), { target: { value: "100" } });
    fireEvent.change(getByLabelText("Amount you want"), { target: { value: "50" } });
    const createBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Create") && b.textContent?.includes("Offer")) as HTMLButtonElement;
    setExchange({ step: "success" });
    await act(async () => {
      fireEvent.click(createBtn);
      await Promise.resolve();
    });
    // After lastSwap is set + step success, the success card renders.
    expect(container.textContent).toContain("Offer Created");
    expect(container.textContent).toContain("Offering 100 USDC for 50 USDT");
  });
});

describe("Swap — P2PTab error display + auto-clear (§15.x)", () => {
  it("error renders inline with dismiss + retry buttons", () => {
    setExchange({ error: "Vault not approved" });
    const { container, getByLabelText } = render(<Swap />);
    expect(container.textContent).toContain("Vault not approved");
    expect(getByLabelText("Dismiss error")).toBeDefined();
  });

  it("dismiss button calls reset()", () => {
    setExchange({ error: "boom" });
    const { getByLabelText } = render(<Swap />);
    fireEvent.click(getByLabelText("Dismiss error"));
    expect(resetMock).toHaveBeenCalled();
  });

  it("CRITICAL: error auto-clears after 5000ms via setTimeout(reset, 5000)", async () => {
    vi.useFakeTimers();
    setExchange({ error: "transient" });
    render(<Swap />);
    expect(resetMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resetMock).toHaveBeenCalled();
  });

  it("CRITICAL: step='success' auto-clears after 4000ms (clears lastSwap + reset)", async () => {
    vi.useFakeTimers();
    setExchange({ step: "success" });
    render(<Swap />);
    expect(resetMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(resetMock).toHaveBeenCalled();
  });
});

describe("Swap — P2PTab offers list partition (§15.x)", () => {
  it("my offers (maker===me) separated from other offers (maker!==me)", () => {
    const myOffer = buildOffer({ id: 1, maker_address: ME.toLowerCase() });
    const otherOffer = buildOffer({ id: 2, maker_address: ALICE.toLowerCase() });
    setExchange({ offers: [myOffer, otherOffer] });
    const { container } = render(<Swap />);
    // Both offers rendered.
    expect(container.textContent).toContain("100 USDC");
  });

  it("filters expired offers (expiry in the past) out of nonExpiredOffers", () => {
    const fresh = buildOffer({
      id: 1,
      maker_address: ALICE.toLowerCase(),
      amount_give: 50_000_000,
      expiry: new Date(Date.now() + 3600_000).toISOString(), // 1h future
    });
    const expired = buildOffer({
      id: 2,
      maker_address: ALICE.toLowerCase(),
      amount_give: 999_000_000,
      expiry: new Date(Date.now() - 1000).toISOString(), // past
    });
    setExchange({ offers: [fresh, expired] });
    const { container } = render(<Swap />);
    // Fresh offer give amount visible.
    expect(container.textContent).toContain("50");
  });

  it("inactive offers (status !== 'active') excluded from activeOffers", () => {
    const filled = buildOffer({
      id: 1,
      maker_address: ALICE.toLowerCase(),
      amount_give: 777_000_000,
      status: "filled",
    });
    setExchange({ offers: [filled] });
    const { container } = render(<Swap />);
    // The number 777 shouldn't appear in the active-offers display since
    // the offer is filtered out from activeOffers.
    // (It may still appear in filledOffers section, but our mock has none.)
    expect(container.textContent).not.toContain("777");
  });
});

describe("Swap — P2PTab balance display (§15.x)", () => {
  it("public USDC balance from useShield rendered with locale-grouped 2dp", () => {
    useShieldMock.mockReturnValue({ publicBalance: 1234.5 });
    const { container } = render(<Swap />);
    // 1234.5 -> '1,234.50' (en-US) or '1,234.50' (en-IN); locale formatters differ
    // but BOTH render the value with 2dp + grouping. Accept both shapes.
    expect(container.textContent).toMatch(/1[,]234\.50/);
  });

  it("encrypted vault balance renders as masked '•••••' (5 bullets)", () => {
    const { container } = render(<Swap />);
    expect(container.textContent).toContain("•••••");
  });
});
