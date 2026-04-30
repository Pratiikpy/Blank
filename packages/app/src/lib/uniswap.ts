// Uniswap v3 single-pool routing — Quote + Swap on SwapRouter02.
//
// Scope: this lib handles ONE-HOP exact-input swaps via QuoterV2 and
// SwapRouter02. Multi-hop routing (e.g. WETH → USDT → USDC) requires the
// `@uniswap/smart-order-router` package which is heavy and Sepolia
// liquidity rarely justifies it. If Sepolia ever needs multi-hop, swap
// the helper out for SOR — the surrounding UI stays the same.
//
// Privacy note: callers using FHE-encrypted balances must unshield first.
// CCTP-style burn/mint inside Uniswap is impossible — the pool sees a
// plaintext amount during the swap window. We keep this file unaware of
// the FHE layer; the unshield/reshield wrapping happens in the consuming
// hook so the privacy boundary is explicit at the call site.
//
// Addresses verified 2026-04-26 against
// references/uniswap-docs/docs/contracts/v3/reference/deployments/.

import { type Address } from "viem";
import {
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  type SupportedChainId,
} from "./constants";

// ─── Deployments ─────────────────────────────────────────────────────

export const UNISWAP_QUOTER_V2: Record<SupportedChainId, Address> = {
  [ETH_SEPOLIA_ID]: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
  [BASE_SEPOLIA_ID]: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
};

export const UNISWAP_SWAP_ROUTER_02: Record<SupportedChainId, Address> = {
  [ETH_SEPOLIA_ID]: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  [BASE_SEPOLIA_ID]: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
};

/** Canonical wrapped-ETH on each chain — useful as a swap target/source. */
export const WETH9: Record<SupportedChainId, Address> = {
  // Sepolia WETH9: deployed by Uniswap, listed on the v3 deploy table.
  [ETH_SEPOLIA_ID]: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  [BASE_SEPOLIA_ID]: "0x4200000000000000000000000000000000000006",
};

// ─── KNOWN_TOKENS (Phase 5.2) ─────────────────────────────────────────
//
// Pickable tokens for the DEX UI. All addresses verified against:
//   • Uniswap v3 deployments doc (WETH9)
//   • Circle CCTP USDC docs (USDC.e — the canonical bridgeable USDC,
//     which is what has the real Uniswap pool depth on testnet)
//
// Why we use Circle's USDC.e and NOT our app's `TestUSDC`:
// TestUSDC is a permissionless-mint mock for the FHE flow. It has no
// Uniswap pool depth. Circle's USDC.e is the "real" testnet USDC that
// actually trades on Sepolia + Base Sepolia v3 pools. The DEX surface
// deals with plaintext token amounts, so the privacy boundary lives at
// the unshield/reshield hop in the consuming UI — not here.

export interface TokenInfo {
  /** Display symbol (USDC, WETH, USDT). */
  symbol: string;
  /** Friendly name shown in pickers ("USD Coin", "Wrapped Ether"). */
  name: string;
  /** Token contract address on this chain. */
  address: Address;
  /** ERC-20 decimals (must match the deployed contract — 6 for USDC, 18 for WETH). */
  decimals: number;
}

export const KNOWN_TOKENS: Record<SupportedChainId, TokenInfo[]> = {
  [ETH_SEPOLIA_ID]: [
    {
      symbol: "WETH",
      name: "Wrapped Ether",
      address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
      decimals: 18,
    },
    {
      symbol: "USDC",
      name: "USD Coin",
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      decimals: 6,
    },
  ],
  [BASE_SEPOLIA_ID]: [
    {
      symbol: "WETH",
      name: "Wrapped Ether",
      address: "0x4200000000000000000000000000000000000006",
      decimals: 18,
    },
    {
      symbol: "USDC",
      name: "USD Coin",
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
    },
  ],
};

/** Standard Uniswap v3 fee tiers, in hundredths of a bip. */
export const POOL_FEE = {
  /** 0.05% — best for stable-stable. */
  LOWEST: 500,
  /** 0.3% — default for most ERC20 ↔ WETH pools. */
  MEDIUM: 3000,
  /** 1% — exotic / volatile pairs. */
  HIGH: 10_000,
} as const;

export type PoolFee = (typeof POOL_FEE)[keyof typeof POOL_FEE];

// ─── ABIs ────────────────────────────────────────────────────────────
//
// We expose only the methods we call. QuoterV2 and SwapRouter02 are large
// surfaces; bundling their full ABIs would bloat the client. Reviewers
// can cross-check the function signatures against the v3-periphery and
// swap-router-contracts repos linked in the deployments doc.

export const QuoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    // QuoterV2's quote functions are non-view because they intentionally
    // revert mid-call to bubble the result; the SDK pattern is to call
    // them via eth_call (read-only RPC) which still returns the data.
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  // Phase 5.6 — `payInvoiceWithSwap` uses `exactOutputSingle` on-chain so
  // the contract can swap for an EXACT amount of USDC. To preview that
  // swap in the UI we need the matching read-only quoter — same shape but
  // amountOut is the input and amountIn is what we get back.
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const SwapRouter02Abi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// ─── Types ───────────────────────────────────────────────────────────

export interface QuoteRequest {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Pool fee tier — defaults to 0.3% which is the most common pair. */
  fee?: PoolFee;
}

export interface QuoteResult {
  amountOut: bigint;
  /** Sqrt price after the swap — useful for slippage UIs. */
  sqrtPriceX96After: bigint;
  /** Number of initialized ticks crossed — proxy for liquidity depth. */
  initializedTicksCrossed: number;
  /** Quoter's gas estimate for the matching exactInputSingle. */
  gasEstimate: bigint;
}

export interface SwapParams {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  fee: PoolFee;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  /** 0 disables the price-impact limit. Pass a real value for tight slippage. */
  sqrtPriceLimitX96?: bigint;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Tuple shape expected by `exactInputSingle`. Exposed so the consuming
 *  hook can hand it directly to `unifiedWriteAndWait`. */
export function buildExactInputSingleArgs(p: SwapParams): readonly [
  {
    tokenIn: Address;
    tokenOut: Address;
    fee: number;
    recipient: Address;
    amountIn: bigint;
    amountOutMinimum: bigint;
    sqrtPriceLimitX96: bigint;
  },
] {
  return [
    {
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      fee: p.fee,
      recipient: p.recipient,
      amountIn: p.amountIn,
      amountOutMinimum: p.amountOutMinimum,
      sqrtPriceLimitX96: p.sqrtPriceLimitX96 ?? 0n,
    },
  ] as const;
}

/** Apply a slippage tolerance (basis points) to a quoted amountOut.
 *  Example: applySlippage(1_000_000n, 50) → 995_000n at 0.5%. */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("slippageBps must be between 0 and 10000 (= 100%)");
  }
  // floor(amountOut * (10000 - slippageBps) / 10000)
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Default slippage = 0.5% (50 bps). On Sepolia, low pool depth can move
 * the price more than this — UIs should expose a slider for power users.
 */
export const DEFAULT_SLIPPAGE_BPS = 50;

// ─── TWAP oracle (Phase 5.5) ─────────────────────────────────────────
//
// Reads time-weighted average prices from Uniswap v3 pools via
// `pool.observe(secondsAgos)`. Two outputs:
//
//   • `twapPrice` — single TWAP over a window (used for token-agnostic
//     invoice settlement in 5.6 once that lands)
//   • `fetchTwapSeries` — N samples for the price chart on the DEX tab (5.8)
//
// CRITICAL caveat (testnet): every v3 pool starts with
// `observationCardinality = 1` — only the latest spot tick is stored, no
// history. To get a meaningful TWAP series the cardinality must be
// bumped via `pool.increaseObservationCardinalityNext(N)` once per pool
// we care about. Hardhat task `bump-pool-cardinality.ts` does this. If
// cardinality is too small for the requested window, observations
// "wrap" and return a tick from the wrong slot — `observe` reverts with
// `OLD` in that case. We surface that as a friendly "Pool needs more
// observation slots" message instead of leaking the raw revert.

import { type PublicClient } from "viem";
import { encodeAbiParameters, getCreate2Address, keccak256 } from "viem";

/** Uniswap v3 factory address per chain — verified against the v3-deployments
 *  doc 2026-04-26. Used by `computePoolAddress` for deterministic CREATE2. */
export const UNISWAP_V3_FACTORY: Record<SupportedChainId, Address> = {
  [ETH_SEPOLIA_ID]: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  [BASE_SEPOLIA_ID]: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
};

/** Universal across every v3 deployment (the pool contract bytecode hash).
 *  Combined with factory + sorted (token0,token1,fee) it produces the pool
 *  address via CREATE2 — no on-chain factory call needed. */
const POOL_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54" as const;

/** Minimal ABI for `observe` + `slot0` — the only methods we need for TWAP. */
export const UniswapV3PoolAbi = [
  {
    type: "function",
    name: "observe",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
  },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

/** Compute the Uniswap v3 pool address deterministically. Saves a factory
 *  RPC roundtrip and works even if the pool isn't initialized yet (caller
 *  can then call slot0 to confirm whether it exists). */
export function computePoolAddress(args: {
  chainId: SupportedChainId;
  tokenA: Address;
  tokenB: Address;
  fee: PoolFee;
}): Address {
  const factory = UNISWAP_V3_FACTORY[args.chainId];
  if (!factory) throw new Error(`No Uniswap v3 factory configured for chain ${args.chainId}`);
  // v3 sorts token0 < token1 by address (lowercase compare).
  const [token0, token1] =
    args.tokenA.toLowerCase() < args.tokenB.toLowerCase()
      ? [args.tokenA, args.tokenB]
      : [args.tokenB, args.tokenA];
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }],
      [token0, token1, args.fee],
    ),
  );
  return getCreate2Address({
    from: factory,
    salt,
    bytecodeHash: POOL_INIT_CODE_HASH,
  });
}

/** Convert an arithmetic-mean tick into a floating-point price in
 *  token1-per-token0 units, adjusted for ERC-20 decimals. Display only —
 *  never use the float for settlement math (use QuoterV2 for that). */
export function tickToPrice(args: {
  tick: number;
  decimals0: number;
  decimals1: number;
}): number {
  // price_t1_per_t0 = 1.0001^tick, then scale by 10^(decimals0 - decimals1)
  const raw = Math.pow(1.0001, args.tick);
  const decimalAdj = Math.pow(10, args.decimals0 - args.decimals1);
  return raw * decimalAdj;
}

/** Compute the arithmetic-mean tick the way Uniswap v3's `OracleLibrary.consult`
 *  does: floor toward −∞, NOT toward zero. For negative `tickDelta` that
 *  doesn't divide evenly, this is a one-tick correction (~0.01%).
 *
 *  Why we can't just `Number(tickDelta / BigInt(window))`: BigInt `/`
 *  rounds toward zero, matching Solidity's `/` operator. But OracleLibrary
 *  explicitly subtracts 1 when `tickDelta < 0 && tickDelta % window != 0`
 *  to get true floor division — see v3-periphery's
 *  `OracleLibrary.sol::consult`. The chart-display difference is invisible,
 *  but Phase 5.6 (token-agnostic invoice settlement) needs settlement-grade
 *  agreement with on-chain quoting. */
function arithmeticMeanTick(tickDelta: bigint, windowSeconds: number): number {
  const win = BigInt(windowSeconds);
  let mean = tickDelta / win;
  if (tickDelta < 0n && tickDelta % win !== 0n) mean -= 1n;
  return Number(mean);
}

/** Single TWAP over `windowSeconds`. Returns a float price, NOT a bigint. */
export async function twapPrice(args: {
  client: PublicClient;
  poolAddress: Address;
  windowSeconds: number;
  decimals0: number;
  decimals1: number;
}): Promise<number> {
  const result = (await args.client.readContract({
    address: args.poolAddress,
    abi: UniswapV3PoolAbi,
    functionName: "observe",
    args: [[args.windowSeconds, 0]],
  })) as readonly [readonly bigint[], readonly bigint[]];
  const [tickCumulatives] = result;
  // tickCumulatives are int56 — bigint subtract is safe. Use the OracleLibrary
  // floor-toward-minus-infinity rounding so this lib is settlement-grade.
  const tickDelta = tickCumulatives[1]! - tickCumulatives[0]!;
  const meanTick = arithmeticMeanTick(tickDelta, args.windowSeconds);
  return tickToPrice({ tick: meanTick, decimals0: args.decimals0, decimals1: args.decimals1 });
}

export interface TwapSample {
  /** Unix seconds at the END of this sample's interval (most recent). */
  time: number;
  /** Time-weighted price for this interval. */
  price: number;
  /** Mean tick — useful for variance/volatility overlays. */
  meanTick: number;
}

/** Fetch a TWAP series for charting. Builds N-sample windows ending now,
 *  spaced `granularitySeconds` apart, each averaged over `granularitySeconds`.
 *  One single `observe` call returns all N+1 cumulative ticks. */
export async function fetchTwapSeries(args: {
  client: PublicClient;
  poolAddress: Address;
  windowSeconds: number;
  granularitySeconds: number;
  decimals0: number;
  decimals1: number;
}): Promise<TwapSample[]> {
  if (args.granularitySeconds <= 0) throw new Error("granularitySeconds must be positive");
  if (args.windowSeconds <= args.granularitySeconds) {
    throw new Error("windowSeconds must be larger than granularitySeconds");
  }
  const sampleCount = Math.floor(args.windowSeconds / args.granularitySeconds);
  // secondsAgos descending (oldest first). N samples → N+1 boundaries.
  const secondsAgos: number[] = [];
  for (let i = sampleCount; i >= 0; i--) {
    secondsAgos.push(i * args.granularitySeconds);
  }
  const result = (await args.client.readContract({
    address: args.poolAddress,
    abi: UniswapV3PoolAbi,
    functionName: "observe",
    args: [secondsAgos],
  })) as readonly [readonly bigint[], readonly bigint[]];
  const [cumulatives] = result;
  const now = Math.floor(Date.now() / 1000);
  const samples: TwapSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const tickDelta = cumulatives[i + 1]! - cumulatives[i]!;
    const meanTick = arithmeticMeanTick(tickDelta, args.granularitySeconds);
    samples.push({
      // sample boundary's unix-seconds timestamp (recent end of interval)
      time: now - (sampleCount - i - 1) * args.granularitySeconds,
      price: tickToPrice({
        tick: meanTick,
        decimals0: args.decimals0,
        decimals1: args.decimals1,
      }),
      meanTick,
    });
  }
  return samples;
}
