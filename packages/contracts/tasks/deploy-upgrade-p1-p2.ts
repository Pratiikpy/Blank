import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

/**
 * P1+P2 — UUPS upgrade rollout for the audit-pass hardening.
 *
 * What changed (per audit P1 + P2):
 *   • All 14 UUPS hubs:        + uint256[50] private __gap
 *   • BusinessHub:             SafeERC20 on every escrow underlying call
 *   • StealthPayments:         StealthFinalized event drops plaintextAmount
 *
 * Storage safety:
 *   The gap is the only storage append. It lands AFTER every existing state
 *   variable (placement immediately before _authorizeUpgrade). Pre-existing
 *   slots are unchanged — verified via storage-layouts/*.json.
 *
 *   `pnpm storage:check` runs first; if the on-disk snapshots disagree with
 *   the freshly-compiled layouts, the upgrade aborts before any tx fires.
 *
 * Order:
 *   FHERC20Vault first because BusinessHub's escrow paths call it. Then
 *   the rest, ordered roughly by dependency. EventHub last so existing
 *   activity emissions keep working all the way through.
 *
 * Per-contract gas (ballpark on Base Sepolia, observed 4M average):
 *   14 deployments × 4M × ~5 gwei × 2 chains  ≈  0.0006 ETH total.
 *   Deployer needs ~0.001 ETH on each chain to be safe.
 *
 * Operator runbook:
 *   1. `pnpm install`
 *   2. `pnpm --filter @blankpay/contracts storage:check`
 *      ↳ must print "12 contract(s) match their snapshots"
 *   3. `npx hardhat deploy-upgrade-p1-p2 --network base-sepolia`
 *   4. `npx hardhat deploy-upgrade-p1-p2 --network eth-sepolia`
 *   5. Smoke checks (read invoice, read vault balance, run a stealth send).
 */

const TARGETS: Array<{ contractName: string; deploymentKey: string }> = [
  // Vault first — escrow paths in BusinessHub call vault.transferVerified.
  { contractName: "FHERC20Vault", deploymentKey: "FHERC20Vault_USDC" },
  // Hubs that own the user-visible flows.
  { contractName: "BusinessHub", deploymentKey: "BusinessHub" },
  { contractName: "PaymentHub", deploymentKey: "PaymentHub" },
  { contractName: "GroupManager", deploymentKey: "GroupManager" },
  { contractName: "GiftMoney", deploymentKey: "GiftMoney" },
  { contractName: "StealthPayments", deploymentKey: "StealthPayments" },
  { contractName: "InheritanceManager", deploymentKey: "InheritanceManager" },
  { contractName: "P2PExchange", deploymentKey: "P2PExchange" },
  { contractName: "CreatorHub", deploymentKey: "CreatorHub" },
  { contractName: "PaymentReceipts", deploymentKey: "PaymentReceipts" },
  { contractName: "PrivacyRouter", deploymentKey: "PrivacyRouter" },
  { contractName: "TokenRegistry", deploymentKey: "TokenRegistry" },
  { contractName: "EncryptedFlags", deploymentKey: "EncryptedFlags" },
  // EventHub last — every other contract emits through it; if EventHub
  // upgrade fails for any reason the others still emit through the
  // pre-existing impl.
  { contractName: "EventHub", deploymentKey: "EventHub" },
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
  const f = deploymentFile(network);
  fs.writeFileSync(f, JSON.stringify(addresses, null, 2) + "\n");
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Treat RPC 502 / "Invalid JSON-RPC response" / network blips as
      // retryable. Anything else is likely a real revert and bubbles up.
      const retryable =
        msg.includes("Invalid JSON-RPC response") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("network error");
      if (!retryable || i === attempts) throw err;
      const backoff = 2_000 * Math.pow(2, i - 1);
      console.log(`     [retry] ${label} failed (${msg.slice(0, 80)}), waiting ${backoff}ms...`);
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
  "deploy-upgrade-p1-p2",
  "P1+P2 — upgrade all 14 UUPS hubs to the audit-hardened impls (gap + SafeERC20 + event change).",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(`deploy-upgrade-p1-p2: unsupported network ${networkName}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No signer configured");
  const deployerAddress = await deployer.getAddress();
  const provider = hre.ethers.provider;
  const balance = await provider.getBalance(deployerAddress);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  P1+P2 — UUPS audit-hardening upgrade rollout");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Network:  ${networkName}`);
  console.log(`  Deployer: ${deployerAddress}`);
  console.log(`  Balance:  ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`  Targets:  ${TARGETS.length} contracts`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (balance < hre.ethers.parseEther("0.001")) {
    throw new Error(
      `Deployer balance too low (${hre.ethers.formatEther(balance)} ETH). Top up to at least 0.001 ETH on ${networkName} before running.`,
    );
  }

  // Pre-flight: storage layouts must match. If they drifted, abort.
  console.log("Pre-flight — storage layout check...");
  await hre.run("check-storage-layout", { check: true });
  console.log("✓ storage layout OK\n");

  const addresses = loadDeployment(networkName);
  const results: Array<{ name: string; oldImpl: string; newImpl: string }> = [];

  for (let i = 0; i < TARGETS.length; i++) {
    const { contractName, deploymentKey } = TARGETS[i];
    const proxyAddress = addresses[deploymentKey];
    if (!proxyAddress) {
      console.log(`[${i + 1}/${TARGETS.length}] ${contractName}: NO PROXY ADDRESS in deployment file — skipping`);
      continue;
    }

    const implKey = `${contractName}_Impl_p1p2`;
    const oldImplKey = `${contractName}_Impl`;
    const oldImpl = addresses[oldImplKey] ?? addresses[implKey] ?? "(unknown)";

    // Idempotency: if a previous run already recorded a p1p2 impl for this
    // contract, skip. The operator can hand-edit the deployment file to
    // re-trigger a single upgrade if needed.
    if (addresses[implKey]) {
      console.log(`[${i + 1}/${TARGETS.length}] ${contractName} — already upgraded (${addresses[implKey]}), skipping`);
      results.push({ name: contractName, oldImpl, newImpl: addresses[implKey] });
      continue;
    }

    console.log(`[${i + 1}/${TARGETS.length}] ${contractName}`);
    console.log(`     proxy:    ${proxyAddress}`);
    try {
      const newImpl = await upgradeInPlace(hre, contractName, proxyAddress);
      console.log(`     new impl: ${newImpl}`);
      console.log(`     ✓ proxy upgraded\n`);
      addresses[implKey] = newImpl;
      saveDeployment(networkName, addresses);
      results.push({ name: contractName, oldImpl, newImpl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`     ✗ FAILED: ${msg}\n`);
      // Continue with the rest — partial rollout is recoverable; the
      // saved deployment file records progress.
    }
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Upgrade summary");
  console.log("═══════════════════════════════════════════════════════════════");
  for (const r of results) {
    console.log(`  ${r.name.padEnd(22)} -> ${r.newImpl}`);
  }
  console.log(`\n  ${results.length}/${TARGETS.length} contracts upgraded successfully.`);
  if (results.length < TARGETS.length) {
    console.log("  ⚠ Some upgrades failed — re-run the task to retry the leftovers.");
  }
});
