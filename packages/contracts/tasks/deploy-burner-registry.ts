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
 * Once deployed, the frontend can:
 *   1. Encrypt burner metadata client-side using a key derived from the
 *      user's passkey (Phase 6.2 frontend follow-up).
 *   2. Call `setMetadata(burnerAddress, encryptedBlob)` via the existing
 *      `useUnifiedWrite` abstraction.
 *   3. Recover the burner list on a fresh device by streaming the
 *      `MetadataSet` event log filtered by the user's main address.
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
  console.log(`Next steps (frontend follow-up):`);
  console.log(`  1. Add BurnerRegistry to lib/constants.ts CONTRACTS_BY_CHAIN.`);
  console.log(`  2. Build src/lib/burner-registry.ts:`);
  console.log(`       - deriveKey(passkey) → AES-GCM key`);
  console.log(`       - encryptBlob(metadata, key) → bytes`);
  console.log(`       - publishMetadata(burnerAddr, blob)`);
  console.log(`       - recoverBurnersFromEvents(ownerAddr) → BurnerRecord[]`);
  console.log(`  3. Wire into Burners.tsx as an opt-in 'Back up to chain' button.`);
});
