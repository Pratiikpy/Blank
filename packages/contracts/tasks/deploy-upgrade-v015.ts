import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── v0.1.5 upgrade task ──────────────────────────────────────────────
// Three storage-safe UUPS in-place upgrades (append-only state only).
//
//   - GiftMoney (#184):          Docstring-only change on deactivateEnvelope
//                                (Path B "irrevocable once sent" documented).
//                                No storage change — but re-deployed so the
//                                impl on-chain matches the source of truth.
//   - InheritanceManager (#185): finalizeClaim mutex via new append-only
//                                `claimFinalized[principal]` mapping.
//   - GroupManager (#187):       settleDebt per-edge same-block mutex via
//                                new append-only
//                                `lastSettleBlock[groupId][payer][payee]`
//                                mapping.
//
// Storage layouts for all three: snapshotted post-edit via `pnpm storage:write`
// and diffed by CI via `pnpm storage:check`. Expect zero removed/reordered
// slots; new mappings append at the end.
//
// Run (human step — NOT part of this task-creation commit):
//   npx hardhat deploy-upgrade-v015 --network eth-sepolia
//   npx hardhat deploy-upgrade-v015 --network base-sepolia

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
  "deploy-upgrade-v015",
  "Upgrade contracts in place for v0.1.5 (#184 GiftMoney docs, #185 InheritanceManager mutex, #187 GroupManager per-edge settle mutex)",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — v0.1.5 Mutex / Irrevocability Upgrade");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("1/3  GiftMoney upgrade (#184 — deactivateEnvelope docstring, Path B doc-only)...");
  const giftImpl = await upgradeInPlace(hre, "GiftMoney", addresses.GiftMoney);
  addresses.GiftMoney_Impl = giftImpl;

  console.log("\n2/3  InheritanceManager upgrade (#185 — finalizeClaim mutex)...");
  const inheritanceImpl = await upgradeInPlace(
    hre,
    "InheritanceManager",
    addresses.InheritanceManager,
  );
  addresses.InheritanceManager_Impl = inheritanceImpl;

  console.log("\n3/3  GroupManager upgrade (#187 — settleDebt per-edge same-block mutex)...");
  const groupImpl = await upgradeInPlace(hre, "GroupManager", addresses.GroupManager);
  addresses.GroupManager_Impl = groupImpl;

  saveDeployment(hre.network.name, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  v0.1.5 Upgrade Complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\n  Verify post-upgrade: storage layouts should still match");
  console.log("  the committed snapshots (pnpm storage:check).");
  console.log();
});
