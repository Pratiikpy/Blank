import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/**
 * Phase 5.7 — UUPS upgrade BusinessHub to v0.2.0 with payInvoiceWithOracleQuote.
 *
 * Adds: oracle-attestation address state slot (14) + per-payer nonce
 * tracker (slot 15) + setOracleAttestationAddress + payInvoiceWithOracleQuote
 * + InvoicePaymentOracleSettled + OracleAddressUpdated events. Storage
 * append-only, verified via `pnpm hardhat check-storage-layout`.
 *
 * Operator runbook:
 *   1. Generate oracle keypair: `openssl rand -hex 32` → ORACLE_PRIVATE_KEY
 *      env in Vercel project settings (NOT branch-level).
 *   2. Derive the corresponding pubkey address. (`cast wallet address
 *      --private-key 0x<hex>` or any wallet tool.)
 *   3. Run this task to deploy the new impl + UUPS-upgrade the proxy.
 *   4. Call `businessHub.setOracleAttestationAddress(<oracle-pubkey>)`
 *      from the contract owner. (Hardhat console or a small follow-up
 *      task — kept outside this task because the address is operator-
 *      specific and shouldn't be hardcoded.)
 *   5. Update VITE_BLANK_<chain>_BUSINESS_HUB_IMPL_V020 in frontend env
 *      if version-detection ever needs it.
 *
 * Usage:
 *   npx hardhat deploy-upgrade-businesshub-v020 --network eth-sepolia
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
  console.log(`[bh-v020] Deployment file updated: ${filePath}`);
}

async function upgradeInPlace(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  proxyAddress: string,
): Promise<string> {
  console.log(`     proxy:    ${proxyAddress}`);
  const Factory = await hre.ethers.getContractFactory(contractName);
  const newImpl = await Factory.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddress = await newImpl.getAddress();
  console.log(`     new impl: ${newImplAddress}`);

  const proxy = Factory.attach(proxyAddress);
  const tx = await (proxy as any).upgradeToAndCall(newImplAddress, "0x");
  await tx.wait(2);
  console.log(`     ✓ proxy upgraded`);
  return newImplAddress;
}

task(
  "deploy-upgrade-businesshub-v020",
  "Phase 5.7 — UUPS upgrade BusinessHub to v0.2.0 (signed-oracle fallback).",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-businesshub-v020: unsupported network ${networkName}`,
    );
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const addresses = loadDeployment(networkName);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Phase 5.7 — BusinessHub v0.2.0 upgrade (oracle fallback)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer: ${await deployer.getAddress()}`);
  console.log(`  Network:  ${networkName}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!addresses.BusinessHub) {
    throw new Error(
      `[bh-v020] No existing BusinessHub address in deployments/${networkName}.json`,
    );
  }

  console.log("Upgrading BusinessHub proxy in place...");
  const newImpl = await upgradeInPlace(hre, "BusinessHub", addresses.BusinessHub);
  addresses.BusinessHub_Impl_v020 = newImpl;
  saveDeployment(networkName, addresses);

  console.log("");
  console.log("✓ Upgrade complete. Next steps:");
  console.log("  1. Set the oracle attestation address:");
  console.log("     `businessHub.setOracleAttestationAddress(<oracle-pubkey>)`");
  console.log("     (call as the contract owner from hardhat console).");
  console.log("  2. Set ORACLE_PRIVATE_KEY in Vercel project env (matching pubkey).");
  console.log("  3. Allowlist any extra testnet pay-tokens in");
  console.log("     `packages/app/api/oracle/quote.ts` ALLOWED_PAY_TOKENS map.");
  console.log("");
  console.log("  ⚠ OPERATIONAL FLOAT REQUIREMENT:");
  console.log("  The oracle-fallback path pays vendors in USDC out of THIS");
  console.log("  contract's plaintext USDC balance — fund it before the first");
  console.log("  call. Each fire pulls the payer's payToken into the contract;");
  console.log("  use `withdrawAccumulated(payToken, treasury, amount)` to sweep");
  console.log("  it back out periodically and top USDC up. Without this top-up,");
  console.log("  every payInvoiceWithOracleQuote will revert with INSUFFICIENT");
  console.log("  TRANSFER on the vendor-USDC step.");
  console.log("");
  console.log("  4. Frontend integration: BusinessTools.tsx Pay-invoice modal");
  console.log("     gains a third path 'Pay with oracle-quoted token' alongside");
  console.log("     the existing Uniswap-swap toggle. Defer to a follow-up.");
});
