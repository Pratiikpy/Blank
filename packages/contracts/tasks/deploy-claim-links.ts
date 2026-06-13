import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-claim-links — Wave 4 deploy.
 *
 * Deploys `ClaimLinks` (UUPS proxy) wired to the existing EventHub on the
 * target chain. Reads EventHub address from deployments/<chain>.json and
 * persists ClaimLinks_Impl + ClaimLinks back to the same file.
 *
 * Idempotent: re-running redeploys (writing fresh impl + proxy addresses).
 *
 * Post-deploy steps the operator must run separately:
 *   1. EventHub.batchWhitelist([ClaimLinks])  — so activity events fan out.
 *   2. ClaimLinks.setPaymentReceipts(PaymentReceipts) — so claimers' totals
 *      flow into the proof-of-income aggregate.
 *   3. Update CONTRACTS_BY_CHAIN[chainId].ClaimLinks in
 *      packages/app/src/lib/constants.ts.
 *
 * Usage:
 *   npx hardhat deploy-claim-links --network eth-sepolia
 *   npx hardhat deploy-claim-links --network base-sepolia
 */
task(
  "deploy-claim-links",
  "Deploy ClaimLinks UUPS proxy + persist address to deployments JSON",
).setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
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
      `deploy-claim-links: unsupported network ${networkName} (expected eth-sepolia | base-sepolia | arb-sepolia)`,
    );
  }
  const deploymentPath = resolve(__dirname, "..", "deployments", deploymentFile);

  // Read existing deployments to find EventHub.
  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(readFileSync(deploymentPath, "utf8"));
  } catch (err) {
    throw new Error(
      `deploy-claim-links: deployments file ${deploymentFile} not readable. Run deploy-all first. Inner: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const eventHub = existing.EventHub;
  if (!eventHub || eventHub === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `deploy-claim-links: EventHub address missing in ${deploymentFile}. Run deploy-all first.`,
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer configured");
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);

  console.log("═══════════════════════════════════════════");
  console.log("  ClaimLinks deploy");
  console.log("═══════════════════════════════════════════");
  console.log("  Network: ", networkName);
  console.log("  Deployer:", deployerAddress);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("  EventHub:", eventHub);
  console.log("═══════════════════════════════════════════\n");

  // Deploy implementation.
  const Factory = await hre.ethers.getContractFactory("ClaimLinks");
  console.log("[claim-links] Deploying implementation...");
  const impl = await Factory.deploy();
  await impl.deploymentTransaction()?.wait(2);
  const implAddress = await impl.getAddress();
  console.log(`[claim-links] ✓ impl:  ${implAddress}`);

  // Deploy proxy with initialize(eventHub).
  const initData = Factory.interface.encodeFunctionData("initialize", [eventHub]);
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  console.log("[claim-links] Deploying proxy...");
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.deploymentTransaction()?.wait(2);
  const proxyAddress = await proxy.getAddress();
  console.log(`[claim-links] ✓ proxy: ${proxyAddress}`);

  // Persist.
  const next = {
    ...existing,
    ClaimLinks_Impl: implAddress,
    ClaimLinks: proxyAddress,
  };
  writeFileSync(deploymentPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`[claim-links] ✓ Wrote ClaimLinks_Impl + ClaimLinks to ${deploymentFile}`);

  console.log("");
  console.log("Next steps (operator must run):");
  console.log(`  1. Whitelist in EventHub:`);
  console.log(`       hardhat console --network ${networkName}`);
  console.log(`       const eh = await ethers.getContractAt("EventHub", "${eventHub}");`);
  console.log(`       await eh.batchWhitelist(["${proxyAddress}"]);`);
  console.log(`  2. Wire PaymentReceipts (optional but recommended):`);
  console.log(`       const cl = await ethers.getContractAt("ClaimLinks", "${proxyAddress}");`);
  console.log(`       await cl.setPaymentReceipts("${existing.PaymentReceipts ?? "0x...PaymentReceipts"}");`);
  console.log(`  3. Update packages/app/src/lib/constants.ts:`);
  console.log(`       CONTRACTS_BY_CHAIN[${networkName === "eth-sepolia" ? "ETH_SEPOLIA_ID" : networkName === "arb-sepolia" ? "ARB_SEPOLIA_ID" : "BASE_SEPOLIA_ID"}].ClaimLinks = "${proxyAddress}";`);
});
