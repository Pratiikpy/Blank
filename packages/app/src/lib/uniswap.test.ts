import { describe, it, expect, vi } from "vitest";
import {
  applySlippage,
  arithmeticMeanTick,
  buildExactInputSingleArgs,
  computePoolAddress,
  fetchTwapSeries,
  tickToPrice,
  twapPrice,
  POOL_FEE,
  UNISWAP_V3_FACTORY,
} from "./uniswap";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";
import type { Address, PublicClient } from "viem";

// §15.x lib test for the Uniswap v3 helpers. The math + arg-shape
// helpers feed Phase 5.6 token-agnostic invoice settlement and the
// DEX swap path; off-by-one in slippage or a misordered tuple in
// the swap args lands user funds in the wrong place.

const TOKEN_A = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN_B = "0x2222222222222222222222222222222222222222" as Address;
const RECIPIENT = "0x3333333333333333333333333333333333333333" as Address;

describe("applySlippage", () => {
  it("0 bps preserves the full amount", () => {
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
  });

  it("50 bps (0.5%) of 1_000_000 → 995_000", () => {
    expect(applySlippage(1_000_000n, 50)).toBe(995_000n);
  });

  it("100 bps (1%) of 1_000_000 → 990_000", () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n);
  });

  it("10000 bps (100%) drops to 0", () => {
    expect(applySlippage(1_000_000n, 10_000)).toBe(0n);
  });

  it("rejects negative bps", () => {
    expect(() => applySlippage(1n, -1)).toThrow(/0 and 10000/);
  });

  it("rejects > 10000 bps", () => {
    expect(() => applySlippage(1n, 10_001)).toThrow(/0 and 10000/);
  });

  it("floor-divides on uneven amounts (matches Solidity / operator)", () => {
    // 7n * 9500 / 10000 = 66500 / 10000 = 6.65 → floors to 6
    expect(applySlippage(7n, 500)).toBe(6n);
  });
});

describe("buildExactInputSingleArgs", () => {
  it("returns a tuple-of-1 (the contract takes one struct arg)", () => {
    const out = buildExactInputSingleArgs({
      chainId: ETH_SEPOLIA_ID,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
      recipient: RECIPIENT,
      amountIn: 1_000_000n,
      amountOutMinimum: 990_000n,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
      recipient: RECIPIENT,
      amountIn: 1_000_000n,
      amountOutMinimum: 990_000n,
      sqrtPriceLimitX96: 0n,
    });
  });

  it("defaults sqrtPriceLimitX96 to 0n when omitted", () => {
    const out = buildExactInputSingleArgs({
      chainId: ETH_SEPOLIA_ID,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      fee: POOL_FEE.LOWEST,
      recipient: RECIPIENT,
      amountIn: 1n,
      amountOutMinimum: 0n,
    });
    expect(out[0].sqrtPriceLimitX96).toBe(0n);
  });

  it("preserves an explicit sqrtPriceLimitX96", () => {
    const out = buildExactInputSingleArgs({
      chainId: ETH_SEPOLIA_ID,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      fee: POOL_FEE.HIGH,
      recipient: RECIPIENT,
      amountIn: 1n,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 12345n,
    });
    expect(out[0].sqrtPriceLimitX96).toBe(12345n);
  });
});

describe("computePoolAddress", () => {
  it("returns the same address regardless of token order (token0 < token1 sort)", () => {
    const ab = computePoolAddress({
      chainId: ETH_SEPOLIA_ID,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
    });
    const ba = computePoolAddress({
      chainId: ETH_SEPOLIA_ID,
      tokenA: TOKEN_B,
      tokenB: TOKEN_A,
      fee: POOL_FEE.MEDIUM,
    });
    expect(ab).toBe(ba);
  });

  it("returns a deterministic address for the same inputs", () => {
    const a = computePoolAddress({
      chainId: ETH_SEPOLIA_ID,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
    });
    const b = computePoolAddress({
      chainId: ETH_SEPOLIA_ID,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
    });
    expect(a).toBe(b);
  });

  it("different fee tiers produce different pool addresses", () => {
    const lo = computePoolAddress({
      chainId: ETH_SEPOLIA_ID,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      fee: POOL_FEE.LOWEST,
    });
    const md = computePoolAddress({
      chainId: ETH_SEPOLIA_ID,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
    });
    expect(lo).not.toBe(md);
  });

  it("returns a properly-formed address (0x + 40 hex)", () => {
    const addr = computePoolAddress({
      chainId: ETH_SEPOLIA_ID,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
    });
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("throws on chains with no factory configured", () => {
    expect(() =>
      computePoolAddress({
        chainId: 999_999 as 11155111,
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        fee: POOL_FEE.MEDIUM,
      }),
    ).toThrow(/No Uniswap v3 factory/);
  });

  it("supports both Eth Sepolia and Base Sepolia chain ids", () => {
    expect(UNISWAP_V3_FACTORY[ETH_SEPOLIA_ID]).toBeDefined();
    expect(UNISWAP_V3_FACTORY[BASE_SEPOLIA_ID]).toBeDefined();
    // Different factories per chain ⇒ pool addresses differ even for
    // the same token pair.
    const ethPool = computePoolAddress({
      chainId: ETH_SEPOLIA_ID,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
    });
    const basePool = computePoolAddress({
      chainId: BASE_SEPOLIA_ID,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      fee: POOL_FEE.MEDIUM,
    });
    expect(ethPool).not.toBe(basePool);
  });
});

describe("tickToPrice", () => {
  it("tick=0 returns 1.0 when both tokens have equal decimals", () => {
    expect(tickToPrice({ tick: 0, decimals0: 6, decimals1: 6 })).toBe(1);
  });

  it("scales by 10^(decimals0 - decimals1) for unequal decimals", () => {
    // token0 has 18 decimals, token1 has 6 → factor 10^12
    const out = tickToPrice({ tick: 0, decimals0: 18, decimals1: 6 });
    expect(out).toBe(1e12);
  });

  it("positive tick yields > 1 price (1.0001^tick)", () => {
    expect(tickToPrice({ tick: 100, decimals0: 6, decimals1: 6 })).toBeGreaterThan(1);
  });

  it("negative tick yields < 1 price", () => {
    expect(tickToPrice({ tick: -100, decimals0: 6, decimals1: 6 })).toBeLessThan(1);
  });
});

// §15.x extension: arithmeticMeanTick — the floor-toward-minus-infinity
// division that's load-bearing for Phase 5.6 settlement-grade TWAP
// pricing. BigInt division rounds toward zero (Solidity-compatible); for
// negative tickDelta that doesn't divide evenly, Uniswap v3's
// OracleLibrary.consult subtracts 1 to get true floor division. The
// chart-display difference is invisible but settlement quoting needs
// agreement with on-chain math. A regression that switched to plain
// truncate-toward-zero would silently mis-quote prices for falling
// markets by ~0.01% (one tick).
describe("arithmeticMeanTick (floor-toward-minus-infinity)", () => {
  it("zero tickDelta returns 0 regardless of window", () => {
    expect(arithmeticMeanTick(0n, 60)).toBe(0);
    expect(arithmeticMeanTick(0n, 3600)).toBe(0);
  });

  it("positive tickDelta that divides evenly returns the exact quotient", () => {
    expect(arithmeticMeanTick(600n, 60)).toBe(10);
    expect(arithmeticMeanTick(3600n, 60)).toBe(60);
  });

  it("positive tickDelta that does NOT divide evenly truncates toward zero (no correction)", () => {
    // 599 / 60 = 9.98... -> floor for positives = 9 (BigInt /'s default)
    expect(arithmeticMeanTick(599n, 60)).toBe(9);
    // 601 / 60 = 10.01... -> floor = 10
    expect(arithmeticMeanTick(601n, 60)).toBe(10);
  });

  it("negative tickDelta that divides evenly returns the exact (negative) quotient", () => {
    expect(arithmeticMeanTick(-600n, 60)).toBe(-10);
    expect(arithmeticMeanTick(-3600n, 60)).toBe(-60);
  });

  it("negative tickDelta that does NOT divide evenly subtracts 1 (the OracleLibrary correction)", () => {
    // -599 / 60 in BigInt = -9 (truncate toward zero).
    // True floor toward -inf = -10 (because -9.98... rounds DOWN to -10).
    // OracleLibrary subtracts 1 to get -10. Pinned here.
    expect(arithmeticMeanTick(-599n, 60)).toBe(-10);
    // -601 / 60 in BigInt = -10. True floor = -11. Correction yields -11.
    expect(arithmeticMeanTick(-601n, 60)).toBe(-11);
  });

  it("does NOT subtract 1 for negative tickDelta when it divides evenly (no off-by-one)", () => {
    // Bug-trap: a regression that ALWAYS subtracts 1 for negative input
    // (rather than only when remainder is non-zero) would shift every
    // even-divide negative case by one tick.
    expect(arithmeticMeanTick(-60n, 60)).toBe(-1);
    expect(arithmeticMeanTick(-120n, 60)).toBe(-2);
  });

  it("handles a very large bigint tickDelta without precision loss in Number()", () => {
    // int56 max is 2^55 - 1. Even after dividing by a small window the
    // result fits in float64 (max safe integer = 2^53 - 1).
    const tickDelta = 1n << 50n; // 2^50
    const result = arithmeticMeanTick(tickDelta, 60);
    expect(result).toBe(Number(tickDelta / 60n));
    expect(Number.isFinite(result)).toBe(true);
  });
});

// §15.x extension: twapPrice — single observe() round-trip that wraps
// arithmeticMeanTick + tickToPrice. Mock the publicClient.readContract
// so the test pins the math, not the network. Phase 5.6 settlement
// quotes depend on this returning a price that AGREES with on-chain
// OracleLibrary.consult.
describe("twapPrice (single observe() + arithmetic mean + tick-to-price)", () => {
  function makeClient(tickCumulatives: readonly bigint[]): PublicClient {
    const readContract = vi.fn().mockResolvedValue([tickCumulatives, [0n, 0n]]);
    return { readContract } as unknown as PublicClient;
  }

  it("zero tick-delta -> price = 1 * 10^(d0 - d1) (identity * decimal scale)", async () => {
    // Same cumulative at both boundaries: no price movement.
    const client = makeClient([1000n, 1000n]);
    const out = await twapPrice({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 60,
      decimals0: 6,
      decimals1: 6,
    });
    expect(out).toBe(1);
  });

  it("positive tick movement -> price > 1 (rising market)", async () => {
    // tick delta = +6000 over 60s -> mean tick = 100 -> 1.0001^100 ≈ 1.01
    const client = makeClient([0n, 6000n]);
    const out = await twapPrice({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 60,
      decimals0: 6,
      decimals1: 6,
    });
    expect(out).toBeGreaterThan(1);
    expect(out).toBeLessThan(1.02);
  });

  it("negative tick movement -> price < 1 (falling market)", async () => {
    const client = makeClient([6000n, 0n]);
    const out = await twapPrice({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 60,
      decimals0: 6,
      decimals1: 6,
    });
    expect(out).toBeLessThan(1);
    expect(out).toBeGreaterThan(0.98);
  });

  it("decimals0 != decimals1 scales the result by 10^(d0 - d1)", async () => {
    // Zero tick delta + decimals0=18 (WETH), decimals1=6 (USDC):
    //   raw price (1.0001^0 = 1) * 10^(18-6) = 1e12
    const client = makeClient([0n, 0n]);
    const out = await twapPrice({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 60,
      decimals0: 18,
      decimals1: 6,
    });
    expect(out).toBe(1e12);
  });

  it("calls observe with the windowSeconds-back boundary AND now (secondsAgos = [N, 0])", async () => {
    const readContract = vi.fn().mockResolvedValue([[0n, 0n], [0n, 0n]]);
    const client = { readContract } as unknown as PublicClient;
    await twapPrice({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 3600,
      decimals0: 6,
      decimals1: 6,
    });
    expect(readContract).toHaveBeenCalledTimes(1);
    const call = readContract.mock.calls[0][0] as { functionName: string; args: readonly [readonly number[]] };
    expect(call.functionName).toBe("observe");
    expect(call.args[0]).toEqual([3600, 0]);
  });
});

// §15.x extension: fetchTwapSeries — the multi-sample charting variant
// that drives the DEX-tab price chart. Single observe() call returns
// N+1 cumulative ticks; the loop produces N samples.
describe("fetchTwapSeries (multi-sample TWAP for charting)", () => {
  function makeClient(cumulatives: readonly bigint[]): PublicClient {
    const readContract = vi.fn().mockResolvedValue([cumulatives, []]);
    return { readContract } as unknown as PublicClient;
  }

  it("rejects granularitySeconds <= 0", async () => {
    const client = makeClient([]);
    await expect(
      fetchTwapSeries({
        client,
        poolAddress: "0xpool" as Address,
        windowSeconds: 3600,
        granularitySeconds: 0,
        decimals0: 6,
        decimals1: 6,
      }),
    ).rejects.toThrow(/granularitySeconds must be positive/);
  });

  it("rejects windowSeconds <= granularitySeconds (degenerate single-sample window)", async () => {
    const client = makeClient([]);
    await expect(
      fetchTwapSeries({
        client,
        poolAddress: "0xpool" as Address,
        windowSeconds: 60,
        granularitySeconds: 60,
        decimals0: 6,
        decimals1: 6,
      }),
    ).rejects.toThrow(/windowSeconds must be larger/);
  });

  it("produces floor(window/granularity) samples (sampleCount math)", async () => {
    // 3600/300 = 12 samples -> need 13 cumulative values
    const cumulatives = Array.from({ length: 13 }, (_, i) => BigInt(i * 6000));
    const client = makeClient(cumulatives);
    const out = await fetchTwapSeries({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 3600,
      granularitySeconds: 300,
      decimals0: 6,
      decimals1: 6,
    });
    expect(out).toHaveLength(12);
  });

  it("requests secondsAgos in DESCENDING order (oldest first, [N*g, (N-1)*g, ..., 0])", async () => {
    const cumulatives = Array.from({ length: 5 }, (_, i) => BigInt(i * 6000));
    const readContract = vi.fn().mockResolvedValue([cumulatives, []]);
    const client = { readContract } as unknown as PublicClient;
    await fetchTwapSeries({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 240,
      granularitySeconds: 60,
      decimals0: 6,
      decimals1: 6,
    });
    const args = readContract.mock.calls[0][0] as { args: readonly [readonly number[]] };
    expect(args.args[0]).toEqual([240, 180, 120, 60, 0]);
  });

  it("each sample's price comes from arithmetic-mean of consecutive cumulatives", async () => {
    // Cumulatives [0, 6000, 12000] over 60s each -> tick delta 6000
    // per sample -> mean tick 100 -> price ~ 1.0001^100 ≈ 1.01
    const client = makeClient([0n, 6000n, 12000n]);
    const out = await fetchTwapSeries({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 120,
      granularitySeconds: 60,
      decimals0: 6,
      decimals1: 6,
    });
    expect(out).toHaveLength(2);
    for (const sample of out) {
      expect(sample.price).toBeGreaterThan(1);
      expect(sample.price).toBeLessThan(1.02);
      expect(sample.meanTick).toBe(100);
    }
  });

  it("sample.time stamps are spaced by granularitySeconds with the most-recent at index N-1", async () => {
    const client = makeClient([0n, 1000n, 2000n, 3000n]);
    const out = await fetchTwapSeries({
      client,
      poolAddress: "0xpool" as Address,
      windowSeconds: 180,
      granularitySeconds: 60,
      decimals0: 6,
      decimals1: 6,
    });
    expect(out).toHaveLength(3);
    // Spacing is exactly granularitySeconds; the last sample is the freshest.
    expect(out[1]!.time - out[0]!.time).toBe(60);
    expect(out[2]!.time - out[1]!.time).toBe(60);
  });
});
