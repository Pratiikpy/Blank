import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── UUPS upgrade: CreatorHub + P2PExchange ─────────────────────────────
//
// Both contracts deployed on base-sepolia revert with InvalidSigner when a
// user submits an encrypted UserOp through them, even after the CoFHE
// permits.createSelf warmup runs successfully (confirmed by Phase 7
// recipient-send-back passing end-to-end on PaymentHub with the same
// warmup). The source for CreatorHub.support and P2PExchange.fillOffer is
// structurally identical to PaymentHub.sendPayment (same FHE.asEuint64 +
// transferFromVerified pattern), so the most plausible remaining cause is
// that the deployed impls are stale and don't match the current source.
//
// This upgrade swaps each proxy's implementation to a freshly-deployed
// bytecode. No storage changes, no re-init, empty calldata — the safest
// possible UUPS upgrade.

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
  const tx = await (proxy as any).upgradeToAndCall(newImplAddress, "0x");
  await tx.wait(2);
  console.log(`     ✓ upgraded`);
  return newImplAddress;
}

task(
  "deploy-upgrade-creator-p2p",
  "UUPS upgrade CreatorHub + P2PExchange to latest compiled bytecode (fixes InvalidSigner when deployed impls are stale).",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — CreatorHub + P2PExchange impl refresh");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!addresses.CreatorHub) {
    console.log("CreatorHub — SKIP (not deployed on this network)");
  } else {
    console.log("1/2  CreatorHub upgrade...");
    const impl = await upgradeInPlace(hre, "CreatorHub", addresses.CreatorHub);
    addresses.CreatorHub_Impl = impl;
  }

  if (!addresses.P2PExchange) {
    console.log("\nP2PExchange — SKIP (not deployed on this network)");
  } else {
    console.log("\n2/2  P2PExchange upgrade...");
    const impl = await upgradeInPlace(hre, "P2PExchange", addresses.P2PExchange);
    addresses.P2PExchange_Impl = impl;
  }

  saveDeployment(hre.network.name, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ✓ Upgrade complete");
  console.log("═══════════════════════════════════════════════════════════════");
});
