// Phase 5.8 — Live price chart for the DEX tab. Pulls Uniswap v3 pool
// observations and computes a TWAP series via `fetchTwapSeries`. Renders
// with recharts (SVG; no canvas dependency).
//
// CRITICAL testnet caveat — every v3 pool starts with `observationCardinality
// = 1`. Without bumping cardinality, `pool.observe([T, 0])` for any T > 0
// reverts with `OLD`. We catch that case and surface a friendly "Pool needs
// more observation slots" state, with a one-click hint pointing at the
// `bump-pool-cardinality` hardhat task. On mainnet this is a non-issue —
// active pools have plenty of cardinality already.
//
// The chart is informational only — never trust its prices for settlement.
// Settlement always goes through QuoterV2 (`useUniswapSwap.quote`) which
// reads the actual current pool state with proper slippage protection.

import { useEffect, useMemo, useState } from "react";
import { Loader2, TrendingUp, AlertCircle } from "lucide-react";
import { usePublicClient } from "wagmi";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Address } from "viem";
import { useChain } from "@/providers/ChainProvider";
import {
  computePoolAddress,
  fetchTwapSeries,
  POOL_FEE,
  type PoolFee,
  type TokenInfo,
  type TwapSample,
  UniswapV3PoolAbi,
} from "@/lib/uniswap";
import { cn } from "@/lib/cn";

type RangeKey = "1H" | "1D" | "1W" | "30D";

interface RangeDef {
  key: RangeKey;
  label: string;
  /** Total window covered by the chart, in seconds. */
  windowSeconds: number;
  /** Granularity of each sample, in seconds. */
  granularitySeconds: number;
  /** Min `observationCardinality` (storage slots) for the pool. Note:
   *  cardinality = number of slots, NOT minutes-of-history. Each slot
   *  holds one observation per FIRST swap of a block, so a quiet pool
   *  with 300 slots may span weeks; a busy pool may span only an hour.
   *  We use it as a coarse pre-flight filter — the real failure case
   *  ("OLD" revert from observe()) is still caught downstream. */
  minCardinality: number;
}

const RANGES: RangeDef[] = [
  { key: "1H", label: "1H", windowSeconds: 60 * 60, granularitySeconds: 60, minCardinality: 64 },
  { key: "1D", label: "1D", windowSeconds: 24 * 60 * 60, granularitySeconds: 5 * 60, minCardinality: 300 },
  { key: "1W", label: "1W", windowSeconds: 7 * 24 * 60 * 60, granularitySeconds: 30 * 60, minCardinality: 360 },
  { key: "30D", label: "30D", windowSeconds: 30 * 24 * 60 * 60, granularitySeconds: 4 * 60 * 60, minCardinality: 200 },
];

interface TwapChartProps {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  fee: PoolFee;
}

export function TwapChart({ tokenIn, tokenOut, fee }: TwapChartProps) {
  const { activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });

  const [range, setRange] = useState<RangeKey>("1D");
  const [samples, setSamples] = useState<TwapSample[]>([]);
  const [status, setStatus] = useState<
    "idle" | "loading" | "ready" | "no-pool" | "low-cardinality" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [poolCardinality, setPoolCardinality] = useState<number | null>(null);

  const poolAddress = useMemo<Address | null>(() => {
    try {
      return computePoolAddress({
        chainId: activeChainId,
        tokenA: tokenIn.address,
        tokenB: tokenOut.address,
        fee,
      });
    } catch {
      return null;
    }
  }, [activeChainId, tokenIn.address, tokenOut.address, fee]);

  // Direction: v3 pools store price as token1/token0 where token0 < token1
  // by address. To display "1 tokenIn = X tokenOut" we may need to invert.
  const inverted = useMemo(
    () => tokenIn.address.toLowerCase() > tokenOut.address.toLowerCase(),
    [tokenIn.address, tokenOut.address],
  );
  const decimals0 = inverted ? tokenOut.decimals : tokenIn.decimals;
  const decimals1 = inverted ? tokenIn.decimals : tokenOut.decimals;

  // Display price in tokenOut-per-tokenIn (what the swap UI shows).
  const displayPrice = (twapPriceT1PerT0: number): number =>
    inverted ? 1 / twapPriceT1PerT0 : twapPriceT1PerT0;

  useEffect(() => {
    if (!publicClient || !poolAddress) return;
    const def = RANGES.find((r) => r.key === range)!;
    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);

    (async () => {
      try {
        // Pre-flight slot0 — confirms the pool exists AND surfaces its
        // observation cardinality. If the pool address has no code, this
        // throws with "returned no data" and we surface "no pool".
        const slot0 = (await publicClient.readContract({
          address: poolAddress,
          abi: UniswapV3PoolAbi,
          functionName: "slot0",
        })) as readonly [bigint, number, number, number, number, number, boolean];
        if (cancelled) return;
        const cardinality = Number(slot0[3]);
        setPoolCardinality(cardinality);
        if (cardinality < def.minCardinality) {
          setStatus("low-cardinality");
          return;
        }

        const series = await fetchTwapSeries({
          client: publicClient,
          poolAddress,
          windowSeconds: def.windowSeconds,
          granularitySeconds: def.granularitySeconds,
          decimals0,
          decimals1,
        });
        if (cancelled) return;
        setSamples(series);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // viem's "returned no data" error means the address has no
        // contract deployed — i.e. no pool exists at this fee tier.
        if (/returned no data|invalid opcode|reverted/i.test(msg)) {
          setStatus("no-pool");
        } else if (/OLD/.test(msg)) {
          // Pool's oldest observation is more recent than the requested
          // window — cardinality wraps. Flag it so the user can pick a
          // shorter range or wait for more history to accumulate.
          setStatus("low-cardinality");
        } else {
          setStatus("error");
          setErrorMessage(msg.slice(0, 280));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, poolAddress, range, decimals0, decimals1]);

  const chartData = useMemo(
    () =>
      samples.map((s) => ({
        time: s.time * 1000, // ms for recharts default scaling
        price: displayPrice(s.price),
      })),
    [samples, inverted],
  );

  const currentPrice = chartData[chartData.length - 1]?.price ?? null;
  const startPrice = chartData[0]?.price ?? null;
  const priceChangePct =
    currentPrice !== null && startPrice !== null && startPrice !== 0
      ? ((currentPrice - startPrice) / startPrice) * 100
      : null;

  const fmtPrice = (p: number): string => {
    // Auto-pick precision: very small prices need more decimals.
    if (p === 0 || !Number.isFinite(p)) return "—";
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    if (p >= 0.0001) return p.toFixed(6);
    return p.toExponential(3);
  };

  const fmtTime = (ms: number): string => {
    const d = new Date(ms);
    if (range === "1H") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (range === "1D") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  return (
    <div className="rounded-[2rem] glass-card-static p-5 space-y-4">
      {/* Header row: pair + price + range buttons */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-0.5">
            Price chart · {tokenIn.symbol}/{tokenOut.symbol} · {(fee / 10_000).toFixed(2)}%
          </p>
          <div className="flex items-baseline gap-2">
            <span
              className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]"
              style={{ fontFamily: "'JetBrains Mono', 'SF Mono', monospace" }}
            >
              {currentPrice !== null ? fmtPrice(currentPrice) : "—"}
            </span>
            <span className="text-sm text-[var(--text-secondary)]">
              {tokenOut.symbol} per {tokenIn.symbol}
            </span>
            {priceChangePct !== null && Number.isFinite(priceChangePct) && (
              <span
                className={cn(
                  "text-sm font-medium tabular-nums",
                  priceChangePct >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {priceChangePct >= 0 ? "+" : ""}
                {priceChangePct.toFixed(2)}%
              </span>
            )}
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Chart range"
          className="inline-flex p-1 rounded-xl bg-black/5 dark:bg-white/5"
        >
          {RANGES.map((r) => (
            <button
              key={r.key}
              role="tab"
              aria-selected={range === r.key}
              data-testid={`twap-range-${r.key}`}
              onClick={() => setRange(r.key)}
              className={cn(
                "h-8 px-3 rounded-lg text-xs font-medium transition-all",
                range === r.key
                  ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart body — branches by status */}
      <div className="h-48 -mx-2">
        {status === "loading" && (
          <div className="h-full flex items-center justify-center gap-2 text-[var(--text-tertiary)]">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm">Reading pool history…</span>
          </div>
        )}

        {status === "no-pool" && (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-1">
            <AlertCircle size={20} className="text-amber-500" />
            <p className="text-sm font-medium text-[var(--text-primary)]">
              No pool at this fee tier
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">
              Try {tokenIn.symbol}/{tokenOut.symbol} at a different fee tier.
            </p>
          </div>
        )}

        {status === "low-cardinality" && (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-1">
            <TrendingUp size={20} className="text-indigo-500" />
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Pool needs more observation slots for this range
            </p>
            <p className="text-xs text-[var(--text-tertiary)] max-w-sm">
              Cardinality is {poolCardinality ?? "?"}. Run{" "}
              <code className="font-mono bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">
                pnpm hardhat bump-pool-cardinality --pool {(poolAddress ?? "").slice(0, 10)}…
              </code>{" "}
              once, then revisit. Or pick a shorter range.
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-1">
            <AlertCircle size={20} className="text-rose-500" />
            <p className="text-sm font-medium text-[var(--text-primary)]">Couldn't load chart</p>
            <p className="text-xs text-[var(--text-tertiary)] break-words max-w-sm">
              {errorMessage ?? "Unknown error"}
            </p>
          </div>
        )}

        {status === "ready" && chartData.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <defs>
                <linearGradient id="twap-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366F1" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#6366F1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={fmtTime}
                fontSize={10}
                stroke="rgba(127,127,127,0.4)"
                tick={{ fill: "rgba(127,127,127,0.7)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={["auto", "auto"]}
                tickFormatter={fmtPrice}
                width={60}
                fontSize={10}
                stroke="rgba(127,127,127,0.4)"
                tick={{ fill: "rgba(127,127,127,0.7)" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(value) => {
                  const ms = typeof value === "number" ? value : Number(value);
                  if (!Number.isFinite(ms)) return "";
                  return new Date(ms).toLocaleString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                  });
                }}
                formatter={(value) => {
                  const n = typeof value === "number" ? value : Number(value);
                  return [fmtPrice(n), `${tokenOut.symbol}/${tokenIn.symbol}`];
                }}
                contentStyle={{
                  background: "rgba(20, 20, 24, 0.92)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 12,
                  color: "white",
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="price"
                stroke="#6366F1"
                strokeWidth={2}
                fill="url(#twap-fill)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <p className="text-[10px] text-[var(--text-tertiary)] leading-snug">
        TWAP from Uniswap v3 pool observations. Display only. Never trust this
        price for settlement. The Swap button uses QuoterV2 with the current
        pool state and slippage protection.
      </p>
    </div>
  );
}

// Sentinel re-export so consumers don't have to import POOL_FEE separately
// when they only want a chart.
export { POOL_FEE };
