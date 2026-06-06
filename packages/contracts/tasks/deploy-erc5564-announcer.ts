import { task } from "hardhat/config";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-erc5564-announcer — Phase 9 deploy.
 *
 * Strategy (in order of preference):
 *
 *   1. CREATE2 via the Arachnid singleton-factory at
 *      `0x4e59b44847b379578588920cA78FbF26c0B4956C` with the canonical
 *      ERC-5564 salt
 *      `0xd0103a290d760f027c9ca72675f5121d725397fb2f618f05b6c44958b25b4447`.
 *      This places the contract at the deterministic singleton address
 *      `0x55649E01B5Df198D18D95b5cc5051630cfD45564` so wallets/indexers
 *      that hard-code the singleton can find our announcer without
 *      per-chain config.
 *
 *   2. If the Arachnid factory has no code on this chain (some testnets
 *      pre-deploy it; others don't), fall back to a plain `Factory.deploy()`
 *      and write the chain-specific address to `deployments/<network>.json`.
 *
 *   3. If the deterministic singleton already has code (someone else
 *      deployed it first — entirely fine, the contract is stateless and
 *      identical across chains because it's deterministic), record that
 *      address as ours and exit.
 *
 * Idempotent: re-running the task on an already-populated chain reuses
 * the existing deployment and only re-writes the JSON.
 *
 * Usage:
 *   npx hardhat deploy-erc5564-announcer --network eth-sepolia
 *   npx hardhat deploy-erc5564-announcer --network base-sepolia
 */
const ARACHNID_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const ERC5564_SALT =
  "0xd0103a290d760f027c9ca72675f5121d725397fb2f618f05b6c44958b25b4447";
const EXPECTED_SINGLETON = "0x55649E01B5Df198D18D95b5cc5051630cfD45564";

task(
  "deploy-erc5564-announcer",
  "Deploy ERC5564Announcer (Phase 9). Tries Arachnid CREATE2 singleton first, falls back to a plain deploy.",
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
      `deploy-erc5564-announcer: unsupported network ${networkName} (expected eth-sepolia | base-sepolia | arb-sepolia)`,
    );
  }
  const deploymentPath = resolve(__dirname, "..", "deployments", deploymentFile);

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer configured");
  const deployerAddress = await deployer.getAddress();
  console.log(`[erc5564] Network:  ${networkName}`);
  console.log(`[erc5564] Deployer: ${deployerAddress}`);

  const provider = hre.ethers.provider;

  // Compute the deterministic CREATE2 address from our local artifact's
  // bytecode + the canonical salt + the Arachnid factory address.
  // If init bytecode drifts (compiler version / settings / NatSpec
  // changes affecting metadata hash), this address changes — so we
  // verify on-chain that the canonical singleton matches our artifact
  // before treating it as "ours".
  const Factory = await hre.ethers.getContractFactory("ERC5564Announcer");
  const initCode = Factory.bytecode; // includes appended metadata hash
  const computedSingleton = hre.ethers.getCreate2Address(
    ARACHNID_FACTORY,
    ERC5564_SALT,
    hre.ethers.keccak256(initCode),
  );
  console.log(`[erc5564] Computed CREATE2 address (Arachnid + canonical salt): ${computedSingleton}`);

  // Step 0a: prefer the canonical EIP singleton if anyone has already
  // deployed it on this chain. The contract is stateless + ABI-identical
  // by EIP definition, so accepting it (even when its bytecode metadata
  // hash differs from our local artifact) lets wallets/indexers that
  // hardcode `0x55649E…45564` discover our announcements without per-chain
  // config — the entire point of having a canonical singleton.
  const expectedSingletonCode = await provider.getCode(EXPECTED_SINGLETON);
  if (expectedSingletonCode && expectedSingletonCode !== "0x") {
    console.log(
      `[erc5564] ✓ Canonical EIP singleton already deployed at ${EXPECTED_SINGLETON} — reusing.`,
    );
    await persistAddress(deploymentPath, deploymentFile, EXPECTED_SINGLETON);
    return;
  }

  // Step 0b: artifact-derived CREATE2 address (matches what *our*
  // compiler-output bytecode would land at). May differ from the EIP
  // singleton if our compiler/optimizer settings produce a different
  // metadata hash than the reference build.
  const singletonCode = await provider.getCode(computedSingleton);
  if (singletonCode && singletonCode !== "0x") {
    console.log(
      `[erc5564] ✓ Singleton already deployed at ${computedSingleton} — reusing.`,
    );
    await persistAddress(deploymentPath, deploymentFile, computedSingleton);
    return;
  }

  // Step 1: try Arachnid CREATE2 deploy.
  const factoryCode = await provider.getCode(ARACHNID_FACTORY);
  if (factoryCode && factoryCode !== "0x") {
    console.log(`[erc5564] Arachnid factory present; attempting CREATE2 deploy…`);
    // Calldata = salt (32 bytes) || initCode. Arachnid factory's
    // fallback parses exactly that layout.
    const calldata = hre.ethers.concat([ERC5564_SALT, initCode]);
    const tx = await deployer.sendTransaction({
      to: ARACHNID_FACTORY,
      data: calldata,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(
        `[erc5564] Arachnid CREATE2 transaction reverted (tx ${tx.hash})`,
      );
    }
    // Arachnid's factory either deploys at the deterministic address or
    // reverts. A successful tx with no code is unreachable per its
    // semantics — make that explicit so a future regression in the
    // factory or our calldata layout fails loud rather than silently
    // doing a non-deterministic plain deploy.
    const deployedCode = await provider.getCode(computedSingleton);
    if (!deployedCode || deployedCode === "0x") {
      throw new Error(
        `[erc5564] Arachnid CREATE2 tx ${tx.hash} succeeded but no code at ${computedSingleton} — calldata layout drift?`,
      );
    }
    console.log(
      `[erc5564] ✓ Deterministic deploy succeeded at ${computedSingleton}`,
    );
    if (computedSingleton.toLowerCase() !== EXPECTED_SINGLETON.toLowerCase()) {
      console.warn(
        `[erc5564] Note: computed singleton ${computedSingleton} differs from the EIP's expected ${EXPECTED_SINGLETON}. ` +
          `That's fine — different compiler settings produce different metadata hashes, ` +
          `which changes init bytecode and therefore the CREATE2 address. ` +
          `Wallets that hardcode the EIP singleton will need this address instead.`,
      );
    }
    await persistAddress(deploymentPath, deploymentFile, computedSingleton);
    return;
  }
  console.log(
    `[erc5564] Arachnid factory not deployed at ${ARACHNID_FACTORY} on ${networkName}; falling back to plain deploy.`,
  );

  // Step 2: plain deploy.
  const deployed = await Factory.deploy();
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  console.log(`[erc5564] ✓ Plain deploy at ${address}`);
  await persistAddress(deploymentPath, deploymentFile, address);
});

async function persistAddress(
  deploymentPath: string,
  deploymentFile: string,
  address: string,
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(deploymentPath, "utf8"));
  } catch (err) {
    console.warn(
      `[erc5564] deployments file ${deploymentFile} not readable; creating new one. Inner: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const next = { ...existing, ERC5564Announcer: address };
  writeFileSync(deploymentPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`[erc5564] ✓ Wrote address to ${deploymentFile}`);
}
