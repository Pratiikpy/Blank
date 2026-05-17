import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/**
 * Gas-wallet UUPS upgrade for BlankAccount.
 *
 * Adds three runtime-only functions (no new storage slots):
 *   • receive() auto-deposits incoming ETH to EntryPoint
 *   • topUpGas — permissionless manual fallback for idle balance
 *   • withdrawGasDepositTo — owner-gated EntryPoint withdrawal
 *
 * Storage layout invariance: verified via `pnpm hardhat
 * check-storage-layout`. All four existing slots (ownerX/ownerY/
 * recoveryModule/enabledValidators) preserved verbatim.
 *
 * Per-proxy upgrade flow (same shape as v041):
 *
 *   1. Deploy fresh BlankAccount IMPLEMENTATION here. Save as
 *      `BlankAccount_Impl_gasWallet` in deployments JSON.
 *   2. Each existing user proxy points at the OLD impl. To pick up
 *      the new receive() + topUpGas + withdrawGasDepositTo, the user
 *      signs a UserOp calling `upgradeToAndCall(newImpl, "0x")` on
 *      their own proxy. The frontend prompts this in the Gas wallet
 *      panel when the user first opens it ("upgrade to enable
 *      self-paid gas").
 *   3. NEW users created via factory after this task runs ALSO get
 *      the old impl (factory's accountImplementation is immutable).
 *      Their first paymaster-funded UserOp can chain an automatic
 *      self-upgrade.
 *
 *   The frontend version-detection helper reads the EIP-1967 impl
 *   slot:
 *     `cast storage <proxy> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`
 *
 * Usage:
 *   npx hardhat deploy-upgrade-blankaccount-gas-wallet --network eth-sepolia
 *   npx hardhat deploy-upgrade-blankaccount-gas-wallet --network base-sepolia
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
  console.log(`[gas-wallet] Deployment file updated: ${filePath}`);
}

task(
  "deploy-upgrade-blankaccount-gas-wallet",
  "Deploy BlankAccount impl with receive() auto-deposit + topUpGas + withdrawGasDepositTo",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-blankaccount-gas-wallet: unsupported network ${networkName}`,
    );
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const addresses = loadDeployment(networkName);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BlankAccount gas-wallet upgrade (receive() auto-deposit)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer: ${await deployer.getAddress()}`);
  console.log(`  Network:  ${networkName}`);
  console.log(`  Factory:  ${addresses.BlankAccountFactory ?? "(not deployed)"}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Constructor arg: canonical EntryPoint v0.8 (same address every chain).
  const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

  console.log("Deploying new BlankAccount implementation...");
  const Factory = await hre.ethers.getContractFactory("BlankAccount");
  const newImpl = await Factory.deploy(ENTRYPOINT_V08);
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddress = await newImpl.getAddress();
  console.log(`  ✓ New impl: ${newImplAddress}`);

  // Factory's accountImplementation is immutable — same constraint as v041.
  // Existing user proxies self-upgrade via UUPS.
  addresses.BlankAccount_Impl_gasWallet = newImplAddress;
  saveDeployment(networkName, addresses);

  console.log("");
  console.log("Per-proxy upgrade flow (frontend integration):");
  console.log("  1. Read the user's proxy EIP-1967 _IMPLEMENTATION_SLOT.");
  console.log(`  2. If != ${newImplAddress}, prompt the user to upgrade in the`);
  console.log("     Gas wallet panel. Their passkey signs a UserOp calling");
  console.log("     `upgradeToAndCall(newImpl, \"0x\")` on their own proxy.");
  console.log("  3. After mine, receive() auto-deposits any future ETH; the");
  console.log("     Copy address CTA becomes meaningful (deposit from CEX,");
  console.log("     hardware wallet, anywhere — auto-credit gas).");
  console.log("");
  console.log("Next steps after deploy:");
  console.log("  • Update packages/app/src/lib/constants.ts to add");
  console.log("    `BlankAccount_Impl_gasWallet` per chain (for the frontend");
  console.log("    version-detection that prompts the upgrade).");
  console.log("  • Update packages/app/api/_lib/addresses.ts to mirror the");
  console.log("    same field if any server-side route needs it.");
  console.log("  • Run `pnpm storage:check` to confirm baselines still match.");
});
