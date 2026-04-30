import { task } from "hardhat/config";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-session-key-validator — Phase 4.1 core deploy.
 *
 * Deploys `SessionKeyValidator.sol` to the active network and writes its
 * address into the network's deployment JSON so the frontend + cron can
 * pick it up via @blankpay/contracts/deployments/<network>.json.
 *
 * NOTE: this validator only becomes useful AFTER BlankAccount has been
 * UUPS-upgraded to a version that dispatches signatures by mode prefix
 * (0x00 = legacy P-256, 0x01 = session-key delegation → IValidator). Until
 * that upgrade lands, the deployed validator can be exercised in tests
 * only — no production UserOps will route to it.
 *
 * Usage:
 *   npx hardhat deploy-session-key-validator --network eth-sepolia
 *   npx hardhat deploy-session-key-validator --network base-sepolia
 */
task(
  "deploy-session-key-validator",
  "Deploy SessionKeyValidator and persist its address to deployments JSON",
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
      `deploy-session-key-validator: unsupported network ${networkName} (expected eth-sepolia | base-sepolia)`,
    );
  }
  const deploymentPath = resolve(__dirname, "..", "deployments", deploymentFile);

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer configured for this network");
  }
  const deployerAddress = await deployer.getAddress();
  console.log(`[session-key-validator] Network:  ${networkName}`);
  console.log(`[session-key-validator] Deployer: ${deployerAddress}`);

  const Factory = await hre.ethers.getContractFactory("SessionKeyValidator");
  const validator = await Factory.deploy();
  await validator.waitForDeployment();
  const address = await validator.getAddress();

  console.log(`[session-key-validator] ✓ Deployed at ${address}`);

  // Persist to deployments JSON, append-only (don't overwrite other entries).
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(deploymentPath, "utf8"));
  } catch (err) {
    console.warn(
      `[session-key-validator] deployments file ${deploymentFile} not readable; creating new one. Inner: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const next = { ...existing, SessionKeyValidator: address };
  writeFileSync(deploymentPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`[session-key-validator] ✓ Wrote address to ${deploymentFile}`);

  console.log(``);
  console.log(`Next steps:`);
  console.log(`  1. UUPS-upgrade BlankAccount to dispatch session-key signatures`);
  console.log(`     to this validator (separate task, scoped per Phase 4.1 plan).`);
  console.log(`  2. Build the ScheduledSends UI + Vercel cron that signs and`);
  console.log(`     submits UserOps using a server-held session key.`);
  console.log(`  3. Update @blankpay/app/src/lib/constants.ts to expose`);
  console.log(`     SessionKeyValidator's address per chain.`);
});
