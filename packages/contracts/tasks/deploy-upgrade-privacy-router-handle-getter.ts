import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// UUPS upgrade for PrivacyRouter — adds the missing
// `getEncryptedAmountIn(swapId)` view function. Without this getter,
// keepers (and tests) have no way to retrieve the ctHash of a pending
// swap to off-chain-decrypt via cofhe-sdk and produce the
// (plaintext, signature) bundle that executeSwap / cancelSwap (immediate
// refund branch) / claimCancelledSwap / claimExpiredSwap all require.
// Effectively the async-decrypt path was unreachable in production.
//
// Code change: append-only public view function. No storage change.
// `pnpm storage:check` confirms baselines unchanged.
//
// Usage:
//   npx hardhat deploy-upgrade-privacy-router-handle-getter --network eth-sepolia
//   npx hardhat deploy-upgrade-privacy-router-handle-getter --network base-sepolia

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
  console.log(`[privacy-router-handle-getter] Deployment file updated: ${filePath}`);
}

task(
  "deploy-upgrade-privacy-router-handle-getter",
  "UUPS upgrade PrivacyRouter to expose getEncryptedAmountIn view",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-privacy-router-handle-getter: unsupported network ${networkName}`,
    );
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const addresses = loadDeployment(networkName);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PrivacyRouter getEncryptedAmountIn view");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer:        ${await deployer.getAddress()}`);
  console.log(`  Network:         ${networkName}`);
  console.log(`  PrivacyRouter:   ${addresses.PrivacyRouter ?? "(not deployed)"}`);
  console.log("═══════════════════════════════════════════════════════════════");

  if (!addresses.PrivacyRouter) {
    throw new Error(`No PrivacyRouter address in deployments/${networkName}.json`);
  }

  const PrivacyRouter = await hre.ethers.getContractFactory("PrivacyRouter");
  const newImpl = await PrivacyRouter.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddr = await newImpl.getAddress();
  console.log(`     ✓ New PrivacyRouter impl: ${newImplAddr}`);

  const proxy = await hre.ethers.getContractAt("PrivacyRouter", addresses.PrivacyRouter);
  const tx = await proxy.upgradeToAndCall(newImplAddr, "0x");
  await tx.wait(2);
  console.log(`     ✓ PrivacyRouter proxy upgraded (tx ${tx.hash})`);
  addresses.PrivacyRouter_Impl_handleGetter = newImplAddr;

  saveDeployment(networkName, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Done. Run `pnpm storage:check` to confirm baselines.");
  console.log("═══════════════════════════════════════════════════════════════");
});
