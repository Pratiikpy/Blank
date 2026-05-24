import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * rotate-offramp-arbiter — call P2POfframp.setArbiter(newArbiter)
 *
 * Ops task for rotating the arbiter (dispute resolver) post-deploy. The
 * v1 deploy sets arbiter = deployer for demo purposes; before any large
 * fills happen, rotate to a 3-of-5 multisig.
 *
 * Reads the current arbiter and the offramp address from
 * deployments/<network>.json, sends setArbiter(--to), and re-reads to
 * confirm the rotation landed on-chain.
 *
 * Args:
 *   --to        : new arbiter address (must be a real address, not 0x0)
 *   --dry-run   : print the action but don't send the tx
 *
 * Usage:
 *   pnpm hardhat rotate-offramp-arbiter --to 0xSafeAddr --network eth-sepolia
 *   pnpm hardhat rotate-offramp-arbiter --to 0xSafeAddr --network base-sepolia
 */
task("rotate-offramp-arbiter", "Rotate P2POfframp.arbiter via setArbiter()")
  .addParam("to", "New arbiter address (a 3-of-5 multisig, ideally)")
  .addFlag("dryRun", "Print the action but don't send the tx")
  .setAction(async (args: { to: string; dryRun: boolean }, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!file) throw new Error(`rotate-offramp-arbiter: unsupported ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);

    const deployments: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));
    const offrampAddr = deployments.P2POfframp;
    if (!offrampAddr) throw new Error(`rotate-offramp-arbiter: P2POfframp missing in ${file}`);

    if (!/^0x[0-9a-fA-F]{40}$/.test(args.to)) {
      throw new Error(`rotate-offramp-arbiter: invalid --to address: ${args.to}`);
    }
    if (args.to === "0x0000000000000000000000000000000000000000") {
      throw new Error("rotate-offramp-arbiter: refusing to set arbiter to address(0)");
    }

    const [signer] = await hre.ethers.getSigners();
    const offramp = await hre.ethers.getContractAt("P2POfframp", offrampAddr, signer);

    const currentArbiter = await offramp.arbiter();
    const currentOwner = await offramp.owner();

    console.log(`network=${networkName}`);
    console.log(`P2POfframp=${offrampAddr}`);
    console.log(`current arbiter=${currentArbiter}`);
    console.log(`new arbiter=${args.to}`);
    console.log(`tx signer=${signer.address}`);
    console.log(`contract owner=${currentOwner}`);

    if (signer.address.toLowerCase() !== currentOwner.toLowerCase()) {
      throw new Error(
        `rotate-offramp-arbiter: signer (${signer.address}) is not owner (${currentOwner}). Only the owner can call setArbiter().`,
      );
    }

    if (currentArbiter.toLowerCase() === args.to.toLowerCase()) {
      console.log(`[skip] arbiter is already ${args.to} — nothing to do`);
      return;
    }

    if (args.dryRun) {
      console.log(`[dry-run] would call setArbiter(${args.to})`);
      return;
    }

    const tx = await offramp.setArbiter(args.to);
    console.log(`tx hash=${tx.hash}`);
    await tx.wait(2);

    const newArbiter = await offramp.arbiter();
    if (newArbiter.toLowerCase() !== args.to.toLowerCase()) {
      throw new Error(`rotate-offramp-arbiter: post-rotate arbiter=${newArbiter}, expected=${args.to}`);
    }
    console.log(`[ok] arbiter rotated: ${currentArbiter} → ${newArbiter}`);
  });
