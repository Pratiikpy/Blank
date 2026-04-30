import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/**
 * Phase 5.6 — UUPS upgrade BusinessHub to v0.1.9 with `payInvoiceWithSwap`.
 *
 * What's new:
 *  - Adds the `payInvoiceWithSwap` external function for token-agnostic
 *    invoice settlement (caller pays in any ERC-20, contract swaps via
 *    Uniswap v3 SwapRouter02 to USDC, transfers USDC to vendor).
 *  - Adds the `InvoicePaymentSwapped` event.
 *  - Imports `SafeERC20`; declares `using SafeERC20 for IERC20`.
 *  - NO storage layout changes — verified via `pnpm hardhat check-storage-layout`.
 *
 * Storage layout invariance: 14 slots (0-13), unchanged from v0.1.8.
 * The new function reads existing state and parameterizes the swap router
 * address per-call — frontend supplies UNISWAP_SWAP_ROUTER_02[chainId]
 * from `lib/uniswap.ts` (already shipped in Phase 4.2 + 5.4).
 *
 * Usage:
 *   npx hardhat deploy-upgrade-businesshub-v019 --network eth-sepolia
 *   npx hardhat deploy-upgrade-businesshub-v019 --network base-sepolia
 */

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`[upgrade-v019] Deployment file updated: ${filePath}`);
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
  "deploy-upgrade-businesshub-v019",
  "Phase 5.6 — UUPS upgrade BusinessHub to v0.1.9 (payInvoiceWithSwap).",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(
      `deploy-upgrade-businesshub-v019: unsupported network ${networkName} (expected eth-sepolia | base-sepolia)`,
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured for this network");
  const addresses = loadDeployment(networkName);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Phase 5.6 — BusinessHub v0.1.9 upgrade");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Deployer: ${await deployer.getAddress()}`);
  console.log(`  Network:  ${networkName}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!addresses.BusinessHub) {
    throw new Error(
      `[upgrade-v019] No existing BusinessHub address in deployments/${networkName}.json — run base deploy first`,
    );
  }

  console.log("Upgrading BusinessHub proxy in place...");
  const newImpl = await upgradeInPlace(hre, "BusinessHub", addresses.BusinessHub);
  addresses.BusinessHub_Impl_v019 = newImpl;
  saveDeployment(networkName, addresses);

  console.log("");
  console.log("✓ Upgrade complete. Frontend integration:");
  console.log("  • Update useBusinessHub.ts with `payInvoiceWithSwap` wrapper that");
  console.log("    reads UNISWAP_SWAP_ROUTER_02[chainId] from lib/uniswap.ts and");
  console.log("    passes it to the new contract method.");
  console.log("  • Update BusinessTools/Pay screen with a 'Pay in different token'");
  console.log("    toggle that surfaces the swap quote + slippage knob.");
  console.log("  • Document the privacy trade-off in UI copy ('amount briefly");
  console.log("    visible during transit').");
});
