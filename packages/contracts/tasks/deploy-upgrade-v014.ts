import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── v0.1.4 upgrade task ──────────────────────────────────────────────
// Architectural overhaul (Round 2 audit fixes). All storage-safe in-place
// UUPS upgrades. Specifically:
//
//   - PaymentHub:        #84 fulfillRequest now bumps global aggregate
//                        #131 RequestFulfilled event adds indexed vault
//   - PaymentReceipts:   #92 bumpUserReceived + bumpGlobal aliases
//                        #91 ProofPublished event after publishProof
//   - BusinessHub:       #92 paymentReceipts wiring + setPaymentReceipts setter
//                        Appends ONE storage slot (paymentReceipts address).
//                        Storage layout snapshot validated separately.
//   - GroupManager:      #87 settleDebt updates by ACTUAL transferred + clamps
//                        DebtSettledEncrypted event with encrypted actual
//   - PrivacyRouter:     #93 cancelSwap reordering (transfer → state → events)
//
// All other contracts unchanged this round.
//
// Run:
//   npx hardhat deploy-upgrade-v014 --network eth-sepolia
//   npx hardhat deploy-upgrade-v014 --network base-sepolia
//
// Then run setup-receipts to wire PaymentReceipts authorization for BusinessHub.

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
  "deploy-upgrade-v014",
  "Upgrade contracts in place for the v0.1.4 architectural overhaul (#84, #87, #91, #92, #93, #131)",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — v0.1.4 Architectural Upgrade");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("1/5  PaymentHub upgrade (fulfillRequest aggregate + RequestFulfilled.vault)...");
  const paymentHubImpl = await upgradeInPlace(hre, "PaymentHub", addresses.PaymentHub);
  addresses.PaymentHub_Impl = paymentHubImpl;

  console.log("\n2/5  PaymentReceipts upgrade (bumpUserReceived + ProofPublished event)...");
  const receiptsImpl = await upgradeInPlace(hre, "PaymentReceipts", addresses.PaymentReceipts);
  addresses.PaymentReceipts_Impl = receiptsImpl;

  console.log("\n3/5  BusinessHub upgrade (paymentReceipts wiring — APPEND-ONLY storage)...");
  const businessImpl = await upgradeInPlace(hre, "BusinessHub", addresses.BusinessHub);
  addresses.BusinessHub_Impl = businessImpl;

  console.log("\n4/5  GroupManager upgrade (settleDebt actual-amount accounting)...");
  const groupImpl = await upgradeInPlace(hre, "GroupManager", addresses.GroupManager);
  addresses.GroupManager_Impl = groupImpl;

  console.log("\n5/5  PrivacyRouter upgrade (cancelSwap ordering fix)...");
  const routerImpl = await upgradeInPlace(hre, "PrivacyRouter", addresses.PrivacyRouter);
  addresses.PrivacyRouter_Impl = routerImpl;

  saveDeployment(hre.network.name, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  v0.1.4 Upgrade Complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\n  Next step: run `npx hardhat setup-receipts --network " + hre.network.name + "`");
  console.log("  to authorize BusinessHub on PaymentReceipts (enables payroll income proofs).");
  console.log();
});
