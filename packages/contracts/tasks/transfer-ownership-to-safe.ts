import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * transfer-ownership-to-safe - hand every contract the deployer owns to the
 * Safe multisig.
 *
 * Walks every address in the deployment file, keeps the ones whose owner()
 * is the deployer, and calls transferOwnership(safe). The contracts use
 * single-step OZ Ownable, so the Safe owns them the moment the tx lands; the
 * task first checks the Safe address has code and the expected threshold,
 * then re-reads owner() on each contract afterwards.
 *
 * After this, upgrades and admin calls need 2 of 3 Safe signatures.
 *
 * Args:
 *   --safe     : Safe address (same on all three testnets).
 *   --dry-run  : list what would move, send nothing.
 */
task("transfer-ownership-to-safe", "Transfer every deployer-owned contract to the Safe")
  .addParam("safe", "Safe multisig address")
  .addFlag("dryRun", "List the contracts without sending txs")
  .setAction(async (args: { safe: string; dryRun: boolean }, hre: HardhatRuntimeEnvironment) => {
    const file =
      hre.network.name === "arb-sepolia" ? "arb-sepolia.json" :
      hre.network.name === "base-sepolia" ? "base-sepolia.json" :
      hre.network.name === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!file) throw new Error(`transfer-ownership-to-safe: unsupported network ${hre.network.name}`);
    const path = resolve(__dirname, "..", "deployments", file);
    const d: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));
    const [deployer] = await hre.ethers.getSigners();
    const p = hre.ethers.provider;

    const safe = hre.ethers.getAddress(args.safe);
    if ((await p.getCode(safe)) === "0x") throw new Error(`no code at Safe ${safe}`);
    const safeC = new hre.ethers.Contract(
      safe,
      ["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"],
      p,
    );
    const [threshold, owners] = await Promise.all([safeC.getThreshold(), safeC.getOwners()]);
    if (threshold < 2n) throw new Error(`Safe threshold is ${threshold}, refusing`);
    console.log(`Safe ${safe}: ${threshold} of ${owners.length}`);

    const ownable = ["function owner() view returns (address)", "function transferOwnership(address)"];
    const seen = new Set<string>();
    const plan: Array<{ key: string; addr: string }> = [];
    for (const [key, addr] of Object.entries(d)) {
      // Implementation contracts are owned by nobody useful; skip by name.
      if (!hre.ethers.isAddress(addr) || /_Impl|_v0$|_v1$/.test(key)) continue;
      const a = hre.ethers.getAddress(addr);
      if (seen.has(a)) continue;
      seen.add(a);
      if ((await p.getCode(a)) === "0x") continue;
      let owner: string;
      try {
        owner = await new hre.ethers.Contract(a, ownable, p).owner();
      } catch {
        continue;
      }
      if (owner.toLowerCase() === deployer.address.toLowerCase()) plan.push({ key, addr: a });
      else if (owner.toLowerCase() === safe.toLowerCase()) console.log(`  ${key.padEnd(26)} already Safe-owned`);
    }

    console.log(`${plan.length} contract(s) owned by the deployer ${deployer.address}:`);
    for (const x of plan) console.log(`  ${x.key.padEnd(26)} ${x.addr}`);
    if (args.dryRun) return;


    for (const x of plan) {
      const c = new hre.ethers.Contract(x.addr, ownable, deployer);
      const tx = await c.transferOwnership(safe);
      await tx.wait(2);
      const now: string = await c.owner();
      if (now.toLowerCase() === safe.toLowerCase()) {
        console.log(`  ${x.key.padEnd(26)} -> Safe  tx=${tx.hash}`);
        continue;
      }
      // Ownable2Step (BlankPaymaster via BasePaymaster): the Safe becomes
      // pendingOwner and must call acceptOwnership from a Safe transaction.
      const pending: string = await new hre.ethers.Contract(
        x.addr, ["function pendingOwner() view returns (address)"], p,
      ).pendingOwner().catch(() => hre.ethers.ZeroAddress);
      if (pending.toLowerCase() !== safe.toLowerCase()) throw new Error(`${x.key}: owner is ${now} after transfer`);
      console.log(`  ${x.key.padEnd(26)} -> Safe pending, needs acceptOwnership from the Safe  tx=${tx.hash}`);
    }
    d.OwnerSafe = safe;
    writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
    console.log(`done: ${plan.length} contract(s) now owned by the Safe on ${hre.network.name}`);
  });
