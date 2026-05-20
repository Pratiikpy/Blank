import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// UUPS upgrade for Storefront — closes the winner-refund-pre-claim
// fund-loss exploit found in this session.
//
// Pre-fix: after revealWinner, the auction winner could call
// refundLoserBid(winningBidIdx) directly. Both bid.bidder == msg.sender
// and !bid.refunded passed, so the vault paid the bid back to the
// winner. The next claimAuctionWin reverted at !winningBid.refunded,
// leaving the seller permanently unpaid. Winner kept the bid + got the
// off-chain delivery.
//
// Post-fix: refundLoserBid adds
//     require(l.winner == address(0) ||
//             msg.sender != l.winner ||
//             bidIndex != _winningBidIdx[listingId], ...)
// which lets pre-reveal refunds through (no winner pinned yet) but
// blocks post-reveal extraction of the winning bid.
//
// Runtime-only change. `pnpm storage:check` passes; no storage layout
// changes. New test:
// Storefront.test.ts › "CRITICAL: winner cannot extract winning bid pre-claim".
//
// Usage:
//   npx hardhat deploy-upgrade-storefront-winner-refund --network eth-sepolia
//   npx hardhat deploy-upgrade-storefront-winner-refund --network base-sepolia

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
  console.log(`[storefront-winner-refund] Deployment file updated: ${filePath}`);
}

task(
  "deploy-upgrade-storefront-winner-refund",
  "UUPS upgrade Storefront to close winner-refund-pre-claim exploit",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-storefront-winner-refund: unsupported network ${networkName}`,
    );
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const addresses = loadDeployment(networkName);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Storefront winner-refund-pre-claim hardening");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer:    ${await deployer.getAddress()}`);
  console.log(`  Network:     ${networkName}`);
  console.log(`  Storefront:  ${addresses.Storefront ?? "(not deployed)"}`);
  console.log("═══════════════════════════════════════════════════════════════");

  if (!addresses.Storefront) {
    throw new Error(`No Storefront address in deployments/${networkName}.json`);
  }

  const Storefront = await hre.ethers.getContractFactory("Storefront");
  const newImpl = await Storefront.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddr = await newImpl.getAddress();
  console.log(`     ✓ New Storefront impl: ${newImplAddr}`);

  const proxy = await hre.ethers.getContractAt("Storefront", addresses.Storefront);
  const tx = await proxy.upgradeToAndCall(newImplAddr, "0x");
  await tx.wait(2);
  console.log(`     ✓ Storefront proxy upgraded (tx ${tx.hash})`);
  addresses.Storefront_Impl_winnerRefund = newImplAddr;

  saveDeployment(networkName, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Done. Run `pnpm storage:check` to confirm baselines.");
  console.log("═══════════════════════════════════════════════════════════════");
});
