import { describe, it, expect } from "vitest";
import {
  applySlippage,
  buildExactInputSingleArgs,
  computePoolAddress,
  tickToPrice,
  POOL_FEE,
  UNISWAP_V3_FACTORY,
} from "./uniswap";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";
import type { Address } from "viem";

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
