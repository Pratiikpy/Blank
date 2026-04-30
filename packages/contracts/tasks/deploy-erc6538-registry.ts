import { task } from "hardhat/config";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-erc6538-registry — Phase 9 deploy.
 *
 * Strategy (in order of preference):
 *
 *   1. Probe the canonical EIP-6538 singleton at
 *      `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`. The Umbra/Fluidkey
 *      ecosystem deployed this same address across every supported chain
 *      (mainnet, sepolia, base, base-sepolia, arbitrum, optimism, polygon,
 *      gnosis). If it has code, RECORD it and exit — every wallet/indexer
 *      that supports stealth meta-addresses already knows this address,
 *      so using it gives us out-of-the-box interop with zero coordination.
 *
 *   2. If the canonical address has no code on this chain (defensive — at
 *      time of writing both eth-sepolia and base-sepolia DO have it), fall
 *      back to a plain deploy of our local artifact.
 *
 * Idempotent: re-running on a chain that already has the canonical
 * singleton recorded simply re-writes the same address.
 *
 * Usage:
 *   npx hardhat deploy-erc6538-registry --network eth-sepolia
 *   npx hardhat deploy-erc6538-registry --network base-sepolia
 */
const CANONICAL_SINGLETON = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";

task(
  "deploy-erc6538-registry",
  "Record the canonical ERC-6538 singleton (or deploy locally if absent).",
).setAction(async (_args, hre) => {
  const networkName = hre.network.name;
  const deploymentFile =
    networkName === "base-sepolia"
      ? "base-sepolia.json"
      : networkName === "eth-sepolia"
        ? "eth-sepolia.json"
        : null;
  if (!deploymentFile) {
    throw new Error(
      `deploy-erc6538-registry: unsupported network ${networkName} (expected eth-sepolia | base-sepolia)`,
    );
  }
  const deploymentPath = resolve(__dirname, "..", "deployments", deploymentFile);

  const provider = hre.ethers.provider;
  console.log(`[erc6538] Network: ${networkName}`);

  const canonicalCode = await provider.getCode(CANONICAL_SINGLETON);
  if (canonicalCode && canonicalCode !== "0x") {
    console.log(
      `[erc6538] ✓ Canonical singleton present at ${CANONICAL_SINGLETON} ` +
        `(${(canonicalCode.length - 2) / 2} bytes). Recording.`,
    );
    await persist(deploymentPath, deploymentFile, CANONICAL_SINGLETON);
    return;
  }

  // Defensive fallback. Deploys our local artifact and records that address.
  // Wallets that hardcode `0x6538…6538` won't find us, so this is a
  // less-than-ideal outcome that should only happen on chains the upstream
  // ecosystem hasn't reached yet.
  console.warn(
    `[erc6538] Canonical singleton ${CANONICAL_SINGLETON} has no code on ` +
      `${networkName}. Falling back to a non-canonical local deploy. ` +
      `Wallet/indexer interop will require advertising the deployed address.`,
  );

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer configured");
  const Factory = await hre.ethers.getContractFactory("ERC6538Registry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();
  const address = await registry.getAddress();
  console.log(`[erc6538] ✓ Local deploy at ${address}`);
  await persist(deploymentPath, deploymentFile, address);
});

async function persist(
  deploymentPath: string,
  deploymentFile: string,
  address: string,
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(deploymentPath, "utf8"));
    // Defensive: only spread if the parsed value is a plain object. If
    // the file ever contains a top-level array or `null`, JSON.parse
    // returns it without throwing — and `{...nonObject}` would silently
    // drop ALL prior content from the deployments JSON.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    } else {
      console.warn(
        `[erc6538] ${deploymentFile} root is not a plain object — refusing to spread; will write a fresh object containing only ERC6538Registry.`,
      );
    }
  } catch (err) {
    console.warn(
      `[erc6538] deployments file ${deploymentFile} not readable; creating new one. Inner: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const next = { ...existing, ERC6538Registry: address };
  writeFileSync(deploymentPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`[erc6538] ✓ Wrote address to ${deploymentFile}`);
}
