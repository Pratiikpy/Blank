import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/**
 * Phase 4.1 — UUPS upgrade for BlankAccount.
 *
 * Adds: validator-dispatch path in `_validateSignature` + `enableValidator`
 * / `disableValidator` self-call functions + `enabledValidators` mapping
 * (slot 3, append-only). Storage invariance verified via
 * `pnpm hardhat check-storage-layout`.
 *
 * IMPORTANT — per-proxy upgrade flow (NOT factory-wide):
 *
 *   The BlankAccountFactory's `accountImplementation` field is `immutable`,
 *   so this task does NOT redeploy the factory. Instead:
 *
 *     1. Deploy a fresh BlankAccount IMPLEMENTATION here. Save the address
 *        to deployments JSON as `BlankAccount_Impl_v041`.
 *     2. Each existing user proxy has slot-0 (EIP-1967 _IMPLEMENTATION_SLOT)
 *        pointing at the OLD implementation. To pick up the new logic, each
 *        user must sign a UserOp calling `upgradeToAndCall(newImpl, "0x")`
 *        on their own proxy. The frontend triggers this in the
 *        ScheduledSends flow when a user opts into session keys.
 *     3. NEW users created via `factory.createAccount(...)` after this
 *        task runs still get proxies pointing at the OLD implementation
 *        (because `accountImplementation` is immutable in the factory).
 *        Their first session-key opt-in also triggers a UUPS self-upgrade.
 *
 *   Switching the factory's accountImplementation would require a NEW
 *   factory deployment, which would change every user's CREATE2 address →
 *   catastrophic for live users. We accept the per-proxy upgrade dance.
 *
 * Usage:
 *   npx hardhat deploy-upgrade-blankaccount-validator --network eth-sepolia
 *   npx hardhat deploy-upgrade-blankaccount-validator --network base-sepolia
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
  console.log(`[blankaccount-v041] Deployment file updated: ${filePath}`);
}

task(
  "deploy-upgrade-blankaccount-validator",
  "Phase 4.1 — Deploy new BlankAccount impl with validator dispatch",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-blankaccount-validator: unsupported network ${networkName}`,
    );
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const addresses = loadDeployment(networkName);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Phase 4.1 — BlankAccount validator-dispatch upgrade");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer: ${await deployer.getAddress()}`);
  console.log(`  Network:  ${networkName}`);
  console.log(`  Factory:  ${addresses.BlankAccountFactory ?? "(not deployed)"}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Constructor arg: EntryPoint v0.8 (same address every chain).
  const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

  console.log("Deploying new BlankAccount implementation...");
  const Factory = await hre.ethers.getContractFactory("BlankAccount");
  const newImpl = await Factory.deploy(ENTRYPOINT_V08);
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddress = await newImpl.getAddress();
  console.log(`  ✓ New impl: ${newImplAddress}`);

  // We do NOT redeploy the factory (its accountImplementation is immutable
  // and changing the factory would change every user's AA address).
  // Existing user proxies must self-upgrade via UUPS.
  addresses.BlankAccount_Impl_v041 = newImplAddress;
  saveDeployment(networkName, addresses);

  console.log("");
  console.log("Per-proxy upgrade flow (frontend integration):");
  console.log("  1. When a user opts into session keys (e.g. clicks 'Set up");
  console.log("     auto-pay' in ScheduledSends), check their proxy's");
  console.log("     EIP-1967 _IMPLEMENTATION_SLOT against the new impl");
  console.log(`     address (${newImplAddress}).`);
  console.log("  2. If mismatched, fire a UserOp calling `upgradeToAndCall(");
  console.log("     newImpl, \"0x\")` on their proxy, signed via passkey.");
  console.log("  3. After the upgrade tx mines, the proxy delegates to the");
  console.log("     new impl. Subsequent UserOps using validator-dispatch");
  console.log("     format (>64 byte sig) flow through `_validateSignature`'s");
  console.log("     new branch.");
  console.log("");
  console.log("  Helper: `cast call <proxy> \"_IMPLEMENTATION_SLOT()\"` — actually");
  console.log("  just read the slot directly: `cast storage <proxy>");
  console.log("  0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`");
  console.log("");
  console.log("Next steps after deploy:");
  console.log("  • Run `pnpm hardhat deploy-session-key-validator` to deploy");
  console.log("    the SessionKeyValidator (Phase 4.1 core, already shipped).");
  console.log("  • Update @blankpay/app/src/lib/constants.ts to add the new");
  console.log("    BlankAccount impl address per chain (for frontend version");
  console.log("    detection).");
  console.log("  • Build the ScheduledSends UI + Vercel cron (next session).");
});
