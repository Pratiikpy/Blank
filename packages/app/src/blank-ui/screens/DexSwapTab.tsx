// Phase 5.4 — DexSwap UI on top of `useUniswapSwap` (already shipped in
// Phase 4.2). Pure plaintext token swap via Uniswap v3 SwapRouter02 — no
// FHE involvement. Privacy hop (unshield → swap → reshield) is the user's
// responsibility; we surface the boundary explicitly in the help banner.
//
// Surface:
//   • Token-in / token-out picker from `KNOWN_TOKENS` (per-chain).
//   • Amount entry in the input token's units (decimals-aware).
//   • Fee tier picker (0.05% / 0.3% / 1%) — testnet pool depth is sparse
//     so we expose this; mainnet UIs auto-pick the deepest tier, but on
//     testnet a deeper tier may simply have no liquidity at all.
//   • Slippage slider (0.1 / 0.5 / 1 / 2 / 3 / 5%) with running label.
//   • Quote panel (auto-refreshes on input change, with a small debounce).
//   • Execute button — gates on quote + connected wallet + non-self-out
//     pair (you can't swap a token for itself).
//
// Status feedback maps directly off `useUniswapSwap.step` so users see
// approving / swapping / complete inline instead of a series of toasts.
//
// Testnet caveat: Sepolia + Base Sepolia v3 pools are thin. Quotes may
// fail with "execution reverted" if a pool doesn't exist for the chosen
// fee tier. We surface that as a friendly "no pool at this fee" message
// instead of bubbling the EVM error.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownUp,
  ChevronDown,
  Loader2,
  Info,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useUniswapSwap } from "@/hooks/useUniswapSwap";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import {
  KNOWN_TOKENS,
  POOL_FEE,
  type PoolFee,
  type TokenInfo,
  DEFAULT_SLIPPAGE_BPS,
} from "@/lib/uniswap";
import { cn } from "@/lib/cn";
import { TwapChart } from "@/blank-ui/components";

const FEE_OPTIONS: Array<{ label: string; value: PoolFee }> = [
  { label: "0.05%", value: POOL_FEE.LOWEST },
  { label: "0.3%", value: POOL_FEE.MEDIUM },
  { label: "1%", value: POOL_FEE.HIGH },
];

const SLIPPAGE_OPTIONS = [10, 50, 100, 200, 300, 500] as const;

/** ms to wait after typing settles before re-quoting. */
const QUOTE_DEBOUNCE_MS = 600;

interface TokenPickerProps {
  selected: TokenInfo | null;
  options: TokenInfo[];
  exclude?: Address;
  onPick: (token: TokenInfo) => void;
  testId: string;
  ariaLabel: string;
}

function TokenPicker({ selected, options, exclude, onPick, testId, ariaLabel }: TokenPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const filtered = options.filter((t) => t.address.toLowerCase() !== exclude?.toLowerCase());

  // Close on outside click + Escape — without this, tapping the amount
  // input below leaves the menu open over it, especially noticeable on
  // mobile where it covers the input until the user re-taps the trigger.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-expanded={open}
        className="h-12 px-4 rounded-2xl bg-white dark:bg-white/10 border border-black/10 dark:border-white/15 hover:bg-white/90 dark:hover:bg-white/15 transition-all flex items-center gap-2"
      >
        {selected ? (
          <>
            <span className="font-semibold">{selected.symbol}</span>
            <span className="text-xs text-[var(--text-secondary)]">{selected.name}</span>
          </>
        ) : (
          <span className="text-[var(--text-tertiary)]">Pick a token</span>
        )}
        <ChevronDown size={16} className={cn("text-[var(--text-secondary)] transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute z-20 top-full mt-2 left-0 min-w-[240px] rounded-2xl bg-white dark:bg-[#1a1a1c] border border-black/10 dark:border-white/15 shadow-xl py-2"
        >
          {filtered.length === 0 ? (
            <p className="px-4 py-3 text-sm text-[var(--text-tertiary)]">
              No other tokens configured for this chain
            </p>
          ) : (
            filtered.map((t) => (
              <button
                key={t.address}
                role="option"
                aria-selected={selected?.address === t.address}
                onClick={() => {
                  onPick(t);
                  setOpen(false);
                }}
                className="w-full px-4 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-between gap-3"
              >
                <span>
                  <span className="font-semibold">{t.symbol}</span>
                  <span className="ml-2 text-xs text-[var(--text-secondary)]">{t.name}</span>
                </span>
                <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
                  {t.address.slice(0, 6)}…{t.address.slice(-4)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function DexSwapTab() {
  const { activeChainId } = useChain();
  const { effectiveAddress } = useEffectiveAddress();
  const { step, error, lastQuote, quote, swap, reset } = useUniswapSwap();

  const tokens = KNOWN_TOKENS[activeChainId] ?? [];
  // Default pair: WETH → USDC (most testnet pools use WETH as one leg).
  const defaultIn = tokens.find((t) => t.symbol === "WETH") ?? tokens[0] ?? null;
  const defaultOut = tokens.find((t) => t.symbol === "USDC") ?? tokens[1] ?? null;

  const [tokenIn, setTokenIn] = useState<TokenInfo | null>(defaultIn);
  const [tokenOut, setTokenOut] = useState<TokenInfo | null>(defaultOut);
  const [amountIn, setAmountIn] = useState("");
  const [feeTier, setFeeTier] = useState<PoolFee>(POOL_FEE.MEDIUM);
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);

  // ── Quote orchestration ───────────────────────────────────────────────
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);

  const amountInWei = useMemo(() => {
    if (!tokenIn || !amountIn || amountIn === "" || amountIn === ".") return 0n;
    try {
      return parseUnits(amountIn, tokenIn.decimals);
    } catch {
      return 0n;
    }
  }, [amountIn, tokenIn]);

  const swapDisabled =
    !effectiveAddress ||
    !tokenIn ||
    !tokenOut ||
    tokenIn.address === tokenOut.address ||
    amountInWei === 0n ||
    !lastQuote ||
    step === "approving" ||
    step === "swapping";

  // Debounced quote on inputs change. Resets `lastQuote` immediately so
  // stale numbers never appear next to fresh inputs (the user would tap
  // Swap thinking they're getting the displayed price).
  useEffect(() => {
    if (!tokenIn || !tokenOut || tokenIn.address === tokenOut.address || amountInWei === 0n) {
      reset();
      setQuoteError(null);
      return;
    }
    // Clear stale quote up-front — the debounced re-quote takes 600ms, and
    // during that gap a stale "Min received" panel above the Swap button
    // would lie to the user about what they're about to execute.
    reset();
    setQuoteError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          setIsQuoting(true);
          await quote({
            chainId: activeChainId,
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            amountIn: amountInWei,
            fee: feeTier,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Uniswap reverts when no pool exists at the requested fee tier
          // — surface a humane message instead of leaking the raw revert.
          if (/execution reverted|VM Exception/.test(msg)) {
            setQuoteError(`No ${tokenIn.symbol}/${tokenOut.symbol} pool at ${(feeTier / 10_000).toFixed(2)}% fee, or insufficient liquidity.`);
          } else {
            setQuoteError(msg.slice(0, 200));
          }
        } finally {
          setIsQuoting(false);
        }
      })();
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // We deliberately exclude `quote` and `reset` (stable callbacks) — re-running
    // on identity changes would cancel in-flight quotes mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenIn?.address, tokenOut?.address, amountInWei.toString(), feeTier, activeChainId]);

  // Flip the pair — common UX shortcut.
  const flipPair = useCallback(() => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    // amountIn stays in the SAME position (now the new tokenIn). Wallets
    // do this differently; we follow the Uniswap pattern of keeping the
    // top-row value because the user just "flipped" their intent.
  }, [tokenIn, tokenOut]);

  const handleSwap = useCallback(async () => {
    if (!tokenIn || !tokenOut) return;
    try {
      await swap({
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountInWei,
        fee: feeTier,
        slippageBps,
      });
    } catch {
      // useUniswapSwap stores the error on `error`; we surface it inline.
    }
  }, [tokenIn, tokenOut, amountInWei, feeTier, slippageBps, swap]);

  const amountOutDisplay = useMemo(() => {
    if (!lastQuote || !tokenOut) return "";
    return formatUnits(lastQuote.amountOut, tokenOut.decimals);
  }, [lastQuote, tokenOut]);

  const minOutDisplay = useMemo(() => {
    if (!lastQuote || !tokenOut) return "";
    const minOut = (lastQuote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    return formatUnits(minOut, tokenOut.decimals);
  }, [lastQuote, tokenOut, slippageBps]);

  // ── No-tokens state (chain has no entries in KNOWN_TOKENS) ────────────
  if (tokens.length < 2) {
    return (
      <div className="rounded-[2rem] glass-card-static p-8 text-center">
        <p className="text-[var(--text-secondary)]">
          DEX swap isn't configured for this chain yet. Try switching to Ethereum
          Sepolia or Base Sepolia.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* From token */}
      <div className="rounded-[2rem] glass-card-static p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            From
          </span>
          <TokenPicker
            selected={tokenIn}
            options={tokens}
            exclude={tokenOut?.address}
            onPick={setTokenIn}
            testId="dex-token-in"
            ariaLabel="Select input token"
          />
        </div>
        <div className="relative">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            data-testid="dex-amount-in"
            aria-label={`Amount of ${tokenIn?.symbol ?? "input token"}`}
            value={amountIn}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d*\.?\d*$/.test(v)) setAmountIn(v);
            }}
            className="h-16 w-full px-2 bg-transparent border-0 outline-none text-4xl font-semibold tabular-nums text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            style={{ fontFamily: "'JetBrains Mono', 'SF Mono', monospace" }}
          />
        </div>
      </div>

      {/* Flip button */}
      <div className="flex justify-center -my-3 relative z-10">
        <button
          onClick={flipPair}
          aria-label="Swap input and output tokens"
          className="w-10 h-10 rounded-full bg-white dark:bg-[#1a1a1c] border-2 border-black/5 dark:border-white/10 flex items-center justify-center hover:rotate-180 transition-transform shadow-sm"
        >
          <ArrowDownUp size={16} className="text-[var(--text-secondary)]" />
        </button>
      </div>

      {/* To token */}
      <div className="rounded-[2rem] glass-card-static p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            To
          </span>
          <TokenPicker
            selected={tokenOut}
            options={tokens}
            exclude={tokenIn?.address}
            onPick={setTokenOut}
            testId="dex-token-out"
            ariaLabel="Select output token"
          />
        </div>
        <div className="h-16 flex items-center px-2">
          {isQuoting ? (
            <Loader2 size={20} className="text-[var(--text-tertiary)] animate-spin" />
          ) : amountOutDisplay ? (
            <span
              data-testid="dex-amount-out"
              className="text-4xl font-semibold tabular-nums text-[var(--text-primary)]"
              style={{ fontFamily: "'JetBrains Mono', 'SF Mono', monospace" }}
            >
              {amountOutDisplay}
            </span>
          ) : (
            <span className="text-4xl font-semibold text-[var(--text-muted)]">0.0</span>
          )}
        </div>
      </div>

      {/* Fee tier + slippage */}
      <div className="rounded-[2rem] glass-card-static p-5 space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-2">
            Pool fee tier
          </p>
          <div className="flex gap-2">
            {FEE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFeeTier(opt.value)}
                data-testid={`dex-fee-${opt.value}`}
                aria-pressed={feeTier === opt.value}
                className={cn(
                  "flex-1 h-10 rounded-xl text-sm font-medium transition-all",
                  feeTier === opt.value
                    ? "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A]"
                    : "bg-black/5 dark:bg-white/5 text-[var(--text-secondary)] hover:bg-black/10 dark:hover:bg-white/10",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
              Slippage tolerance
            </p>
            <span className="text-sm font-mono tabular-nums text-[var(--text-primary)]">
              {(slippageBps / 100).toFixed(2)}%
            </span>
          </div>
          <div className="flex gap-2 flex-wrap">
            {SLIPPAGE_OPTIONS.map((bps) => (
              <button
                key={bps}
                onClick={() => setSlippageBps(bps)}
                data-testid={`dex-slippage-${bps}`}
                aria-pressed={slippageBps === bps}
                className={cn(
                  "h-9 px-3 rounded-lg text-xs font-medium transition-all",
                  slippageBps === bps
                    ? "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A]"
                    : "bg-black/5 dark:bg-white/5 text-[var(--text-secondary)] hover:bg-black/10 dark:hover:bg-white/10",
                )}
              >
                {(bps / 100).toFixed(2)}%
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Quote details */}
      {lastQuote && tokenIn && tokenOut && (
        <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 p-4 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-[var(--text-secondary)]">Min received</span>
            <span className="font-mono tabular-nums">
              {minOutDisplay} {tokenOut.symbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-secondary)]">Initialized ticks crossed</span>
            <span className="font-mono tabular-nums">
              {lastQuote.initializedTicksCrossed}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-secondary)]">Quoter gas estimate</span>
            <span className="font-mono tabular-nums">
              {lastQuote.gasEstimate.toString()}
            </span>
          </div>
        </div>
      )}

      {/* Quote error */}
      {quoteError && (
        <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 p-4 flex gap-3">
          <AlertCircle size={20} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-900 dark:text-amber-300 leading-snug">{quoteError}</p>
        </div>
      )}

      {/* Privacy reminder — plaintext token amounts visible to the DEX. */}
      <div className="rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 p-4 flex gap-3">
        <Info size={18} className="text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
        <p className="text-sm text-indigo-900 dark:text-indigo-300 leading-snug">
          DEX swaps run on plaintext token amounts. If your balance is encrypted,
          unshield first — the swap window is publicly visible on-chain.
        </p>
      </div>

      {/* Swap button */}
      <button
        onClick={handleSwap}
        disabled={swapDisabled}
        data-testid="dex-swap-button"
        className={cn(
          "w-full h-14 rounded-2xl font-medium transition-all active:scale-[0.99] flex items-center justify-center gap-2",
          swapDisabled
            ? "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed"
            : "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] hover:bg-black dark:hover:bg-gray-100",
        )}
      >
        {step === "approving" ? (
          <>
            <Loader2 size={18} className="animate-spin" />
            <span>Approving {tokenIn?.symbol}…</span>
          </>
        ) : step === "swapping" ? (
          <>
            <Loader2 size={18} className="animate-spin" />
            <span>Swapping…</span>
          </>
        ) : step === "complete" ? (
          <>
            <CheckCircle2 size={18} />
            <span>Swap complete!</span>
          </>
        ) : (
          <>
            <ArrowDown size={18} />
            <span>
              {tokenIn && tokenOut
                ? `Swap ${tokenIn.symbol} for ${tokenOut.symbol}`
                : "Pick tokens to swap"}
            </span>
          </>
        )}
      </button>

      {/* Hook-level error surface */}
      {error && step === "error" && (
        <div className="rounded-2xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 p-4 flex gap-3">
          <AlertCircle size={20} className="text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
          <p className="text-sm text-rose-900 dark:text-rose-300 leading-snug break-words">
            {error}
          </p>
        </div>
      )}

      {/* Phase 5.8 — TWAP price chart for the picked pair. Renders only
          when both tokens are picked AND distinct. The chart self-handles
          no-pool / low-cardinality / error states inline so it never
          breaks the swap form above. */}
      {tokenIn && tokenOut && tokenIn.address !== tokenOut.address && (
        <TwapChart tokenIn={tokenIn} tokenOut={tokenOut} fee={feeTier} />
      )}
    </div>
  );
}
