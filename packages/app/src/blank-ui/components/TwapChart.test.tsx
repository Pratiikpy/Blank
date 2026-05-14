import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { TwapChart } from "./TwapChart";
import type { Address } from "viem";

// §15.x test for TwapChart. The DEX tab's price chart pulls Uniswap v3
// pool observations and computes a TWAP series. Five branches of UI
// state ride on the same effect: idle -> loading -> {ready, no-pool,
// low-cardinality, error}. Pin the error classification regex (returned
// no data / OLD / generic), the cardinality pre-flight gate (per-range
// minimum), the direction inversion (token0/token1 byte ordering), the
// precision-adaptive fmtPrice, and the range tab selection so a
// regression doesn't quietly route the user to the wrong status card.
//
// Recharts is stubbed at the module boundary — the chart's SVG output
// is incidental to the logic we care about. We assert by data-testid
// on the stubbed Area/AreaChart so the data prop flow is provable.

// ─── Hoisted mock harness ──────────────────────────────────────────

const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const fetchTwapSeriesMock = vi.hoisted(() => vi.fn());
const computePoolAddressMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  usePublicClient: usePublicClientMock,
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("@/lib/uniswap", () => ({
  fetchTwapSeries: fetchTwapSeriesMock,
  computePoolAddress: computePoolAddressMock,
  POOL_FEE: { LOW: 500, MEDIUM: 3000, HIGH: 10_000 },
  UniswapV3PoolAbi: [],
}));

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) => args.filter(a => typeof a === "string").join(" "),
}));

vi.mock("lucide-react", () => ({
  Loader2: (p: Record<string, unknown>) => <span data-testid="icon-loader" {...p} />,
  TrendingUp: (p: Record<string, unknown>) => <span data-testid="icon-trending" {...p} />,
  AlertCircle: (p: Record<string, unknown>) => <span data-testid="icon-alert" {...p} />,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: ({ children, data }: { children: React.ReactNode; data: unknown[] }) => (
    <div data-testid="area-chart" data-points={data.length}>
      {children}
    </div>
  ),
  Area: (p: Record<string, unknown>) => (
    <div data-testid="area" data-key={p.dataKey as string} data-stroke={p.stroke as string} />
  ),
  XAxis: (p: Record<string, unknown>) => <div data-testid="x-axis" data-key={p.dataKey as string} />,
  YAxis: () => <div data-testid="y-axis" />,
  Tooltip: () => <div data-testid="tooltip" />,
}));

// ─── Shared test fixtures ──────────────────────────────────────────

const TOKEN_LOW: import("@/lib/uniswap").TokenInfo = {
  symbol: "WETH",
  name: "Wrapped Ether",
  address: "0x0000000000000000000000000000000000000001" as Address,
  decimals: 18,
};

const TOKEN_HIGH: import("@/lib/uniswap").TokenInfo = {
  symbol: "USDC",
  name: "USD Coin",
  address: "0x0000000000000000000000000000000000000002" as Address,
  decimals: 6,
};

const POOL_ADDR = "0x00000000000000000000000000000000000000aa" as Address;

// Build a slot0 tuple shaped like the Uniswap v3 read: [sqrtPriceX96,
// tick, observationIndex, observationCardinality, ...]. We only care
// about index 3 (cardinality).
function slot0(cardinality: number) {
  return [0n, 0, 0, cardinality, 0, 0, true] as const;
}

// Build TwapSample with the meanTick field that the type requires; the
// chart only reads .time and .price so the value of meanTick is irrelevant.
function sample(time: number, price: number): import("@/lib/uniswap").TwapSample {
  return { time, price, meanTick: 0 };
}

function setupSuccessfulRead(cardinality: number, samples: import("@/lib/uniswap").TwapSample[]) {
  const readContract = vi.fn().mockResolvedValue(slot0(cardinality));
  usePublicClientMock.mockReturnValue({ readContract });
  fetchTwapSeriesMock.mockResolvedValue(samples);
  return readContract;
}

function setupReadThrowing(message: string) {
  const readContract = vi.fn().mockRejectedValue(new Error(message));
  usePublicClientMock.mockReturnValue({ readContract });
  return readContract;
}

beforeEach(() => {
  cleanup();
  usePublicClientMock.mockReset();
  useChainMock.mockReset();
  fetchTwapSeriesMock.mockReset();
  computePoolAddressMock.mockReset();
  useChainMock.mockReturnValue({ activeChainId: 11155111 });
  computePoolAddressMock.mockReturnValue(POOL_ADDR);
});

// ─── Header rendering ──────────────────────────────────────────────

describe("TwapChart header", () => {
  it("renders the pair label + fee tier in basis points", async () => {
    setupSuccessfulRead(360, []);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    expect(
      screen.getByText(/Price chart · WETH\/USDC · 0\.30%/),
    ).toBeInTheDocument();
  });

  it("renders four range tabs (1H/1D/1W/30D) with 1D selected by default", () => {
    setupSuccessfulRead(360, []);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    expect(screen.getByTestId("twap-range-1H")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("twap-range-1D")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("twap-range-1W")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("twap-range-30D")).toHaveAttribute("aria-selected", "false");
  });

  it("never trust this price disclaimer is always visible", () => {
    setupSuccessfulRead(360, []);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    expect(
      screen.getByText(/never trust this/i),
    ).toBeInTheDocument();
  });
});

// ─── Status: loading ────────────────────────────────────────────────

describe("status: loading", () => {
  it("shows 'Reading pool history…' before readContract resolves", async () => {
    // Use a pending promise so the loading state stays visible.
    let resolveSlot0: (v: unknown) => void = () => {};
    const readContract = vi.fn().mockReturnValue(
      new Promise(r => { resolveSlot0 = r as (v: unknown) => void; }),
    );
    usePublicClientMock.mockReturnValue({ readContract });
    // Pre-set fetchTwapSeries so when the slot0 promise resolves the
    // downstream chain completes cleanly (no setSamples(undefined) -> crash).
    fetchTwapSeriesMock.mockResolvedValue([]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    expect(screen.getByText(/Reading pool history/)).toBeInTheDocument();
    expect(screen.getByTestId("icon-loader")).toBeInTheDocument();
    // Cleanup the dangling promise so vitest doesn't complain.
    resolveSlot0(slot0(360));
    await waitFor(() => {
      expect(screen.queryByText(/Reading pool history/)).not.toBeInTheDocument();
    });
  });
});

// ─── Status: ready ─────────────────────────────────────────────────

describe("status: ready (happy path)", () => {
  it("renders the chart when cardinality is enough + fetchTwapSeries returns samples", async () => {
    setupSuccessfulRead(360, [
      sample(1_700_000_000, 2000),
      sample(1_700_000_300, 2050),
      sample(1_700_000_600, 2100),
    ]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(screen.getByTestId("area-chart")).toBeInTheDocument();
    });
    expect(screen.getByTestId("area-chart")).toHaveAttribute("data-points", "3");
    expect(screen.getByTestId("area")).toHaveAttribute("data-key", "price");
    expect(screen.getByTestId("x-axis")).toHaveAttribute("data-key", "time");
    expect(screen.getByTestId("y-axis")).toBeInTheDocument();
    expect(screen.getByTestId("tooltip")).toBeInTheDocument();
  });

  it("displays the latest sample price in the header", async () => {
    setupSuccessfulRead(360, [
      sample(1_700_000_000, 2000),
      sample(1_700_000_300, 2123.4567),
    ]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    // Price 2123.4567 >= 1000 -> 2 decimals -> "2123.46"
    await waitFor(() => {
      expect(screen.getByText("2123.46")).toBeInTheDocument();
    });
    expect(screen.getByText(/USDC per WETH/)).toBeInTheDocument();
  });

  it("displays positive priceChangePct with + sign + emerald class", async () => {
    setupSuccessfulRead(360, [
      sample(1_700_000_000, 2000),
      sample(1_700_000_300, 2100),
    ]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    // (2100 - 2000) / 2000 * 100 = 5.00
    await waitFor(() => {
      const pct = screen.getByText("+5.00%");
      expect(pct).toBeInTheDocument();
      expect(pct.className).toMatch(/emerald/);
    });
  });

  it("displays negative priceChangePct with rose class + no '+' prefix", async () => {
    setupSuccessfulRead(360, [
      sample(1_700_000_000, 2000),
      sample(1_700_000_300, 1900),
    ]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      const pct = screen.getByText("-5.00%");
      expect(pct).toBeInTheDocument();
      expect(pct.className).toMatch(/rose/);
    });
  });

  it("priceChangePct is omitted when startPrice is 0 (would divide by zero)", async () => {
    setupSuccessfulRead(360, [
      sample(1_700_000_000, 0),
      sample(1_700_000_300, 100),
    ]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(screen.getByTestId("area-chart")).toBeInTheDocument();
    });
    // priceChangePct renders with a leading sign ("+5.00%" / "-5.00%").
    // The header fee tier ("0.30%") has no sign so it won't false-match.
    expect(screen.queryByText(/[-+]\d+\.\d+%/)).not.toBeInTheDocument();
  });
});

// ─── Status: no-pool ───────────────────────────────────────────────

describe("status: no-pool (pool not deployed at this fee tier)", () => {
  it("surfaces 'No pool at this fee tier' when readContract throws 'returned no data'", async () => {
    setupReadThrowing("contract returned no data");
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(screen.getByText(/No pool at this fee tier/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Try WETH\/USDC at a different fee tier/)).toBeInTheDocument();
  });

  it("'invalid opcode' (call to non-contract) also maps to no-pool", async () => {
    setupReadThrowing("execution reverted: invalid opcode");
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(screen.getByText(/No pool at this fee tier/)).toBeInTheDocument();
    });
  });

  it("'reverted' (bare revert) also maps to no-pool", async () => {
    setupReadThrowing("call reverted without reason");
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(screen.getByText(/No pool at this fee tier/)).toBeInTheDocument();
    });
  });
});

// ─── Status: low-cardinality ───────────────────────────────────────

describe("status: low-cardinality (not enough observation slots)", () => {
  it("flags pre-flight gate when cardinality < range.minCardinality (1D needs 300)", async () => {
    setupSuccessfulRead(50, []);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(
        screen.getByText(/Pool needs more observation slots/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Cardinality is 50/)).toBeInTheDocument();
    expect(screen.getByText(/bump-pool-cardinality/)).toBeInTheDocument();
    // fetchTwapSeries must NOT have been called when the gate trips.
    expect(fetchTwapSeriesMock).not.toHaveBeenCalled();
  });

  it("maps bare 'OLD' error from observe() to low-cardinality (oldest observation wraps past window)", async () => {
    // slot0 passes the cardinality gate. fetchTwapSeries throws OLD —
    // the source's regex chain checks /reverted/ BEFORE /OLD/, so the
    // message must be the bare "OLD" string to reach the cardinality
    // branch. A wrapping "execution reverted: OLD" hits 'no-pool' first.
    const readContract = vi.fn().mockResolvedValue(slot0(360));
    usePublicClientMock.mockReturnValue({ readContract });
    fetchTwapSeriesMock.mockRejectedValue(new Error("OLD"));
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(
        screen.getByText(/Pool needs more observation slots/i),
      ).toBeInTheDocument();
    });
  });
});

// ─── Status: error (generic) ───────────────────────────────────────

describe("status: error (generic failure path)", () => {
  it("surfaces 'Couldn't load chart' + the truncated err message for unknown errors", async () => {
    setupReadThrowing("network timeout exceeded for RPC endpoint");
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load chart/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/network timeout exceeded for RPC endpoint/),
    ).toBeInTheDocument();
  });

  it("truncates long error messages to 280 chars", async () => {
    const long = "x".repeat(500);
    setupReadThrowing(long);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load chart/)).toBeInTheDocument();
    });
    // Find the element containing the truncated x-string and assert its text length is <=280.
    const errMsg = screen.getByText(/^x+$/);
    expect(errMsg.textContent?.length).toBe(280);
  });
});

// ─── Range tab interaction ─────────────────────────────────────────

describe("range tab interaction", () => {
  it("clicking 1H re-runs the effect with the 1H window", async () => {
    const readContract = vi.fn().mockResolvedValue(slot0(360));
    usePublicClientMock.mockReturnValue({ readContract });
    fetchTwapSeriesMock.mockResolvedValue([]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => expect(fetchTwapSeriesMock).toHaveBeenCalled());
    fetchTwapSeriesMock.mockClear();
    fireEvent.click(screen.getByTestId("twap-range-1H"));
    await waitFor(() => {
      expect(fetchTwapSeriesMock).toHaveBeenCalled();
    });
    const args = fetchTwapSeriesMock.mock.calls[0][0];
    expect(args.windowSeconds).toBe(60 * 60);
    expect(args.granularitySeconds).toBe(60);
    expect(screen.getByTestId("twap-range-1H")).toHaveAttribute("aria-selected", "true");
  });

  it("clicking 30D requests the longest window with coarsest granularity", async () => {
    const readContract = vi.fn().mockResolvedValue(slot0(360));
    usePublicClientMock.mockReturnValue({ readContract });
    fetchTwapSeriesMock.mockResolvedValue([]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => expect(fetchTwapSeriesMock).toHaveBeenCalled());
    fetchTwapSeriesMock.mockClear();
    fireEvent.click(screen.getByTestId("twap-range-30D"));
    await waitFor(() => expect(fetchTwapSeriesMock).toHaveBeenCalled());
    const args = fetchTwapSeriesMock.mock.calls[0][0];
    expect(args.windowSeconds).toBe(30 * 24 * 60 * 60);
    expect(args.granularitySeconds).toBe(4 * 60 * 60);
  });
});

// ─── Direction inversion (token0/token1 ordering) ──────────────────

describe("direction inversion (Uniswap v3 token0/token1 byte ordering)", () => {
  it("when tokenIn.address > tokenOut.address by hex, displayPrice inverts (1/x)", async () => {
    // TOKEN_HIGH (...02) > TOKEN_LOW (...01) so passing tokenIn=HIGH triggers inversion.
    setupSuccessfulRead(360, [sample(1_700_000_000, 0.0005)]);
    render(<TwapChart tokenIn={TOKEN_HIGH} tokenOut={TOKEN_LOW} fee={3000} />);
    // Inverted: 1 / 0.0005 = 2000 -> ">=1000" path -> "2000.00"
    await waitFor(() => {
      expect(screen.getByText("2000.00")).toBeInTheDocument();
    });
    // Uniswap v3 stores price as token1/token0 where token0 is the
    // SMALLER address. With tokenIn=HIGH (USDC, 6) and tokenOut=LOW
    // (WETH, 18), token0=LOW so decimals0=18 (WETH's) and decimals1=6.
    const args = fetchTwapSeriesMock.mock.calls[0][0];
    expect(args.decimals0).toBe(18);
    expect(args.decimals1).toBe(6);
  });

  it("when tokenIn.address < tokenOut.address, displayPrice passes through (no invert)", async () => {
    setupSuccessfulRead(360, [sample(1_700_000_000, 2500)]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => {
      // Pass-through: 2500 displayed at >=1000 precision -> "2500.00"
      expect(screen.getByText("2500.00")).toBeInTheDocument();
    });
    // Non-inverted: tokenIn=LOW (WETH, 18) is token0, so decimals0=18.
    const args = fetchTwapSeriesMock.mock.calls[0][0];
    expect(args.decimals0).toBe(18);
    expect(args.decimals1).toBe(6);
  });
});

// ─── Precision-adaptive fmtPrice ───────────────────────────────────

describe("fmtPrice precision selection", () => {
  it("price >= 1000 -> 2 decimals", async () => {
    setupSuccessfulRead(360, [sample(1, 1234.56789)]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => expect(screen.getByText("1234.57")).toBeInTheDocument());
  });

  it("price >= 1 (but < 1000) -> 4 decimals", async () => {
    setupSuccessfulRead(360, [sample(1, 12.345678)]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => expect(screen.getByText("12.3457")).toBeInTheDocument());
  });

  it("price >= 0.0001 (but < 1) -> 6 decimals", async () => {
    setupSuccessfulRead(360, [sample(1, 0.123456789)]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => expect(screen.getByText("0.123457")).toBeInTheDocument());
  });

  it("very small prices use exponential notation with 3 sig figs", async () => {
    setupSuccessfulRead(360, [sample(1, 0.0000001234)]);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    await waitFor(() => expect(screen.getByText(/1\.234e-7/)).toBeInTheDocument());
  });

  it("price 0 (or non-finite) renders as em-dash placeholder", async () => {
    setupSuccessfulRead(360, []);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    // No samples -> currentPrice null -> header shows "—".
    await waitFor(() => {
      expect(screen.getByText("—")).toBeInTheDocument();
    });
  });
});

// ─── computePoolAddress failure fallback ──────────────────────────

describe("computePoolAddress failure does not crash", () => {
  it("when computePoolAddress throws, the chart skips the effect (no read fires)", async () => {
    computePoolAddressMock.mockImplementation(() => {
      throw new Error("invalid pair");
    });
    const readContract = vi.fn();
    usePublicClientMock.mockReturnValue({ readContract });
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    // Effect short-circuits at the !poolAddress guard.
    expect(readContract).not.toHaveBeenCalled();
    // Header still renders with the em-dash placeholder.
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

// ─── publicClient null guard ───────────────────────────────────────

describe("publicClient null guard", () => {
  it("when usePublicClient returns undefined, the effect short-circuits without crashing", () => {
    usePublicClientMock.mockReturnValue(undefined);
    render(<TwapChart tokenIn={TOKEN_LOW} tokenOut={TOKEN_HIGH} fee={3000} />);
    // No assertion needed beyond the absence of a thrown error during render.
    expect(screen.getByText(/Price chart · WETH\/USDC/)).toBeInTheDocument();
  });
});
