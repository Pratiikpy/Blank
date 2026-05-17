import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/**
 * §1.14 Wave 4 security hardening — UUPS upgrades for Storefront +
 * EncryptedCrowdfund.
 *
 * Runtime-only changes (no storage layout changes; `pnpm storage:check`
 * passes against existing baselines):
 *
 *   EncryptedCrowdfund:
 *     • A4 — closeCampaign AND-s `FHE.gt(encGoal, 0)` into the verdict
 *       boolean so a malicious creator can't grief contributors with
 *       an encrypted-zero goal. encGoal=0 + contributions → verdict
 *       FALSE → refunds.
 *
 *   Storefront:
 *     • A7 — MAX_BIDS = 200 cap on auction bid count. Prevents
 *       bid-spam DoS that would lock closeAuction past block-gas limit.
 *     • A8 — placeBid FHE.select gate on bid amount vs encMinBid. Bids
 *       below the seller-set minimum lock zero (preserves privacy of
 *       the min — no revert leak).
 *
 * The factory's accountImplementation immutability (BlankAccount-style
 * concern) does NOT apply here because Crowdfund + Storefront are
 * direct UUPS proxies, not behind a factory. The upgrade is a simple
 * `upgradeToAndCall(newImpl, "0x")` from the proxy owner.
 *
 * Usage:
 *   npx hardhat deploy-upgrade-wave4-security --network eth-sepolia
 *   npx hardhat deploy-upgrade-wave4-security --network base-sepolia
 */

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No deployment file for ${network}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`[wave4-security] Deployment file updated: ${filePath}`);
}

task(
  "deploy-upgrade-wave4-security",
  "UUPS upgrade Crowdfund (A4) + Storefront (A7+A8) for Wave 4 security hardening",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-wave4-security: unsupported network ${networkName}`,
    );
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const addresses = loadDeployment(networkName);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Wave 4 security hardening (A4/A7/A8)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer:    ${await deployer.getAddress()}`);
  console.log(`  Network:     ${networkName}`);
  console.log(`  Crowdfund:   ${addresses.EncryptedCrowdfund ?? "(not deployed)"}`);
  console.log(`  Storefront:  ${addresses.Storefront ?? "(not deployed)"}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // ── EncryptedCrowdfund A4 ─────────────────────────────────────────
  if (addresses.EncryptedCrowdfund) {
    console.log("\n[1/2] Upgrading EncryptedCrowdfund...");
    const Crowdfund = await hre.ethers.getContractFactory("EncryptedCrowdfund");
    const newCrowdfundImpl = await Crowdfund.deploy();
    await newCrowdfundImpl.deploymentTransaction()?.wait(2);
    const newCrowdfundAddr = await newCrowdfundImpl.getAddress();
    console.log(`     ✓ New Crowdfund impl: ${newCrowdfundAddr}`);

    const proxy = await hre.ethers.getContractAt(
      "EncryptedCrowdfund",
      addresses.EncryptedCrowdfund,
    );
    const tx = await proxy.upgradeToAndCall(newCrowdfundAddr, "0x");
    await tx.wait(2);
    console.log(`     ✓ Crowdfund proxy upgraded (tx ${tx.hash})`);
    addresses.EncryptedCrowdfund_Impl_secV2 = newCrowdfundAddr;
  } else {
    console.log("\n[1/2] EncryptedCrowdfund not deployed — skipping");
  }

  // ── Storefront A7 + A8 ────────────────────────────────────────────
  if (addresses.Storefront) {
    console.log("\n[2/2] Upgrading Storefront...");
    const Storefront = await hre.ethers.getContractFactory("Storefront");
    const newStorefrontImpl = await Storefront.deploy();
    await newStorefrontImpl.deploymentTransaction()?.wait(2);
    const newStorefrontAddr = await newStorefrontImpl.getAddress();
    console.log(`     ✓ New Storefront impl: ${newStorefrontAddr}`);

    const proxy = await hre.ethers.getContractAt(
      "Storefront",
      addresses.Storefront,
    );
    const tx = await proxy.upgradeToAndCall(newStorefrontAddr, "0x");
    await tx.wait(2);
    console.log(`     ✓ Storefront proxy upgraded (tx ${tx.hash})`);
    addresses.Storefront_Impl_secV2 = newStorefrontAddr;
  } else {
    console.log("\n[2/2] Storefront not deployed — skipping");
  }

  saveDeployment(networkName, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Done. Run `pnpm storage:check` to confirm baselines.");
  console.log("═══════════════════════════════════════════════════════════════");
});
