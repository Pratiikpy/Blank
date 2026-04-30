import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── v0.1.8 upgrade task ──────────────────────────────────────────────
// Phase 3.5 — On-chain CID anchoring for BusinessHub.
//
//   - BusinessHub (#225): adds two storage-safe APPEND-ONLY mappings:
//                          • invoicePdfCidHash   (slot 12)
//                          • escrowAttachmentCidHash (slot 13)
//                          plus two new external setters and two new events.
//                          No re-init required — `upgradeToAndCall(impl, "0x")`.
//
// Storage layout: the snapshot was re-blessed via `pnpm storage:write`. CI
// (`pnpm storage:check`) verifies pre-existing slots 0-11 are untouched and
// only new bytes32 mappings appear at the tail. Reviewers should diff
// `storage-layouts/BusinessHub.json` and confirm that pattern.
//
// Run (human step):
//   npx hardhat deploy-upgrade-v018 --network eth-sepolia
//   npx hardhat deploy-upgrade-v018 --network base-sepolia
//
// Post-upgrade verification:
//   • Read invoicePdfCidHash(<oldId>)         → returns 0x0…0 (untouched)
//   • Vendor calls setInvoicePdfCidHash(id, h) on a Pending invoice → succeeds
//   • Same call on a Paid / Cancelled invoice → reverts "invoice no longer open"
//   • Frontend post-pin write goes through (see useBusinessHub Phase 3.5 wiring).

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const dir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(dir, `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2));
  console.log(`\nDeployment updated: ${filePath}`);
}

async function upgradeInPlace(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  proxyAddress: string,
): Promise<string> {
  console.log(`     proxy:`, proxyAddress);
  const Factory = await hre.ethers.getContractFactory(contractName);
  const newImpl = await Factory.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddress = await newImpl.getAddress();
  console.log(`     new impl:`, newImplAddress);

  const proxy = Factory.attach(proxyAddress);
  // upgradeToAndCall("0x") — empty calldata = no re-init, just swap impl
  const tx = await (proxy as any).upgradeToAndCall(newImplAddress, "0x");
  await tx.wait(2);
  console.log(`     ✓ upgraded`);
  return newImplAddress;
}

task(
  "deploy-upgrade-v018",
  "Upgrade BusinessHub in place for v0.1.8 (#225 — Phase 3.5 on-chain CID anchoring for invoice PDFs and escrow attachments)",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — v0.1.8 CID-Anchoring Upgrade (Phase 3.5)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!addresses.BusinessHub) {
    throw new Error("BusinessHub not deployed on this network");
  }

  console.log("1/1  BusinessHub upgrade (#225 — invoicePdfCidHash + escrowAttachmentCidHash)...");
  const businessImpl = await upgradeInPlace(hre, "BusinessHub", addresses.BusinessHub);
  addresses.BusinessHub_Impl = businessImpl;

  saveDeployment(hre.network.name, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  v0.1.8 Upgrade Complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();
  console.log("  Verify storage layout matches the committed snapshot:");
  console.log("    pnpm storage:check");
  console.log();
  console.log("  Spot-check the new methods on the upgraded proxy:");
  console.log("    • invoicePdfCidHash(<existingId>)    → 0x0…0 (zero, untouched)");
  console.log("    • escrowAttachmentCidHash(<id>)      → 0x0…0 (zero, untouched)");
  console.log("    • Vendor setInvoicePdfCidHash(id,h)  → succeeds while invoice is open");
  console.log("    • Same call on Paid invoice          → reverts \"invoice no longer open\"");
  console.log();
});
