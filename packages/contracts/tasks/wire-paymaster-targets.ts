import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { PAYMASTER_TARGETS, RETIRED_TARGETS } from "./lib/paymaster-targets";

/**
 * wire-paymaster-targets: audit and fix BlankPaymaster.approvedTargets.
 *
 * BlankPaymaster sponsors only execute / executeBatch calls whose every
 * target is approved (once any target is approved). The sponsor backend
 * (/api/paymaster/sponsor) reads the same on-chain allowlist, so a missing
 * target shows up as "target ... is not on the paymaster allowlist".
 *
 * Approves every contract in tasks/lib/paymaster-targets.ts present in the
 * deployment file, and un-approves retired ones (ProofOfBalance, the *_v0
 * addresses left behind by fresh deploys).
 *
 * --dry-run  -> print what would change
 * (default)  -> submit one tx per change
 *
 *   npx hardhat wire-paymaster-targets --network base-sepolia --dry-run
 *   npx hardhat wire-paymaster-targets --network base-sepolia
 *
 * Caller MUST be the paymaster owner.
 */

const PAYMASTER_ABI = [
  "function approvedTargets(address) external view returns (bool)",
  "function setApprovedTarget(address target, bool approved) external",
  "function owner() external view returns (address)",
  "function approvedTargetsCount() external view returns (uint256)",
];

task("wire-paymaster-targets", "Audit and fix the BlankPaymaster approvedTargets allowlist")
  .addFlag("dryRun", "Skip on-chain writes; just report the changes")
  .setAction(async ({ dryRun }, hre) => {
    const networkName = hre.network.name;
    const deploymentFile =
      networkName === "base-sepolia" ? "base-sepolia.json"
      : networkName === "eth-sepolia" ? "eth-sepolia.json"
      : networkName === "arb-sepolia" ? "arb-sepolia.json"
      : null;
    if (!deploymentFile) {
      throw new Error(`Unknown network "${networkName}", expected eth-sepolia, base-sepolia or arb-sepolia.`);
    }
    const deployments = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"),
    ) as Record<string, string>;

    const paymasterAddr = deployments.BlankPaymaster;
    if (!paymasterAddr) throw new Error(`BlankPaymaster not found in ${deploymentFile}`);

    const [signer] = await hre.ethers.getSigners();
    const paymaster = new hre.ethers.Contract(paymasterAddr, PAYMASTER_ABI, signer);
    const owner: string = await paymaster.owner();
    console.log(`Network:         ${networkName}`);
    console.log(`Paymaster:       ${paymasterAddr}`);
    console.log(`Paymaster owner: ${owner}`);
    console.log(`Signer:          ${signer.address}`);
    console.log(`Approved count:  ${await paymaster.approvedTargetsCount()}\n`);

    const changes: Array<{ name: string; addr: string; approve: boolean }> = [];
    const live = new Set<string>();
    for (const { key } of PAYMASTER_TARGETS) {
      const addr = deployments[key];
      if (!addr) {
        console.log(`  skip:     ${key} (not deployed on ${networkName})`);
        continue;
      }
      live.add(addr.toLowerCase());
      const approved: boolean = await paymaster.approvedTargets(addr);
      console.log(`  ${approved ? "ok:      " : "missing: "} ${key.padEnd(24)} ${addr}`);
      if (!approved) changes.push({ name: key, addr, approve: true });
    }
    for (const key of RETIRED_TARGETS) {
      const addr = deployments[key];
      // A retired key can share an address with a live one (e.g. a fresh
      // deploy that was skipped); never revoke a live target.
      if (!addr || live.has(addr.toLowerCase())) continue;
      if (await paymaster.approvedTargets(addr)) {
        console.log(`  retired:  ${key.padEnd(24)} ${addr} (will un-approve)`);
        changes.push({ name: key, addr, approve: false });
      }
    }

    console.log(`\n${changes.length} change(s).`);
    if (changes.length === 0) return;
    if (dryRun) {
      console.log("--dry-run: no on-chain writes.");
      return;
    }
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`Signer ${signer.address} is not the paymaster owner ${owner}.`);
    }
    for (const c of changes) {
      const tx = await paymaster.setApprovedTarget(c.addr, c.approve);
      console.log(`  ${c.approve ? "approve" : "revoke "} ${c.name.padEnd(24)} -> tx ${tx.hash}`);
      const rcpt = await tx.wait(2);
      if (rcpt?.status !== 1) throw new Error(`setApprovedTarget(${c.name}) reverted: ${tx.hash}`);
    }
    console.log(`Done. Approved count: ${await paymaster.approvedTargetsCount()}`);
  });
