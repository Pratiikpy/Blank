import { expect } from "chai";
import { computeSqrtPriceX96 } from "../tasks/seed-testusdc-pool";

// §15.x test for computeSqrtPriceX96 — the bigint Newton's-method sqrt
// + Q64.96 fixed-point encoding that initializes Uniswap v3 testnet
// pools via `seed-testusdc-pool`. Math errors here corrupt pool prices
// the moment the pool is initialized: arbitrageurs immediately drain
// the wrong-priced side, and the deployer eats the loss. A non-trivial
// budget (~30000 TestUSDC + 10 WETH per seed run) rides on this
// function's output.
//
// Uniswap v3 stores price as sqrtPriceX96 = floor(sqrt(R) * 2^96)
// where R is the ratio of raw smallest-units of token1 per 1 smallest-
// unit of token0. The function computes this as floor(sqrt(R * 2^192))
// via Newton's iteration on the bigint domain to avoid float precision
// loss for the huge intermediate products.

const TWO_POW_96 = 1n << 96n;
const TWO_POW_97 = 1n << 97n;
const TWO_POW_192 = 1n << 192n;

describe("computeSqrtPriceX96 — Newton's-method bigint sqrt", () => {
  it("returns 0 when the price ratio is 0 (early-exit path)", () => {
    expect(computeSqrtPriceX96(0n, 1n)).to.equal(0n);
  });

  it("returns 1 when product < 2 (early-exit path)", () => {
    // rawN=1, rawD=2^192 -> product = 2^192 / 2^192 = 1 -> early exit returns 1.
    expect(computeSqrtPriceX96(1n, TWO_POW_192)).to.equal(1n);
  });

  it("1:1 ratio with equal decimals -> sqrtPriceX96 = 2^96 (Uniswap's identity-price encoding)", () => {
    // R = 1, sqrt(1) * 2^96 = 2^96
    expect(computeSqrtPriceX96(1n, 1n)).to.equal(TWO_POW_96);
  });

  it("4:1 ratio -> sqrtPriceX96 = 2^97 (sqrt(4) = 2, so 2 * 2^96 = 2^97)", () => {
    expect(computeSqrtPriceX96(4n, 1n)).to.equal(TWO_POW_97);
  });

  it("9:1 ratio -> sqrtPriceX96 = 3 * 2^96 (sqrt(9) = 3)", () => {
    expect(computeSqrtPriceX96(9n, 1n)).to.equal(3n * TWO_POW_96);
  });

  it("16:1 ratio -> sqrtPriceX96 = 4 * 2^96 (sqrt(16) = 4)", () => {
    expect(computeSqrtPriceX96(16n, 1n)).to.equal(4n * TWO_POW_96);
  });

  it("1:4 ratio -> sqrtPriceX96 = 2^95 (sqrt(1/4) = 1/2, so 0.5 * 2^96 = 2^95)", () => {
    // The inverse-price path: smaller numerator than denominator.
    expect(computeSqrtPriceX96(1n, 4n)).to.equal(1n << 95n);
  });

  it("non-perfect-square ratio returns the FLOOR of the true sqrt (Newton converges down)", () => {
    // R = 2 -> sqrt(2) * 2^96 ≈ 1.41421 * 2^96
    // = 112045541949...something; we just assert it's between 2^96 and 2^97
    // and that squaring it back is at most 2 * 2^192 (one ULP of error).
    const result = computeSqrtPriceX96(2n, 1n);
    expect(result).to.be.greaterThan(TWO_POW_96);
    expect(result).to.be.lessThan(TWO_POW_97);
    // Squaring back: result^2 should be ≤ 2 * 2^192 (the original product),
    // and (result+1)^2 should be > 2 * 2^192. This is the floor property
    // of Newton's iteration.
    const sq = result * result;
    const targetProduct = 2n * TWO_POW_192;
    expect(sq).to.be.at.most(targetProduct);
    const sqPlusOne = (result + 1n) * (result + 1n);
    expect(sqPlusOne).to.be.greaterThan(targetProduct);
  });

  it("handles a realistic 1 WETH = 3000 USDC seed price (Phase 5.6 default)", () => {
    // raw token1/token0 ratio when USDC (6 decimals) is token0:
    //   rawN = 10^18 (1 WETH in wei)
    //   rawD = 3000 * 10^6 = 3 * 10^9 (3000 USDC in micro-units)
    //   R = rawN/rawD = ~3.33 * 10^8  (way more raw token1 per raw token0
    //   because WETH has 12 more decimals than USDC)
    // So sqrtPriceX96 should be ~sqrt(3.33e8) * 2^96 ≈ 1.83e4 * 2^96
    //   ≈ 1.45e33, which is MUCH greater than 2^96 (~7.92e28).
    const rawWethUnit = 10n ** 18n;
    const rawUsdcAt3000 = 3000n * 10n ** 6n;
    const result = computeSqrtPriceX96(rawWethUnit, rawUsdcAt3000);
    // Sanity: result is positive + greater than 2^96 (because R > 1
    // in raw-unit terms even though "1 WETH costs many USDC tokens").
    expect(result).to.be.greaterThan(0n);
    expect(result).to.be.greaterThan(TWO_POW_96);
    // Floor property: result^2 ≤ product < (result+1)^2.
    const product = (rawWethUnit * TWO_POW_192) / rawUsdcAt3000;
    expect(result * result).to.be.at.most(product);
    expect((result + 1n) * (result + 1n)).to.be.greaterThan(product);
  });

  it("handles the inverse direction (USDC is token0, WETH is token1) symmetrically", () => {
    // Flipped: rawN = 3000 * 10^6 = 3e9, rawD = 10^18.
    // R = 3e9 / 1e18 = 3e-9, so sqrt(R) ≈ 5.48e-5,
    //   sqrtPriceX96 ≈ 5.48e-5 * 2^96 ≈ 4.34e24, MUCH less than 2^96.
    const result = computeSqrtPriceX96(3000n * 10n ** 6n, 10n ** 18n);
    expect(result).to.be.greaterThan(0n);
    expect(result).to.be.lessThan(TWO_POW_96);
    // Floor property holds on this direction too.
    const product = (3000n * 10n ** 6n * TWO_POW_192) / 10n ** 18n;
    expect(result * result).to.be.at.most(product);
    expect((result + 1n) * (result + 1n)).to.be.greaterThan(product);
  });

  it("Newton's iteration HALTS on a 2^254-magnitude input (no infinite loop)", () => {
    // Stress test: a very large ratio. Newton converges in O(log log N)
    // for bigint sqrt, so even huge inputs terminate in microseconds.
    // The test mainly pins that the iteration's `while (y < x)` loop
    // does halt — a regression to a non-converging formula would hang.
    const huge = 1n << 254n;
    const result = computeSqrtPriceX96(huge, 1n);
    // sqrt(2^254 * 2^192) = sqrt(2^446) = 2^223
    expect(result).to.equal(1n << 223n);
  });

  it("negative product is not reachable via the two-arg API (positive bigints only)", () => {
    // Both args are bigint and the source treats them as non-negative.
    // The explicit `if (product < 0n) throw` is dead code on this API
    // shape, but pinned here as a sanity smoke: passing positives never
    // throws.
    expect(() => computeSqrtPriceX96(1n, 1n)).to.not.throw();
    expect(() => computeSqrtPriceX96(10n ** 30n, 1n)).to.not.throw();
  });
});
