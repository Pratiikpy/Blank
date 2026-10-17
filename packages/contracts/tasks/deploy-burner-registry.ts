import { task } from "hardhat/config";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-burner-registry — Phase 6.2 deploy.
 *
 * Deploys the standalone `BurnerRegistry` contract and persists its
 * address to `deployments/<network>.json`. The contract is intentionally
 * non-upgradeable (no proxy) — see contract-level NatSpec for the
 * rationale.
 *
 * v2 keys records by (owner, tag), never by burner address. The frontend
 * (src/lib/burner-registry.ts):
 *   1. Encrypts { id, salt, label, burner, createdAt } with a passphrase key.
 *   2. Derives tag = HMAC(passphrase key, burnerId) and calls
 *      `setMetadata(tag, encryptedBlob)` through useUnifiedWrite.
 *   3. Recovers on a fresh device from `BackupSet` / `BackupCleared` logs
 *      filtered by the main address.
 *
 * v1 deployments published owner -> burner links in event topics; retire
 * them by pointing constants.ts at the new address.
 *
 * Usage:
 *   npx hardhat deploy-burner-registry --network eth-sepolia
 *   npx hardhat deploy-burner-registry --network base-sepolia
 */
task(
  "deploy-burner-registry",
  "Deploy BurnerRegistry and persist address to deployments JSON",
).setAction(async (_args, hre) => {
  const networkName = hre.network.name;
  const deploymentFile =
    networkName === "base-sepolia"
      ? "base-sepolia.json"
      : networkName === "eth-sepolia"
        ? "eth-sepolia.json"
        : networkName === "arb-sepolia"
          ? "arb-sepolia.json"
          : null;
  if (!deploymentFile) {
    throw new Error(
      `deploy-burner-registry: unsupported network ${networkName} (expected eth-sepolia | base-sepolia | arb-sepolia)`,
    );
  }
  const deploymentPath = resolve(__dirname, "..", "deployments", deploymentFile);

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer configured");
  const deployerAddress = await deployer.getAddress();
  console.log(`[burner-registry] Network:  ${networkName}`);
  console.log(`[burner-registry] Deployer: ${deployerAddress}`);

  const Factory = await hre.ethers.getContractFactory("BurnerRegistry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();
  const address = await registry.getAddress();

  console.log(`[burner-registry] ✓ Deployed at ${address}`);

  // Persist to deployments JSON, append-only (don't overwrite other entries).
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(deploymentPath, "utf8"));
  } catch (err) {
    console.warn(
      `[burner-registry] deployments file ${deploymentFile} not readable; creating new one. Inner: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const next = { ...existing, BurnerRegistry: address };
  writeFileSync(deploymentPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`[burner-registry] ✓ Wrote address to ${deploymentFile}`);

  console.log(``);
  console.log(`Next step: set BurnerRegistry in packages/app/src/lib/constants.ts for this chain.`);
});
