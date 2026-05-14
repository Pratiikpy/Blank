import { task } from "hardhat/config";

/**
 * seed-testusdc-pool — Phase 5.6 testnet operability.
 *
 * Phase 5.6 (`payInvoiceWithSwap`) routes through Uniswap v3 to swap a
 * payer's token (USDT/WETH/etc.) into the invoice's underlying USDC.
 * Our app's `TestUSDC` is permissionless-mint and has no Uniswap
 * liquidity by default — every swap quote reverts with "no pool".
 *
 * This task closes that gap: it creates + initializes a TestUSDC/WETH
 * v3 pool at the 0.3% fee tier (default), then mints liquidity from the
 * deployer's WETH and TestUSDC balances. The price is a configurable
 * "spot" param defaulting to 1 ETH = 3000 TestUSDC (so callers don't
 * have to compute sqrtPriceX96 themselves).
 *
 * The on-chain mechanics (createAndInitializePoolIfNecessary +
 * NonfungiblePositionManager.mint) are real Uniswap v3 calls — same code
 * path mainnet uses. Difference is the deployer holds the LP NFT and
 * can pull liquidity back via `decreaseLiquidity` if needed.
 *
 * Usage:
 *   # Ensure deployer has both: TestUSDC (mint via faucet) + WETH (deposit
 *   # ETH into WETH9 first — you'll need an existing WETH9 task or do it
 *   # manually in remix).
 *
 *   npx hardhat seed-testusdc-pool \
 *     --network eth-sepolia \
 *     --usdc-amount 30000 \
 *     --weth-amount 10
 *
 * Caveats:
 *   • Slippage / impermanent loss on testnet: deployer's funds are at
 *     real-feeling risk if a bot trades through. Testnet only — never
 *     run with mainnet keys.
 *   • WETH on Sepolia (`0xfFf99…6B14`) and Base Sepolia
 *     (`0x42…0006`) are the canonical wrapped-ETH tokens recognized by
 *     Uniswap's deployment.
 */

const NPM_ABI = [
  // createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96)
  // returns the pool address.
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

const POOL_INIT_ABI = ["function initialize(uint160 sqrtPriceX96) external"];

interface Deploys {
  TestUSDC: string;
}

// Per-chain Uniswap NPM (NonfungiblePositionManager). Verified against
// Uniswap v3 deployments doc 2026-04-26.
const NPM_BY_CHAIN: Record<string, string> = {
  "eth-sepolia": "0x1238536071E1c677A632429e3655c799b22cDA52",
  "base-sepolia": "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
};

const WETH_BY_CHAIN: Record<string, string> = {
  "eth-sepolia": "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  "base-sepolia": "0x4200000000000000000000000000000000000006",
};

/** Compute sqrtPriceX96 for `token1Per1Token0` with the given decimals.
 *  Uniswap stores price as token1/token0 in Q64.96 fixed-point of the
 *  ratio of raw smallest-units. We compute `sqrt(rawRatio) * 2^96` using
 *  bigint to avoid float precision loss for large ratios. */
export function computeSqrtPriceX96(
  rawToken1Per1Token0: bigint,
  rawDenominator: bigint,
): bigint {
  // ratio = rawToken1Per1Token0 / rawDenominator (Q0.0)
  // sqrtPriceX96 = sqrt(ratio) * 2^96 = sqrt(ratio * 2^192)
  const TWO_POW_192 = 1n << 192n;
  const product = (rawToken1Per1Token0 * TWO_POW_192) / rawDenominator;
  // bigint sqrt via Newton's method
  if (product < 0n) throw new Error("negative product");
  if (product < 2n) return product;
  let x = product;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + product / x) / 2n;
  }
  return x;
}

task(
  "seed-testusdc-pool",
  "Phase 5.6 operability — create + LP a TestUSDC/WETH v3 pool on testnet",
)
  .addOptionalParam("usdcAmount", "TestUSDC amount to LP (human units, e.g. 30000)", "30000")
  .addOptionalParam("wethAmount", "WETH amount to LP (human units, e.g. 10)", "10")
  .addOptionalParam("fee", "Pool fee tier (500 / 3000 / 10000)", "3000")
  .addOptionalParam(
    "priceUsdcPerWeth",
    "Initial price = USDC per 1 WETH (controls sqrtPriceX96)",
    "3000",
  )
  .setAction(async (args, hre) => {
    const networkName = hre.network.name;
    if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
      throw new Error(
        `seed-testusdc-pool: testnet only — got ${networkName}. Mainnet pools have natural liquidity.`,
      );
    }

    const npmAddress = NPM_BY_CHAIN[networkName];
    const wethAddress = WETH_BY_CHAIN[networkName];
    if (!npmAddress || !wethAddress) {
      throw new Error(`seed-testusdc-pool: missing config for ${networkName}`);
    }

    const deploymentPath = `${__dirname}/../deployments/${networkName}.json`;
    const deploys = require(deploymentPath) as Deploys;
    if (!deploys.TestUSDC) {
      throw new Error(
        `seed-testusdc-pool: TestUSDC missing from ${deploymentPath} — run base deploy first`,
      );
    }

    const [signer] = await hre.ethers.getSigners();
    if (!signer) throw new Error("No signer configured");
    const signerAddress = await signer.getAddress();

    console.log(`[seed-pool] Network:  ${networkName}`);
    console.log(`[seed-pool] Signer:   ${signerAddress}`);
    console.log(`[seed-pool] TestUSDC: ${deploys.TestUSDC}`);
    console.log(`[seed-pool] WETH:     ${wethAddress}`);
    console.log(`[seed-pool] NPM:      ${npmAddress}`);

    // Sort tokens — Uniswap requires token0 < token1 lexicographically.
    const usdcLower = deploys.TestUSDC.toLowerCase();
    const wethLower = wethAddress.toLowerCase();
    const usdcIsToken0 = usdcLower < wethLower;
    const token0 = usdcIsToken0 ? deploys.TestUSDC : wethAddress;
    const token1 = usdcIsToken0 ? wethAddress : deploys.TestUSDC;

    const usdcDecimals = 6n;
    const wethDecimals = 18n;
    const usdcAmount = hre.ethers.parseUnits(args.usdcAmount, Number(usdcDecimals));
    const wethAmount = hre.ethers.parseUnits(args.wethAmount, Number(wethDecimals));
    const fee = Number(args.fee);
    if (![500, 3000, 10000].includes(fee)) {
      throw new Error(`fee must be 500, 3000, or 10000 — got ${fee}`);
    }

    // Initial price: priceUsdcPerWeth USDC per 1 WETH.
    // Token0/token1 ordering: if USDC is token0, price is WETH per USDC = 1/P.
    // Express in raw (smallest-unit) ratios.
    const priceUsdcPerWeth = BigInt(args.priceUsdcPerWeth);
    const rawWethUnit = 10n ** wethDecimals;
    const rawUsdcAtPrice = priceUsdcPerWeth * 10n ** usdcDecimals;
    let sqrtPriceX96: bigint;
    if (usdcIsToken0) {
      // token0 = USDC (6), token1 = WETH (18)
      // price (token1/token0) = 1 WETH / priceUsdcPerWeth USDC
      //   raw: (1 * 1e18) / (priceUsdcPerWeth * 1e6)
      sqrtPriceX96 = computeSqrtPriceX96(rawWethUnit, rawUsdcAtPrice);
    } else {
      // token0 = WETH (18), token1 = USDC (6)
      // price = priceUsdcPerWeth USDC / 1 WETH = (priceUsdcPerWeth * 1e6) / 1e18
      sqrtPriceX96 = computeSqrtPriceX96(rawUsdcAtPrice, rawWethUnit);
    }
    console.log(`[seed-pool] Token0:   ${token0} (${usdcIsToken0 ? "USDC" : "WETH"})`);
    console.log(`[seed-pool] Token1:   ${token1} (${usdcIsToken0 ? "WETH" : "USDC"})`);
    console.log(`[seed-pool] Fee tier: ${fee} (${(fee / 10_000).toFixed(2)}%)`);
    console.log(`[seed-pool] Initial price: 1 WETH = ${priceUsdcPerWeth} USDC`);
    console.log(`[seed-pool] sqrtPriceX96:  ${sqrtPriceX96.toString()}`);

    // ── 1. Create + init pool (idempotent if pool already exists) ────────
    const npm = new hre.ethers.Contract(npmAddress, NPM_ABI, signer);
    console.log(`[seed-pool] createAndInitializePoolIfNecessary…`);
    const createTx = await npm.createAndInitializePoolIfNecessary(
      token0,
      token1,
      fee,
      sqrtPriceX96,
    );
    const createReceipt = await createTx.wait(1);
    if (!createReceipt || createReceipt.status !== 1) {
      throw new Error(`Pool creation tx failed: ${createTx.hash}`);
    }
    console.log(`[seed-pool] ✓ pool initialized (tx ${createTx.hash})`);

    // ── 2. Approve NPM for both tokens ───────────────────────────────────
    const usdc = new hre.ethers.Contract(deploys.TestUSDC, ERC20_ABI, signer);
    const weth = new hre.ethers.Contract(wethAddress, ERC20_ABI, signer);

    const usdcBal = (await usdc.balanceOf(signerAddress)) as bigint;
    const wethBal = (await weth.balanceOf(signerAddress)) as bigint;
    if (usdcBal < usdcAmount) {
      throw new Error(
        `[seed-pool] insufficient USDC: have ${hre.ethers.formatUnits(usdcBal, 6)}, need ${args.usdcAmount}. Mint via TestUSDC.mint first.`,
      );
    }
    if (wethBal < wethAmount) {
      throw new Error(
        `[seed-pool] insufficient WETH: have ${hre.ethers.formatUnits(wethBal, 18)}, need ${args.wethAmount}. Deposit ETH into WETH9 first.`,
      );
    }

    console.log(`[seed-pool] approving NPM for USDC + WETH…`);
    const approveTx1 = await usdc.approve(npmAddress, usdcAmount);
    await approveTx1.wait(1);
    const approveTx2 = await weth.approve(npmAddress, wethAmount);
    await approveTx2.wait(1);

    // ── 3. Mint full-range LP position ──────────────────────────────────
    // Full-range LP so any swap through the pool succeeds on testnet.
    // Ticks must be multiples of tickSpacing — Uniswap's MAX_ABS_TICK is
    // 887272, but the largest valid full-range tick is the largest
    // multiple of tickSpacing that fits inside [-887272, 887272].
    //
    // Bug fix (2026-04-27 audit): the obvious `-887272 + (-887272 %
    // spacing)` rounding doesn't work in JS because `%` returns the sign
    // of the dividend, so `-887272 % 60 === -52` (not 52) and the
    // alignment was off, causing the pool to revert with "tickLower not
    // aligned" on first run for all three fee tiers. Math.floor on the
    // absolute value gives a sign-safe alignment.
    const tickSpacing = fee === 500 ? 10 : fee === 3000 ? 60 : 200;
    const aligned = Math.floor(887272 / tickSpacing) * tickSpacing;
    const MIN_TICK = -aligned;
    const MAX_TICK = aligned;

    const amount0Desired = usdcIsToken0 ? usdcAmount : wethAmount;
    const amount1Desired = usdcIsToken0 ? wethAmount : usdcAmount;
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    console.log(`[seed-pool] mint LP position…`);
    const mintTx = await npm.mint({
      token0,
      token1,
      fee,
      tickLower: MIN_TICK,
      tickUpper: MAX_TICK,
      amount0Desired,
      amount1Desired,
      amount0Min: 0n, // testnet: no slippage protection
      amount1Min: 0n,
      recipient: signerAddress,
      deadline,
    });
    const mintReceipt = await mintTx.wait(1);
    if (!mintReceipt || mintReceipt.status !== 1) {
      throw new Error(`mint tx failed: ${mintTx.hash}`);
    }
    console.log(`[seed-pool] ✓ LP position minted (tx ${mintTx.hash})`);
    console.log(`[seed-pool] LP NFT belongs to ${signerAddress} — keep the key safe.`);

    console.log("");
    console.log(`[seed-pool] DONE. The Phase 5.6 'Pay in different token' flow`);
    console.log(`            should now find quotes against this pool. Run a test`);
    console.log(`            invoice payment with WETH → TestUSDC to verify.`);
  });
