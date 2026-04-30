import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/**
 * PR-C steps 1+2 — UUPS upgrade FHERC20Vault and BusinessHub to add the
 * private invoice escrow surface.
 *
 *   FHERC20Vault: + `transferVerified(to, euint64)` (no new state)
 *   BusinessHub:  + `payInvoiceEscrow`, `releaseInvoiceEscrow`,
 *                 + `refundDisputedInvoice` (PR-A); appended state
 *                   `_invoiceEscrowHeld: mapping(uint256 => euint64)`
 *
 * Both changes are storage-additive — no existing slot is moved or
 * resized. The contracts package stores its layout snapshots in
 * `storage-layouts/` and the `pnpm storage:check` task asserts that
 * the new layout matches. This task runs that check FIRST and aborts
 * if anything has drifted.
 *
 * Operator runbook:
 *   1. Pull main, run `pnpm install`.
 *   2. Verify storage:  `pnpm --filter @blankpay/contracts storage:check`
 *      (must print "12 contract(s) match their snapshots").
 *   3. Pick a network (eth-sepolia or base-sepolia).
 *   4. Run this task:
 *        npx hardhat deploy-upgrade-invoice-escrow --network base-sepolia
 *      then again for the other chain.
 *   5. Verify the impl on Etherscan/Basescan (optional but recommended):
 *        npx hardhat verify --network base-sepolia <FHERC20Vault_Impl_v021_addr>
 *        npx hardhat verify --network base-sepolia <BusinessHub_Impl_v021_addr>
 *   6. Sanity-check on-chain: read getInvoice on an existing invoice id
 *      and confirm the call still succeeds (proves storage didn't shift).
 *   7. Update the frontend ABI in `packages/app/src/lib/abis.ts` (already
 *      done in PR-C step 3 — no action needed).
 *
 * No state migration required: the new escrow flow uses only the new
 * mapping. Existing invoices keep working via the legacy payInvoice +
 * payInvoiceFinalize path.
 *
 * Order matters — FHERC20Vault upgrades FIRST because BusinessHub's new
 * payInvoiceEscrow / releaseInvoiceEscrow code calls vault.transferVerified.
 * If you upgrade BusinessHub first against an old vault that lacks the
 * function, callers get an opaque revert.
 */

function deploymentFile(network: string): string {
  return path.join(__dirname, "..", "deployments", `${network}.json`);
}

function loadDeployment(network: string): Record<string, string> {
  const f = deploymentFile(network);
  if (!fs.existsSync(f)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const f = deploymentFile(network);
  fs.writeFileSync(f, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`[invoice-escrow] Deployment file updated: ${f}`);
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
  "deploy-upgrade-invoice-escrow",
  "PR-C — UUPS upgrade FHERC20Vault + BusinessHub to add the private invoice escrow surface.",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-invoice-escrow: unsupported network ${networkName}`,
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const addresses = loadDeployment(networkName);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PR-C — Invoice escrow upgrade (vault + BusinessHub)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer: ${await deployer.getAddress()}`);
  console.log(`  Network:  ${networkName}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!addresses.FHERC20Vault_USDC) {
    throw new Error(
      `[invoice-escrow] No FHERC20Vault_USDC in deployments/${networkName}.json`,
    );
  }
  if (!addresses.BusinessHub) {
    throw new Error(
      `[invoice-escrow] No BusinessHub address in deployments/${networkName}.json`,
    );
  }

  // Pre-flight storage check. The local storage-layouts/ snapshot is the
  // source of truth; if the deployed proxy's slots disagree with the new
  // impl's, an upgrade silently corrupts state. The CI task is the
  // gatekeeper — running it inline here gives the operator one less
  // command to forget.
  console.log("[invoice-escrow] Verifying storage layout (must be append-only)...");
  await hre.run("check-storage-layout", { check: true });
  console.log("[invoice-escrow] ✓ storage layout OK\n");

  // 1. FHERC20Vault first — BusinessHub's new code calls vault.transferVerified.
  console.log("Step 1/2 — Upgrading FHERC20Vault proxy in place...");
  const newVaultImpl = await upgradeInPlace(
    hre,
    "FHERC20Vault",
    addresses.FHERC20Vault_USDC,
  );
  addresses.FHERC20Vault_Impl_v021 = newVaultImpl;
  saveDeployment(networkName, addresses);

  // 2. BusinessHub — new escrow functions + storage slot for `_invoiceEscrowHeld`.
  console.log("\nStep 2/2 — Upgrading BusinessHub proxy in place...");
  const newBusinessHubImpl = await upgradeInPlace(
    hre,
    "BusinessHub",
    addresses.BusinessHub,
  );
  addresses.BusinessHub_Impl_v021 = newBusinessHubImpl;
  saveDeployment(networkName, addresses);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ✓ Upgrade complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  FHERC20Vault   impl: ", newVaultImpl);
  console.log("  BusinessHub    impl: ", newBusinessHubImpl);
  console.log("  (proxy addresses unchanged — no constants.ts change needed)");
  console.log("");
  console.log("  Sanity checks:");
  console.log("   • Read an existing invoice  : `businessHub.getInvoice(0)` — must succeed");
  console.log("   • Read vault balance handle : `vault.balanceOf(<addr>)`  — must succeed");
  console.log("   • Smoke a refund            : invoice mismatch path on testnet");
  console.log("");
  console.log("  Verify on the explorer (optional):");
  console.log(`   npx hardhat verify --network ${networkName} ${newVaultImpl}`);
  console.log(`   npx hardhat verify --network ${networkName} ${newBusinessHubImpl}`);
});
