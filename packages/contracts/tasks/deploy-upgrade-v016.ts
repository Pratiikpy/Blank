import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── v0.1.6 upgrade task ──────────────────────────────────────────────
// Three storage-safe UUPS in-place upgrades — all are NEW require()
// guards on existing expiry-style fields. No storage layout changes.
//
//   - GiftMoney (#241):   claimGift now reverts if the envelope's
//                         `expiryTimestamp` has passed. Advisory-only
//                         display isn't enough — block claims past the
//                         deadline on-chain.
//   - P2PExchange (#242): fillOffer tightened from `<=` to `<` on the
//                         offer expiry so a taker landing in the exact
//                         expiry second can no longer slip through.
//   - PaymentHub (#245):  sendPaymentAsAgent tightened from `<=` to `<`
//                         on the agent attestation expiry. Boundary-second
//                         replays are now rejected.
//
// Storage layouts for all three: snapshotted post-edit via `pnpm storage:write`
// and diffed by CI via `pnpm storage:check`. Expect zero removed/reordered
// slots; no new slots either (pure require-check upgrade).
//
// Run (human step — NOT part of this task-creation commit):
//   npx hardhat deploy-upgrade-v016 --network eth-sepolia
//   npx hardhat deploy-upgrade-v016 --network base-sepolia

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
  "deploy-upgrade-v016",
  "Upgrade contracts in place for v0.1.6 (#241 GiftMoney expiry enforcement, #242 P2PExchange strict expiry, #245 PaymentHub strict attestation expiry)",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — v0.1.6 On-Chain Expiry Hardening Upgrade");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("1/3  GiftMoney upgrade (#241 — claimGift expiry enforcement)...");
  const giftImpl = await upgradeInPlace(hre, "GiftMoney", addresses.GiftMoney);
  addresses.GiftMoney_Impl = giftImpl;

  console.log("\n2/3  P2PExchange upgrade (#242 — fillOffer strict expiry)...");
  const p2pImpl = await upgradeInPlace(hre, "P2PExchange", addresses.P2PExchange);
  addresses.P2PExchange_Impl = p2pImpl;

  console.log("\n3/3  PaymentHub upgrade (#245 — sendPaymentAsAgent strict expiry)...");
  const paymentHubImpl = await upgradeInPlace(hre, "PaymentHub", addresses.PaymentHub);
  addresses.PaymentHub_Impl = paymentHubImpl;

  saveDeployment(hre.network.name, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  v0.1.6 Upgrade Complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\n  Verify post-upgrade: storage layouts should still match");
  console.log("  the committed snapshots (pnpm storage:check).");
  console.log();
});
