import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── InheritanceManager CEI upgrade ───────────────────────────────────
// Audit Top-28 #13: hardens finalizeClaim by setting BOTH plan.active=false
// AND claimFinalized[owner_]=true BEFORE the vault-transfer loop. Previously
// claimFinalized was stamped after transfers, which left the secondary
// mutex unset during the cross-contract calls. plan.active=false already
// served as the primary mutex (and the nonReentrant modifier covers ERC-20
// reentrancy generally), so this is defence-in-depth: independent of
// nonReentrant, the !claimFinalized check at function entry now blocks
// reentry too.
//
// Storage layout: unchanged (purely runtime reorder of existing writes).
// Verified via `pnpm storage:check` before this task.
//
// Run (human step):
//   npx hardhat deploy-upgrade-inheritance-cei --network eth-sepolia
//   npx hardhat deploy-upgrade-inheritance-cei --network base-sepolia

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
  "deploy-upgrade-inheritance-cei",
  "UUPS upgrade InheritanceManager — CEI fix (audit Top-28 #13)",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — InheritanceManager CEI Upgrade");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!addresses.InheritanceManager) {
    throw new Error(`InheritanceManager proxy not in deployments/${hre.network.name}.json`);
  }

  console.log("InheritanceManager upgrade (audit Top-28 #13 — CEI ordering)...");
  const newImpl = await upgradeInPlace(
    hre,
    "InheritanceManager",
    addresses.InheritanceManager,
  );
  addresses.InheritanceManager_Impl = newImpl;

  saveDeployment(hre.network.name, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Upgrade complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\n  Post-deploy: pnpm storage:check should still pass (no layout change).");
  console.log();
});
