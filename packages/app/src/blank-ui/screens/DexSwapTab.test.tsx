import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for DexSwapTab screen. Phase 5.4 plaintext Uniswap v3
// swap UI. CRITICAL pins:
//
//   - swapDisabled 7-gate AND formula: !address || !tokenIn ||
//     !tokenOut || same-token || amountInWei=0n || !lastQuote ||
//     step in {approving, swapping}. Removing ANY gate either
//     lets the user fire a guaranteed-revert swap (wasted gas)
//     or, worse, swap a token for itself.
//   - CRITICAL stale-quote prevention: on input change, source
//     calls reset() IMMEDIATELY before the 600ms debounced
//     re-quote. The "Min received" panel must NOT linger with
//     last quote's numbers while the user is mid-typing.
//   - friendly quote error: "execution reverted" / "VM
//     Exception" -> "No <pair> pool at <fee>% fee or
//     insufficient liquidity" copy. Without this users see a
//     raw EVM revert and assume the app is broken.
//   - flipPair: swaps tokenIn/tokenOut but PRESERVES amountIn in
//     the same DOM position (Uniswap convention).
//   - no-tokens state: tokens.length < 2 -> "DEX swap isn't
//     configured for this chain yet" (defensive against a fresh
//     chain id with no KNOWN_TOKENS entries).
//   - CRITICAL privacy reminder copy "DEX swaps run on plaintext
//     token amounts. If your balance is encrypted, unshield
//     first" pinned as load-bearing disclosure.
//   - minOutDisplay bigint math: amountOut * (10000 - slippageBps)
//     / 10000n; wrong divisor or wrong arithmetic ordering gives
//     either negative slippage or wildly wrong min-received.
//   - 4-state step button copy: idle / approving / swapping /
//     complete with the right icon swap per step.

const useUniswapSwapMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useUniswapSwap", () => ({ useUniswapSwap: useUniswapSwapMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/uniswap", () => ({
  KNOWN_TOKENS: {
    11155111: [
      { address: "0xweth", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
      { address: "0xusdc", symbol: "USDC", name: "USD Coin", decimals: 6 },
      { address: "0xdai", symbol: "DAI", name: "Dai Stablecoin", decimals: 18 },
    ],
    99: [
      { address: "0xonly", symbol: "ONLY", name: "Only One", decimals: 18 },
    ], // <2 tokens -> no-tokens state
  },
  POOL_FEE: { LOWEST: 500, MEDIUM: 3000, HIGH: 10_000 },
  DEFAULT_SLIPPAGE_BPS: 100,
}));
vi.mock("@/blank-ui/components", () => ({
  TwapChart: (props: { tokenIn: { symbol: string }; tokenOut: { symbol: string }; fee: number }) => (
    <div
      data-testid="twap-chart"
      data-pair={`${props.tokenIn.symbol}/${props.tokenOut.symbol}`}
      data-fee={String(props.fee)}
    />
  ),
}));

import DexSwapTab from "./DexSwapTab";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let quoteMock: ReturnType<typeof vi.fn>;
let swapMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;

function setSwap(overrides: Partial<{
  step: "idle" | "approving" | "swapping" | "complete" | "error";
  error: string | null;
  lastQuote: { amountOut: bigint; initializedTicksCrossed: number; gasEstimate: bigint } | null;
}> = {}) {
  useUniswapSwapMock.mockReturnValue({
    step: overrides.step ?? "idle",
    error: overrides.error ?? null,
    lastQuote: overrides.lastQuote ?? null,
    quote: quoteMock,
    swap: swapMock,
    reset: resetMock,
  });
}

beforeEach(() => {
  useUniswapSwapMock.mockReset();
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({ activeChainId: 11155111 });

  quoteMock = vi.fn().mockResolvedValue(undefined);
  swapMock = vi.fn().mockResolvedValue(undefined);
  resetMock = vi.fn();
  setSwap();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DexSwapTab — page chrome (§15.x)", () => {
  it("renders 'From' + 'To' sections with default WETH -> USDC pair", () => {
    const { container } = render(<DexSwapTab />);
    expect(container.textContent).toContain("From");
    expect(container.textContent).toContain("To");
    // Default tokenIn=WETH, tokenOut=USDC.
    const tokenInBtn = container.querySelector("[data-testid='dex-token-in']");
    const tokenOutBtn = container.querySelector("[data-testid='dex-token-out']");
    expect(tokenInBtn?.textContent).toContain("WETH");
    expect(tokenOutBtn?.textContent).toContain("USDC");
  });

  it("CRITICAL privacy reminder copy visible (load-bearing disclosure)", () => {
    const { container } = render(<DexSwapTab />);
    expect(container.textContent).toContain("DEX swaps run on plaintext token amounts");
    expect(container.textContent).toContain("unshield first");
    expect(container.textContent).toContain("publicly visible on-chain");
  });

  it("3 fee-tier buttons rendered (0.05% / 0.3% / 1%) with default MEDIUM (0.3%) aria-pressed", () => {
    const { container } = render(<DexSwapTab />);
    const fees = ["dex-fee-500", "dex-fee-3000", "dex-fee-10000"];
    for (const id of fees) {
      expect(container.querySelector(`[data-testid='${id}']`)).not.toBeNull();
    }
    const medium = container.querySelector("[data-testid='dex-fee-3000']") as HTMLButtonElement;
    expect(medium.getAttribute("aria-pressed")).toBe("true");
  });

  it("6 slippage buttons (0.10%/0.50%/1.00%/2.00%/3.00%/5.00%) with default 1.00% pressed", () => {
    const { container } = render(<DexSwapTab />);
    const slipBtns = [10, 50, 100, 200, 300, 500];
    for (const bps of slipBtns) {
      expect(container.querySelector(`[data-testid='dex-slippage-${bps}']`)).not.toBeNull();
    }
    const defaultBtn = container.querySelector("[data-testid='dex-slippage-100']") as HTMLButtonElement;
    expect(defaultBtn.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("DexSwapTab — no-tokens fallback (§15.x)", () => {
  it("chain with <2 KNOWN_TOKENS entries -> 'DEX swap isn't configured' card", () => {
    useChainMock.mockReturnValue({ activeChainId: 99 });
    const { container } = render(<DexSwapTab />);
    expect(container.textContent).toContain("DEX swap isn't configured for this chain yet");
    expect(container.textContent).not.toContain("From");
    expect(container.textContent).not.toContain("Swap");
  });

  it("chain not in KNOWN_TOKENS at all -> still 'DEX swap isn't configured' (defensive)", () => {
    useChainMock.mockReturnValue({ activeChainId: 12345 });
    const { container } = render(<DexSwapTab />);
    expect(container.textContent).toContain("DEX swap isn't configured for this chain yet");
  });
});

describe("DexSwapTab — amount input regex (§15.x)", () => {
  it("regex /^\\d*\\.?\\d*$/: accepts digits + dot only", () => {
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(input.value).toBe("1.5");
  });

  it("rejects letters (state stays at prior value)", () => {
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1.5" } });
    fireEvent.change(input, { target: { value: "1.5abc" } });
    expect(input.value).toBe("1.5"); // unchanged
  });

  it("accepts empty (so user can clear the field)", () => {
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
  });
});

describe("DexSwapTab — fee tier + slippage selection (§15.x)", () => {
  it("clicking 0.05% (LOWEST) fee tier flips aria-pressed", () => {
    const { container } = render(<DexSwapTab />);
    const lowestBtn = container.querySelector("[data-testid='dex-fee-500']") as HTMLButtonElement;
    fireEvent.click(lowestBtn);
    expect(lowestBtn.getAttribute("aria-pressed")).toBe("true");
    const medium = container.querySelector("[data-testid='dex-fee-3000']") as HTMLButtonElement;
    expect(medium.getAttribute("aria-pressed")).toBe("false");
  });

  it("slippage label tracks selection: clicking 5% (500bps) -> '5.00%' display", () => {
    const { container } = render(<DexSwapTab />);
    const slip500 = container.querySelector("[data-testid='dex-slippage-500']") as HTMLButtonElement;
    fireEvent.click(slip500);
    expect(slip500.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("5.00%");
  });

  it("slippage 10bps renders as '0.10%' (bps/100 with toFixed(2))", () => {
    const { container } = render(<DexSwapTab />);
    const slip10 = container.querySelector("[data-testid='dex-slippage-10']") as HTMLButtonElement;
    fireEvent.click(slip10);
    expect(container.textContent).toContain("0.10%");
  });
});

describe("DexSwapTab — swapDisabled 7-gate formula (§15.x)", () => {
  it("CRITICAL no effective address -> swap disabled", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container } = render(<DexSwapTab />);
    const btn = container.querySelector("[data-testid='dex-swap-button']") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("amountInWei = 0n (empty input) -> swap disabled", () => {
    const { container } = render(<DexSwapTab />);
    const btn = container.querySelector("[data-testid='dex-swap-button']") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("CRITICAL no lastQuote (quote pending or never fetched) -> swap disabled", () => {
    setSwap({ lastQuote: null });
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    const btn = container.querySelector("[data-testid='dex-swap-button']") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("CRITICAL step=approving -> swap disabled + 'Approving WETH…' label", () => {
    setSwap({
      step: "approving",
      lastQuote: { amountOut: 1000n, initializedTicksCrossed: 1, gasEstimate: 100_000n },
    });
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    const btn = container.querySelector("[data-testid='dex-swap-button']") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Approving WETH");
  });

  it("CRITICAL step=swapping -> swap disabled + 'Swapping…' label", () => {
    setSwap({
      step: "swapping",
      lastQuote: { amountOut: 1000n, initializedTicksCrossed: 1, gasEstimate: 100_000n },
    });
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    const btn = container.querySelector("[data-testid='dex-swap-button']") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Swapping");
  });

  it("step=complete + valid quote + amount + address -> swap ENABLED", () => {
    setSwap({
      step: "complete",
      lastQuote: { amountOut: 1000n, initializedTicksCrossed: 1, gasEstimate: 100_000n },
    });
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    const btn = container.querySelector("[data-testid='dex-swap-button']") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain("Swap complete!");
  });
});

describe("DexSwapTab — flipPair button (§15.x)", () => {
  it("clicking flip swaps tokenIn <-> tokenOut", () => {
    const { container, getByLabelText } = render(<DexSwapTab />);
    expect(container.querySelector("[data-testid='dex-token-in']")?.textContent).toContain("WETH");
    expect(container.querySelector("[data-testid='dex-token-out']")?.textContent).toContain("USDC");
    fireEvent.click(getByLabelText("Swap input and output tokens"));
    expect(container.querySelector("[data-testid='dex-token-in']")?.textContent).toContain("USDC");
    expect(container.querySelector("[data-testid='dex-token-out']")?.textContent).toContain("WETH");
  });

  it("CRITICAL flip preserves amountIn in the SAME DOM position (Uniswap convention)", () => {
    const { container, getByLabelText } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(input.value).toBe("1.5");
    fireEvent.click(getByLabelText("Swap input and output tokens"));
    // After flip, top-row input STILL holds "1.5" (now in new tokenIn position).
    const inputAfter = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    expect(inputAfter.value).toBe("1.5");
  });
});

describe("DexSwapTab — quote orchestration (§15.x)", () => {
  it("CRITICAL: input change immediately calls reset() (pre-debounce stale-quote clear)", () => {
    const { container } = render(<DexSwapTab />);
    resetMock.mockClear();
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    expect(resetMock).toHaveBeenCalled();
  });

  it("amount=0 (no actual input) -> reset() + NO quote call", async () => {
    vi.useFakeTimers();
    render(<DexSwapTab />);
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(quoteMock).not.toHaveBeenCalled();
  });

  it("CRITICAL: quote call DEBOUNCED 600ms after input settles", async () => {
    vi.useFakeTimers();
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    // Not yet -- 600ms debounce in effect.
    expect(quoteMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(599);
    });
    expect(quoteMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(quoteMock).toHaveBeenCalled();
  });

  it("quote call signature: chainId + tokenIn + tokenOut + amountIn (wei) + fee", async () => {
    vi.useFakeTimers();
    const { container } = render(<DexSwapTab />);
    fireEvent.change(
      container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement,
      { target: { value: "1" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    const arg = quoteMock.mock.calls[0][0];
    expect(arg.chainId).toBe(11155111);
    expect(arg.tokenIn).toBe("0xweth");
    expect(arg.tokenOut).toBe("0xusdc");
    expect(arg.amountIn).toBe(1_000_000_000_000_000_000n); // parseUnits("1", 18)
    expect(arg.fee).toBe(3000); // POOL_FEE.MEDIUM default
  });

  it("CRITICAL execution-reverted error -> friendly 'No pool at fee' message (not raw EVM error)", async () => {
    vi.useFakeTimers();
    quoteMock.mockRejectedValueOnce(new Error("execution reverted"));
    const { container } = render(<DexSwapTab />);
    fireEvent.change(
      container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement,
      { target: { value: "1" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(700);
      // Flush enough microtasks for the quote-reject promise chain to settle
      // and the setQuoteError state update to commit. waitFor() can't be used
      // here because vi.useFakeTimers() blocks its internal polling.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain("No WETH/USDC pool at 0.30% fee");
    expect(container.textContent).toContain("insufficient liquidity");
  });

  it("non-revert quote error -> first 200 chars of error message rendered", async () => {
    vi.useFakeTimers();
    quoteMock.mockRejectedValueOnce(new Error("Network timeout: chain unreachable from this node"));
    const { container } = render(<DexSwapTab />);
    fireEvent.change(
      container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement,
      { target: { value: "1" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(700);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain("Network timeout");
  });
});

describe("DexSwapTab — quote display + minOut math (§15.x)", () => {
  it("with lastQuote: renders 'Min received' panel + amountOut formatted to tokenOut decimals", () => {
    setSwap({
      lastQuote: {
        amountOut: 1_500_000n, // 1.5 USDC at 6dp
        initializedTicksCrossed: 2,
        gasEstimate: 150_000n,
      },
    });
    const { container } = render(<DexSwapTab />);
    expect(container.textContent).toContain("Min received");
    expect(container.querySelector("[data-testid='dex-amount-out']")?.textContent).toBe("1.5");
  });

  it("CRITICAL minOut math: amountOut * (10000 - slippageBps) / 10000n at 1% slippage", () => {
    setSwap({
      lastQuote: {
        amountOut: 1_000_000n, // 1.0 USDC
        initializedTicksCrossed: 1,
        gasEstimate: 100_000n,
      },
    });
    const { container } = render(<DexSwapTab />);
    // default slippage 100bps (1%) -> minOut = 1_000_000 * 9900 / 10000 = 990_000 = 0.99 USDC
    expect(container.textContent).toContain("0.99 USDC");
  });

  it("minOut math at 5% slippage: 1.0 -> 0.95 USDC", () => {
    setSwap({
      lastQuote: {
        amountOut: 1_000_000n,
        initializedTicksCrossed: 1,
        gasEstimate: 100_000n,
      },
    });
    const { container } = render(<DexSwapTab />);
    const slip500 = container.querySelector("[data-testid='dex-slippage-500']") as HTMLButtonElement;
    fireEvent.click(slip500);
    // 1_000_000 * 9500 / 10000 = 950_000 = 0.95 USDC
    expect(container.textContent).toContain("0.95 USDC");
  });

  it("renders initializedTicksCrossed + gas estimate from lastQuote", () => {
    setSwap({
      lastQuote: {
        amountOut: 1_000_000n,
        initializedTicksCrossed: 7,
        gasEstimate: 234_567n,
      },
    });
    const { container } = render(<DexSwapTab />);
    expect(container.textContent).toContain("Initialized ticks crossed");
    expect(container.textContent).toContain("7");
    expect(container.textContent).toContain("Quoter gas estimate");
    expect(container.textContent).toContain("234567");
  });
});

describe("DexSwapTab — handleSwap flow (§15.x)", () => {
  it("Swap click calls swap with tokenIn/tokenOut/amountIn/fee/slippageBps", async () => {
    setSwap({
      lastQuote: { amountOut: 1000n, initializedTicksCrossed: 1, gasEstimate: 100_000n },
    });
    const { container } = render(<DexSwapTab />);
    const input = container.querySelector("[data-testid='dex-amount-in']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    const btn = container.querySelector("[data-testid='dex-swap-button']") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(swapMock).toHaveBeenCalled();
    const arg = swapMock.mock.calls[0][0];
    expect(arg.tokenIn).toBe("0xweth");
    expect(arg.tokenOut).toBe("0xusdc");
    expect(arg.amountIn).toBe(1_000_000_000_000_000_000n);
    expect(arg.fee).toBe(3000);
    expect(arg.slippageBps).toBe(100); // default
  });

  it("step='error' + error string -> rose error card visible", () => {
    setSwap({ step: "error", error: "slippage exceeded" });
    const { container } = render(<DexSwapTab />);
    expect(container.textContent).toContain("slippage exceeded");
  });

  it("step='error' + no error string -> error card HIDDEN (no empty rose box)", () => {
    setSwap({ step: "error", error: null });
    const { container } = render(<DexSwapTab />);
    // The error box only renders when both step='error' AND error is truthy.
    expect(container.querySelector(".bg-rose-50")).toBeNull();
  });
});

describe("DexSwapTab — TwapChart conditional render (§15.x)", () => {
  it("chart visible when both tokens picked AND distinct", () => {
    const { container } = render(<DexSwapTab />);
    const chart = container.querySelector("[data-testid='twap-chart']");
    expect(chart).not.toBeNull();
    expect(chart?.getAttribute("data-pair")).toBe("WETH/USDC");
    expect(chart?.getAttribute("data-fee")).toBe("3000");
  });

  it("chart updates fee + pair when fee tier changes", () => {
    const { container } = render(<DexSwapTab />);
    fireEvent.click(container.querySelector("[data-testid='dex-fee-10000']") as HTMLButtonElement);
    expect(container.querySelector("[data-testid='twap-chart']")?.getAttribute("data-fee")).toBe("10000");
  });
});
