import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-storefront — Wave 4 #254 deploy.
 *
 * Deploys `Storefront` (UUPS proxy) wired to existing EventHub. Persists
 * Storefront_Impl + Storefront to deployments/<chain>.json.
 *
 * Post-deploy ops (run with the included scripts/wire-storefront.js):
 *   1. EventHub.batchWhitelist([Storefront])
 *   2. Storefront.setPaymentReceipts(PaymentReceipts)
 *   3. Update CONTRACTS_BY_CHAIN[chainId].Storefront in lib/constants.ts
 */
task(
  "deploy-storefront",
  "Deploy Storefront UUPS proxy + persist address to deployments JSON",
).setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
  const networkName = hre.network.name;
  const deploymentFile =
    networkName === "base-sepolia" ? "base-sepolia.json" :
    networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
  if (!deploymentFile) {
    throw new Error(`deploy-storefront: unsupported network ${networkName}`);
  }
  const deploymentPath = resolve(__dirname, "..", "deployments", deploymentFile);

  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(readFileSync(deploymentPath, "utf8"));
  } catch (err) {
    throw new Error(`deploy-storefront: deployments file unreadable. Run deploy-all first. ${err instanceof Error ? err.message : String(err)}`);
  }
  const eventHub = existing.EventHub;
  if (!eventHub || eventHub === "0x0000000000000000000000000000000000000000") {
    throw new Error(`deploy-storefront: EventHub missing in ${deploymentFile}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("═══════════════════════════════════════════");
  console.log("  Storefront deploy");
  console.log("═══════════════════════════════════════════");
  console.log(`  Network:  ${networkName}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance:  ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`  EventHub: ${eventHub}`);
  console.log("═══════════════════════════════════════════\n");

  const Factory = await hre.ethers.getContractFactory("Storefront");
  console.log("[storefront] Deploying impl...");
  const impl = await Factory.deploy();
  await impl.deploymentTransaction()?.wait(2);
  const implAddress = await impl.getAddress();
  console.log(`[storefront] ✓ impl:  ${implAddress}`);

  const initData = Factory.interface.encodeFunctionData("initialize", [eventHub]);
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  console.log("[storefront] Deploying proxy...");
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.deploymentTransaction()?.wait(2);
  const proxyAddress = await proxy.getAddress();
  console.log(`[storefront] ✓ proxy: ${proxyAddress}`);

  const next = { ...existing, Storefront_Impl: implAddress, Storefront: proxyAddress };
  writeFileSync(deploymentPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`[storefront] ✓ Wrote to ${deploymentFile}`);

  console.log("\nNext: pnpm hardhat run scripts/wire-storefront.js --network", networkName);
});
