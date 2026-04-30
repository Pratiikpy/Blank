import { task } from "hardhat/config";

/**
 * bump-pool-cardinality — raise a Uniswap v3 pool's
 * `observationCardinalityNext` so its TWAP history can span more than
 * the trivial 1-slot default.
 *
 * Why this exists: every Uniswap v3 pool starts with cardinality = 1,
 * which means `pool.observe([T, 0])` for any T > 0 reverts with `OLD`.
 * The TwapChart on the DEX tab (Phase 5.8) needs at least ~300 slots
 * for a 1-day chart at 5-min granularity. Without this task each pool
 * we want to chart would silently render the "Pool needs more
 * observation slots" empty state, which is bad UX during a demo.
 *
 * Pools allocate one observation per swap until `cardinality` catches
 * up to `cardinalityNext`, so the slots fill organically — but the
 * bump call ITSELF only sets the target. On low-activity testnet pools
 * you may also want to force a few swaps to populate.
 *
 * Costs ~0.001 ETH per pool, one-time.
 *
 * Usage:
 *   npx hardhat bump-pool-cardinality \
 *     --pool 0x... \
 *     --cardinality 360 \
 *     --network eth-sepolia
 */
task(
  "bump-pool-cardinality",
  "Raise a Uniswap v3 pool's observationCardinalityNext for TWAP history",
)
  .addParam("pool", "Uniswap v3 pool address (0x…)")
  .addOptionalParam(
    "cardinality",
    "Target cardinalityNext (default 360 → ~6h at 1-min granularity)",
    "360",
  )
  .setAction(async ({ pool, cardinality }, hre) => {
    const networkName = hre.network.name;
    if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
      throw new Error(
        `bump-pool-cardinality runs on testnet only — got ${networkName}. Mainnet pools usually have plenty of cardinality already.`,
      );
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) {
      throw new Error(`Invalid pool address: ${pool}`);
    }

    const target = Number(cardinality);
    if (!Number.isInteger(target) || target < 2 || target > 65535) {
      throw new Error(
        `cardinality must be an integer between 2 and 65535 (uint16) — got ${cardinality}`,
      );
    }

    const [signer] = await hre.ethers.getSigners();
    if (!signer) {
      throw new Error("No signer configured for this network");
    }
    console.log(`[bump-pool-cardinality] Network: ${networkName}`);
    console.log(`[bump-pool-cardinality] Signer:  ${await signer.getAddress()}`);
    console.log(`[bump-pool-cardinality] Pool:    ${pool}`);
    console.log(`[bump-pool-cardinality] Target:  ${target}`);

    // Minimal v3 pool ABI for the calls we need.
    const abi = [
      "function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external",
      "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    ];
    const v3Pool = new hre.ethers.Contract(pool, abi, signer);

    let before;
    try {
      before = await v3Pool.slot0();
    } catch (err) {
      throw new Error(
        `Couldn't read slot0 — does this pool exist on ${networkName}? Inner error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const beforeCardinality = Number(before[3]);
    const beforeCardinalityNext = Number(before[4]);
    console.log(
      `[bump-pool-cardinality] Current cardinality: ${beforeCardinality}, cardinalityNext: ${beforeCardinalityNext}`,
    );

    if (beforeCardinalityNext >= target) {
      console.log(
        `[bump-pool-cardinality] Already at or above target — no-op. cardinalityNext=${beforeCardinalityNext} ≥ ${target}.`,
      );
      return;
    }

    console.log(`[bump-pool-cardinality] Submitting tx…`);
    const tx = await v3Pool.increaseObservationCardinalityNext(target);
    console.log(`[bump-pool-cardinality] tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Transaction reverted: ${tx.hash}`);
    }
    console.log(
      `[bump-pool-cardinality] ✓ Mined in block ${receipt.blockNumber}, gas used ${receipt.gasUsed.toString()}`,
    );

    const after = await v3Pool.slot0();
    const afterCardinalityNext = Number(after[4]);
    console.log(`[bump-pool-cardinality] cardinalityNext now: ${afterCardinalityNext}`);
    if (afterCardinalityNext < target) {
      console.warn(
        `[bump-pool-cardinality] cardinalityNext (${afterCardinalityNext}) is below target (${target}) — pool may have rejected silently.`,
      );
    }

    console.log(
      `[bump-pool-cardinality] Note: actual cardinality only increases as new swaps land. The pool may need a few trades before observe() returns history.`,
    );
  });
