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
 * The validator is usable once an account runs a BlankAccount
 * implementation with validator dispatch (any non-64-byte signature is
 * abi.decode(address validator, bytes inner)) and has enabled it in its
 * current owner epoch (isValidatorEnabled). The security-v1 Scope adds
 * maxFeePerGas, maxTotalGas and paymaster; the session signature is
 * abi.encode(sessionKey, uint48 notBefore, sig over
 * keccak256(abi.encode(userOpHash, notBefore))).
 *
 * deploy-upgrade-security-v1 already redeploys it on chains that have one.
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
        : networkName === "arb-sepolia"
          ? "arb-sepolia.json"
          : null;
  if (!deploymentFile) {
    throw new Error(
      `deploy-session-key-validator: unsupported network ${networkName} (expected eth-sepolia | base-sepolia | arb-sepolia)`,
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
  // Keep the previous validator under *_v0 so wire-paymaster-targets can
  // un-approve it; scopes on it do not carry over.
  const next: Record<string, unknown> = { ...existing, SessionKeyValidator: address };
  if (typeof existing.SessionKeyValidator === "string" && existing.SessionKeyValidator !== address) {
    next.SessionKeyValidator_v0 = existing.SessionKeyValidator;
    console.log(`[session-key-validator] previous validator kept as SessionKeyValidator_v0 (${existing.SessionKeyValidator})`);
  }
  writeFileSync(deploymentPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`[session-key-validator] ✓ Wrote address to ${deploymentFile}`);

  console.log(``);
  console.log(`Next steps:`);
  console.log(`  1. wire-paymaster-targets (approves this validator, revokes _v0)`);
  console.log(`  2. Set SessionKeyValidator in packages/app/src/lib/constants.ts and`);
  console.log(`     VITE_BLANK_<chainId>_SESSION_KEY_VALIDATOR=${address} for the cron.`);
  console.log(`  3. Users upgrade to the security-v1 BlankAccount and enable this`);
  console.log(`     validator again from Scheduled sends; old scopes do not carry over.`);
});
