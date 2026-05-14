import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for CreateListing screen. PRODUCER side of the
// /shop/:chainId/:listingId URL contract that StorefrontPage
// (consumer) parses. StorefrontPage.test.tsx pinned the consumer
// shape (3-mode discriminated UI, 8-branch refund prompt, etc);
// this test pins that CreateListing emits the URL the way the
// consumer expects (FOURTH producer/consumer handshake after
// Receive ↔ SendAmount and CreateCampaign ↔ CrowdfundPage).
//
// CRITICAL pins:
//   - validation cascade across 5 branches: empty title, >200 char
//     title, no price (FixedPrice OR Auction), empty delivery
//     channel. PWYW SKIPS price validation entirely. Mode-specific
//     error copy ("Set a minimum bid (or 0 for any)" for Auction;
//     "Set a price above zero" for FixedPrice).
//   - PWYW mode HIDES the price field (the source uses a
//     conditional render, not just a disabled state).
//   - Auction-only field: auction-window duration picker (1d/3d/7d)
//     with default 3d (AUCTION_DURATIONS[1]).
//   - handleCreate dispatch: priceTokens defaults to "0" when empty
//     (defensive); auctionSeconds=0 for non-Auction modes.
//   - description hash: empty -> zero bytes32 sentinel; non-empty
//     -> keccak256(stringToBytes(trimmed)) (mirrors CreateCampaign).
//   - share URL shape `${origin}/shop/<chainId>/<listingId>`
//     matches StorefrontPage's `/shop/:chainId/:listingId` route.
//   - lastListingId=null falls through to FORM (no broken URL).

const useChainMock = vi.hoisted(() => vi.fn());
const useStorefrontMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useStorefront", () => ({
  useStorefront: useStorefrontMock,
  SALE_MODE: { FixedPrice: 0, Auction: 1, PayWhatYouWant: 2 },
}));
vi.mock("@/components/payment/FhePipelineProgress", () => ({
  FhePipelineProgress: (props: { state: { phase: string } }) => (
    <div data-testid="fhe-pipeline-progress" data-phase={props.state.phase} />
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock },
}));

import CreateListing from "./CreateListing";

const VAULT_USDC = "0xfffffffffffffffffffffffffffffffffffffff1";

let createListingMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;
let writeTextMock: ReturnType<typeof vi.fn>;

function setHook(overrides: Partial<{
  step: "idle" | "encrypting" | "sending" | "success" | "error";
  isProcessing: boolean;
  error: string | null;
  lastListingId: number | null;
  pipelinePhase: string;
}> = {}) {
  useStorefrontMock.mockReturnValue({
    state: {
      step: overrides.step ?? "idle",
      isProcessing: overrides.isProcessing ?? false,
      error: overrides.error ?? null,
      lastListingId: overrides.lastListingId ?? null,
    },
    pipeline: { phase: overrides.pipelinePhase ?? "idle" },
    createListing: createListingMock,
    reset: resetMock,
  });
}

beforeEach(() => {
  useChainMock.mockReset();
  useStorefrontMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();

  useChainMock.mockReturnValue({
    contracts: { FHERC20Vault_USDC: VAULT_USDC },
    activeChainId: 11155111,
  });

  createListingMock = vi.fn().mockResolvedValue(undefined);
  resetMock = vi.fn();
  setHook();

  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// Test helper — fills the form with valid values for the given mode.
function fillValid(
  getByPlaceholderText: (t: string) => HTMLElement,
  mode: "fixed" | "auction" | "pwyw" = "fixed",
  opts: { title?: string; description?: string; price?: string; delivery?: string } = {},
) {
  fireEvent.change(getByPlaceholderText("Hand-bound notebook (signed)"), {
    target: { value: opts.title ?? "Test product" },
  });
  fireEvent.change(getByPlaceholderText("DM @yourhandle on telegram / email me / ships in 3 days"), {
    target: { value: opts.delivery ?? "ship to your address" },
  });
  if (mode === "fixed") {
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: opts.price ?? "25" } });
  } else if (mode === "auction") {
    fireEvent.change(getByPlaceholderText("0"), { target: { value: opts.price ?? "1" } });
  }
  if (opts.description) {
    fireEvent.change(
      getByPlaceholderText("What's in the box. What's the experience. Why someone wants it."),
      { target: { value: opts.description } },
    );
  }
}

describe("CreateListing — page chrome (§15.x)", () => {
  it("renders 'Sell something' heading + 3-clause privacy framing", () => {
    const { container } = render(<CreateListing />);
    expect(container.textContent).toContain("Sell something");
    expect(container.textContent).toContain("Encrypted price");
    expect(container.textContent).toContain("Encrypted bids");
    expect(container.textContent).toContain("Private revenue");
  });

  it("renders 3 mode pills: Fixed price / Auction / Pay what", () => {
    const { container } = render(<CreateListing />);
    expect(container.textContent).toContain("Fixed price");
    expect(container.textContent).toContain("Auction");
    expect(container.textContent).toContain("Pay what");
  });

  it("default mode = FixedPrice (Fixed price pill aria-pressed=true)", () => {
    const { container } = render(<CreateListing />);
    const fixedPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Fixed price") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    expect(fixedPill.getAttribute("aria-pressed")).toBe("true");
  });

  it("submit button reads 'Create listing' at rest", () => {
    const { getByText } = render(<CreateListing />);
    expect(getByText("Create listing")).toBeDefined();
  });
});

describe("CreateListing — mode-pill switching (§15.x)", () => {
  it("clicking Auction pill flips aria-pressed", () => {
    const { container } = render(<CreateListing />);
    const auctionPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Auction") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(auctionPill);
    expect(auctionPill.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking Auction reveals minimum-bid label + auction-window duration picker", () => {
    const { container } = render(<CreateListing />);
    const auctionPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Auction") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(auctionPill);
    expect(container.textContent).toContain("Minimum bid (USDC, 0 = any)");
    expect(container.textContent).toContain("Auction window");
    expect(container.textContent).toContain("1 day");
    expect(container.textContent).toContain("3 days");
    expect(container.textContent).toContain("7 days");
  });

  it("CRITICAL clicking PWYW HIDES the price field entirely (not just disables)", () => {
    const { container, queryByPlaceholderText } = render(<CreateListing />);
    const pwywPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Pay what") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(pwywPill);
    expect(queryByPlaceholderText("10.00")).toBeNull();
    expect(queryByPlaceholderText("0")).toBeNull();
    expect(container.textContent).not.toContain("Price (USDC)");
    expect(container.textContent).not.toContain("Minimum bid");
  });

  it("Auction default duration = 3 days (AUCTION_DURATIONS[1])", () => {
    const { container, getByText } = render(<CreateListing />);
    const auctionPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Auction") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(auctionPill);
    expect(getByText("3 days").getAttribute("aria-pressed")).toBe("true");
    expect(getByText("1 day").getAttribute("aria-pressed")).toBe("false");
    expect(getByText("7 days").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking '1 day' in Auction mode switches active preset", () => {
    const { container, getByText } = render(<CreateListing />);
    const auctionPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Auction") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(auctionPill);
    fireEvent.click(getByText("1 day"));
    expect(getByText("1 day").getAttribute("aria-pressed")).toBe("true");
    expect(getByText("3 days").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("CreateListing — validation cascade (§15.x)", () => {
  it("empty title -> 'Give your listing a title' + Create disabled", () => {
    const { container, getByText } = render(<CreateListing />);
    expect(container.textContent).toContain("Give your listing a title");
    expect((getByText("Create listing").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("title > 200 chars -> 'Title is too long (max 200 chars)'", () => {
    const { container, getByPlaceholderText } = render(<CreateListing />);
    fireEvent.change(getByPlaceholderText("Hand-bound notebook (signed)"), {
      target: { value: "a".repeat(201) },
    });
    expect(container.textContent).toContain("Title is too long");
  });

  it("FixedPrice + valid title + no price -> 'Set a price above zero'", () => {
    const { container, getByPlaceholderText } = render(<CreateListing />);
    fireEvent.change(getByPlaceholderText("Hand-bound notebook (signed)"), { target: { value: "Test" } });
    expect(container.textContent).toContain("Set a price above zero");
  });

  it("Auction + valid title + no price -> mode-specific 'Set a minimum bid (or 0 for any)'", () => {
    const { container } = render(<CreateListing />);
    const auctionPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Auction") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(auctionPill);
    const titleInput = container.querySelector("input[placeholder='Hand-bound notebook (signed)']") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Print run" } });
    expect(container.textContent).toContain("Set a minimum bid (or 0 for any)");
  });

  it("CRITICAL PWYW + valid title + NO price -> price validation SKIPPED (delivery is next error)", () => {
    const { container } = render(<CreateListing />);
    const pwywPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Pay what") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(pwywPill);
    const titleInput = container.querySelector("input[placeholder='Hand-bound notebook (signed)']") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Tip jar" } });
    // No "Set a price" error; next cascade rung is delivery channel.
    expect(container.textContent).not.toContain("Set a price");
    expect(container.textContent).not.toContain("Set a minimum bid");
    expect(container.textContent).toContain("Tell buyers how you'll deliver");
  });

  it("FixedPrice valid title + valid price + empty delivery -> 'Tell buyers how you'll deliver'", () => {
    const { container, getByPlaceholderText } = render(<CreateListing />);
    fireEvent.change(getByPlaceholderText("Hand-bound notebook (signed)"), { target: { value: "Test" } });
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    expect(container.textContent).toContain("Tell buyers how you'll deliver");
  });

  it("All fields filled valid -> validation cleared + Create enabled", () => {
    const { container, getByPlaceholderText, getByText } = render(<CreateListing />);
    fillValid(getByPlaceholderText, "fixed");
    expect(container.textContent).not.toContain("Give your listing a title");
    expect(container.textContent).not.toContain("Set a price above zero");
    expect(container.textContent).not.toContain("Tell buyers how you'll deliver");
    const btn = getByText("Create listing").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

describe("CreateListing — price input sanitizer (§15.x)", () => {
  it("strips non-numeric (eighth independent enforcement of precision-input contract)", () => {
    const { getByPlaceholderText } = render(<CreateListing />);
    const input = getByPlaceholderText("10.00") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc12.34$" } });
    expect(input.value).toBe("12.34");
  });

  it("Auction-mode price input ALSO sanitizes (same handler)", () => {
    const { container, getByPlaceholderText } = render(<CreateListing />);
    const auctionPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Auction") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(auctionPill);
    const input = getByPlaceholderText("0") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x5.50" } });
    expect(input.value).toBe("5.50");
  });
});

describe("CreateListing — handleCreate dispatch (§15.x)", () => {
  it("FixedPrice valid form -> createListing with mode=0 + priceTokens + decimals=6 + auctionSeconds=0", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateListing />);
    fillValid(getByPlaceholderText, "fixed", { price: "100.50", title: "  Notebook  " });
    await act(async () => {
      fireEvent.click(getByText("Create listing"));
      await Promise.resolve();
    });
    expect(createListingMock).toHaveBeenCalled();
    const arg = createListingMock.mock.calls[0][0];
    expect(arg.mode).toBe(0); // FixedPrice
    expect(arg.vault).toBe(VAULT_USDC);
    expect(arg.priceTokens).toBe("100.50");
    expect(arg.decimals).toBe(6);
    expect(arg.auctionSeconds).toBe(0);
    expect(arg.title).toBe("Notebook"); // trimmed
  });

  it("Auction valid form -> createListing with mode=1 + auctionSeconds=3d (default)", async () => {
    const { container, getByPlaceholderText, getByText } = render(<CreateListing />);
    const auctionPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Auction") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(auctionPill);
    fillValid(getByPlaceholderText, "auction", { price: "1" });
    await act(async () => {
      fireEvent.click(getByText("Create listing"));
      await Promise.resolve();
    });
    const arg = createListingMock.mock.calls[0][0];
    expect(arg.mode).toBe(1); // Auction
    expect(arg.auctionSeconds).toBe(3 * 86_400); // default 3d
  });

  it("Auction with '7 days' selected -> auctionSeconds=7d", async () => {
    const { container, getByPlaceholderText, getByText } = render(<CreateListing />);
    const auctionPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Auction") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(auctionPill);
    fireEvent.click(getByText("7 days"));
    fillValid(getByPlaceholderText, "auction", { price: "1" });
    await act(async () => {
      fireEvent.click(getByText("Create listing"));
      await Promise.resolve();
    });
    expect(createListingMock.mock.calls[0][0].auctionSeconds).toBe(7 * 86_400);
  });

  it("CRITICAL PWYW with empty price -> createListing with priceTokens defaulted to '0' (defensive)", async () => {
    const { container, getByPlaceholderText, getByText } = render(<CreateListing />);
    const pwywPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Pay what") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(pwywPill);
    fillValid(getByPlaceholderText, "pwyw");
    await act(async () => {
      fireEvent.click(getByText("Create listing"));
      await Promise.resolve();
    });
    const arg = createListingMock.mock.calls[0][0];
    expect(arg.mode).toBe(2); // PWYW
    expect(arg.priceTokens).toBe("0");
    expect(arg.auctionSeconds).toBe(0);
  });

  it("CRITICAL empty description -> descriptionCidHash = zero bytes32 (contract sentinel)", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateListing />);
    fillValid(getByPlaceholderText, "fixed");
    await act(async () => {
      fireEvent.click(getByText("Create listing"));
      await Promise.resolve();
    });
    expect(createListingMock.mock.calls[0][0].descriptionCidHash).toBe("0x" + "00".repeat(32));
  });

  it("non-empty description -> keccak256 hash (non-zero 32-byte hex)", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateListing />);
    fillValid(getByPlaceholderText, "fixed", { description: "signed print run" });
    await act(async () => {
      fireEvent.click(getByText("Create listing"));
      await Promise.resolve();
    });
    const hash = createListingMock.mock.calls[0][0].descriptionCidHash;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(hash).not.toBe("0x" + "00".repeat(32));
  });

  it("deliveryChannel is TRIMMED before submit", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateListing />);
    fillValid(getByPlaceholderText, "fixed", { delivery: "  DM @alice  " });
    await act(async () => {
      fireEvent.click(getByText("Create listing"));
      await Promise.resolve();
    });
    expect(createListingMock.mock.calls[0][0].deliveryChannel).toBe("DM @alice");
  });

  it("isProcessing -> 'Creating…' label + button disabled", () => {
    setHook({ isProcessing: true });
    const { getByText } = render(<CreateListing />);
    const btn = getByText("Creating…").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("CreateListing — pipeline + error (§15.x)", () => {
  it("pipeline.phase !== 'idle' renders FhePipelineProgress", async () => {
    setHook({ pipelinePhase: "encrypting" });
    const { findByTestId } = render(<CreateListing />);
    const pipe = await findByTestId("fhe-pipeline-progress");
    expect(pipe.getAttribute("data-phase")).toBe("encrypting");
  });

  it("state.error renders inline (not silent)", () => {
    setHook({ error: "Vault not approved" });
    const { container } = render(<CreateListing />);
    expect(container.textContent).toContain("Vault not approved");
  });
});

describe("CreateListing — success state + share URL (PRODUCER side of StorefrontPage contract) (§15.x)", () => {
  beforeEach(() => {
    setHook({ step: "success", lastListingId: 17 });
  });

  it("CRITICAL share URL shape: ${origin}/shop/<chainId>/<listingId> matches StorefrontPage route", () => {
    const { container } = render(<CreateListing />);
    expect(container.textContent).toMatch(/\/shop\/11155111\/17/);
  });

  it("renders 'Listing live' headline + 'buyers don't need a wallet to view' copy", () => {
    const { container } = render(<CreateListing />);
    expect(container.textContent).toContain("Listing live");
    expect(container.textContent).toContain("Buyers don");
    expect(container.textContent).toContain("create one when they pay");
  });

  it("Copy link click writes share URL + 'Link copied' toast", async () => {
    const { getByText } = render(<CreateListing />);
    await act(async () => {
      fireEvent.click(getByText("Copy link"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalled();
    expect(writeTextMock.mock.calls[0][0]).toMatch(/\/shop\/11155111\/17$/);
    expect(toastSuccessMock).toHaveBeenCalledWith("Link copied");
  });

  it("'Create another listing' click calls reset", () => {
    const { getByText } = render(<CreateListing />);
    fireEvent.click(getByText("Create another listing"));
    expect(resetMock).toHaveBeenCalled();
  });

  it("CRITICAL lastListingId=null falls through to FORM (no broken /shop//null URL)", () => {
    setHook({ step: "success", lastListingId: null });
    const { container } = render(<CreateListing />);
    expect(container.textContent).not.toContain("Listing live");
    expect(container.textContent).toContain("Sell something");
  });

  it("share URL uses activeChainId from useChain (chain-aware)", () => {
    useChainMock.mockReturnValue({
      contracts: { FHERC20Vault_USDC: VAULT_USDC },
      activeChainId: 84532,
    });
    setHook({ step: "success", lastListingId: 9 });
    const { container } = render(<CreateListing />);
    expect(container.textContent).toMatch(/\/shop\/84532\/9/);
  });
});
