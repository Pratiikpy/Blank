import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// UUPS upgrade for FHERC20Vault — combines two same-file fixes from this
// session:
//   #355 requestUnshield anti-overwrite: pre-fix, calling requestUnshield
//        again before the first claimUnshield landed silently replaced the
//        pending row, so a user who double-clicked / retried could lose
//        the first request entirely. The fix gates on pending == 0 and
//        rejects re-entry with a specific revert.
//   #356 uint64 cap on shield: pre-fix, shield() accepted a uint256
//        plaintext amount and silently truncated to uint64 inside FHE.
//        Anything over 2^64 was locked in the contract (underlying token
//        held, encrypted balance bumped by truncated bits only). The fix
//        adds `require(amount <= type(uint64).max, ...)` so callers know
//        to break large amounts into chunks.
//
// Append-only — `_ensureInitialized` also added a defensive zero init of
// the pending row but the storage slot was already reserved. `pnpm
// storage:check` passes.
//
// Vault is per-token (USDC, USDT) so we upgrade every FHERC20Vault_*
// deployment key in the addresses file.
//
// Usage:
//   npx hardhat deploy-upgrade-vault-unshield-uint64 --network eth-sepolia
//   npx hardhat deploy-upgrade-vault-unshield-uint64 --network base-sepolia

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
  console.log(`[vault-unshield-uint64] Deployment file updated: ${filePath}`);
}

task(
  "deploy-upgrade-vault-unshield-uint64",
  "UUPS upgrade every FHERC20Vault_* proxy — #355 anti-overwrite + #356 uint64 cap",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-vault-unshield-uint64: unsupported network ${networkName}`,
    );
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const addresses = loadDeployment(networkName);

  // Enumerate every FHERC20Vault PROXY (exclude impl addresses).
  // Deployment file has both proxies (FHERC20Vault_USDC, FHERC20Vault_USDT)
  // and historical impl references (FHERC20Vault_USDT_Impl,
  // FHERC20Vault_Impl_v021, FHERC20Vault_Impl_p1p2). Calling
  // upgradeToAndCall on an impl reverts — it's not a proxy.
  const vaultKeys = Object.keys(addresses).filter(
    (k) => k.startsWith("FHERC20Vault_") && !k.includes("_Impl") && !k.includes("Impl_"),
  );
  if (vaultKeys.length === 0) {
    throw new Error(`No FHERC20Vault_* keys in deployments/${networkName}.json`);
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  FHERC20Vault #355 anti-overwrite + #356 uint64 cap");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer:  ${await deployer.getAddress()}`);
  console.log(`  Network:   ${networkName}`);
  console.log(`  Vaults:    ${vaultKeys.length}`);
  for (const k of vaultKeys) console.log(`    ${k}: ${addresses[k]}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Deploy ONE new impl, reuse it for every vault proxy. UUPS-safe because
  // all FHERC20Vault proxies share the same impl bytecode + storage shape.
  const Vault = await hre.ethers.getContractFactory("FHERC20Vault");
  const newImpl = await Vault.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddr = await newImpl.getAddress();
  console.log(`     ✓ New FHERC20Vault impl: ${newImplAddr}`);

  for (const k of vaultKeys) {
    const proxyAddr = addresses[k];
    if (!proxyAddr) continue;
    const proxy = await hre.ethers.getContractAt("FHERC20Vault", proxyAddr);
    const tx = await proxy.upgradeToAndCall(newImplAddr, "0x");
    await tx.wait(2);
    console.log(`     ✓ ${k} upgraded (tx ${tx.hash})`);
  }
  addresses.FHERC20Vault_Impl_unshieldUint64 = newImplAddr;

  saveDeployment(networkName, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Done. Run `pnpm storage:check` to confirm baselines.");
  console.log("═══════════════════════════════════════════════════════════════");
});
