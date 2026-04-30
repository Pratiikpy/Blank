import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/**
 * P5 — second-pass UUPS upgrade for the contract-side audit hardening.
 *
 * What changed (per audit P2 — contract-only items):
 *   • BusinessHub:
 *     - approvedSwapRouters mapping + setSwapRouterApproved (P2.10)
 *     - createInvoice / createEscrow description length cap (P2.15)
 *     - oracle quote derivedOut == expectedUsdcOut (drop ±1 tolerance) (P2.16)
 *     - storage append: gap shrunk from [50] to [49]
 *   • InheritanceManager:
 *     - setVaults max-vaults cap (≤ 20) to prevent claim-lockout via
 *       gas-limit (P2.14)
 *
 * Storage safety:
 *   BusinessHub appends `approvedSwapRouters` immediately before its gap
 *   and shrinks the gap from 50 → 49. Pre-existing slots are unchanged;
 *   the new mapping lands at the slot the gap previously occupied. Verified
 *   via storage-layouts/BusinessHub.json.
 *
 *   InheritanceManager has no storage change; the cap is enforced in the
 *   setVaults function only.
 *
 * Post-upgrade seeding:
 *   The new `approvedSwapRouters` mapping starts empty — `payInvoiceWithSwap`
 *   will revert "router not approved" until the owner calls
 *   `setSwapRouterApproved(uniswapV3Router, true)`. This task seeds the
 *   canonical Uniswap v3 SwapRouter02 address per chain so existing
 *   swap-pay flows keep working immediately post-upgrade.
 */

const UNISWAP_V3_SWAP_ROUTER_02: Record<string, string> = {
  "eth-sepolia": "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  "base-sepolia": "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
};

const TARGETS: Array<{ contractName: string; deploymentKey: string }> = [
  { contractName: "BusinessHub", deploymentKey: "BusinessHub" },
  { contractName: "InheritanceManager", deploymentKey: "InheritanceManager" },
];

function deploymentFile(network: string): string {
  return path.join(__dirname, "..", "deployments", `${network}.json`);
}

function loadDeployment(network: string): Record<string, string> {
  const f = deploymentFile(network);
  if (!fs.existsSync(f)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  fs.writeFileSync(deploymentFile(network), JSON.stringify(addresses, null, 2) + "\n");
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        msg.includes("Invalid JSON-RPC response") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("network error");
      if (!retryable || i === attempts) throw err;
      const backoff = 2_000 * Math.pow(2, i - 1);
      console.log(`     [retry] ${label} (${msg.slice(0, 80)}), waiting ${backoff}ms...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function upgradeInPlace(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  proxyAddress: string,
): Promise<string> {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const newImpl = await withRetry(`${contractName} deploy`, async () => {
    const c = await Factory.deploy();
    await c.deploymentTransaction()?.wait(2);
    return c;
  });
  const newImplAddress = await newImpl.getAddress();
  const proxy = Factory.attach(proxyAddress);
  await withRetry(`${contractName} upgradeToAndCall`, async () => {
    const tx = await (proxy as any).upgradeToAndCall(newImplAddress, "0x");
    await tx.wait(2);
  });
  return newImplAddress;
}

task(
  "deploy-upgrade-p5",
  "P5 — second-pass UUPS upgrade for audit P2 contract items (BusinessHub + InheritanceManager).",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(`deploy-upgrade-p5: unsupported network ${networkName}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  P5 — second-pass UUPS upgrade (BusinessHub + InheritanceManager)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Network:  ${networkName}`);
  console.log(`  Deployer: ${deployerAddress}`);
  console.log(`  Balance:  ${hre.ethers.formatEther(balance)} ETH`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (balance < hre.ethers.parseEther("0.0005")) {
    throw new Error(
      `Deployer balance too low (${hre.ethers.formatEther(balance)} ETH). Top up to 0.0005 ETH.`,
    );
  }

  console.log("Pre-flight — storage layout check...");
  await hre.run("check-storage-layout", { check: true });
  console.log("✓ storage layout OK\n");

  const addresses = loadDeployment(networkName);
  const results: Array<{ name: string; newImpl: string }> = [];

  for (let i = 0; i < TARGETS.length; i++) {
    const { contractName, deploymentKey } = TARGETS[i];
    const proxy = addresses[deploymentKey];
    if (!proxy) {
      console.log(`[${i + 1}/${TARGETS.length}] ${contractName}: NO PROXY — skipping`);
      continue;
    }
    const implKey = `${contractName}_Impl_p5`;
    if (addresses[implKey]) {
      console.log(`[${i + 1}/${TARGETS.length}] ${contractName} — already upgraded (${addresses[implKey]}), skipping`);
      results.push({ name: contractName, newImpl: addresses[implKey] });
      continue;
    }
    console.log(`[${i + 1}/${TARGETS.length}] ${contractName}`);
    console.log(`     proxy:    ${proxy}`);
    try {
      const newImpl = await upgradeInPlace(hre, contractName, proxy);
      console.log(`     new impl: ${newImpl}`);
      console.log(`     ✓ proxy upgraded\n`);
      addresses[implKey] = newImpl;
      saveDeployment(networkName, addresses);
      results.push({ name: contractName, newImpl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`     ✗ FAILED: ${msg}\n`);
    }
  }

  // Post-upgrade: seed the BusinessHub swap-router allowlist with the
  // canonical Uniswap v3 SwapRouter02 for this chain. Without this,
  // payInvoiceWithSwap reverts "router not approved" on every call.
  const seedKey = `BusinessHub_RouterApproved_${networkName}`;
  if (addresses[seedKey]) {
    console.log(`Skipping router seed — already done (${addresses[seedKey]})`);
  } else {
    const router = UNISWAP_V3_SWAP_ROUTER_02[networkName];
    if (router && addresses.BusinessHub) {
      console.log(`Seeding swap-router allowlist with Uniswap v3 SwapRouter02 ${router}...`);
      try {
        const Factory = await hre.ethers.getContractFactory("BusinessHub");
        const proxy = Factory.attach(addresses.BusinessHub);
        await withRetry("setSwapRouterApproved", async () => {
          const tx = await (proxy as any).setSwapRouterApproved(router, true);
          await tx.wait(2);
        });
        console.log(`✓ Approved ${router}\n`);
        addresses[seedKey] = router;
        saveDeployment(networkName, addresses);
      } catch (err) {
        console.error(`✗ Router seed failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  ${results.length}/${TARGETS.length} upgraded successfully.`);
  for (const r of results) console.log(`  ${r.name.padEnd(22)} -> ${r.newImpl}`);
});
