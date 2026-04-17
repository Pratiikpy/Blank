import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// UUPS upgrade BusinessHub + StealthPayments impls — the deployed bytecode
// is stale (missing getInvoiceValidationHandle, finalize event wiring, etc.).
// Same refresh pattern as session 2's CreatorHub/P2PExchange upgrade.

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const dir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(dir, `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2));
  console.log(`Deployment file updated: ${filePath}`);
}

async function upgradeInPlace(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  proxyAddress: string,
): Promise<string> {
  console.log(`     proxy:`, proxyAddress);
  const Factory = await hre.ethers.getContractFactory(contractName);
  const newImpl = await Factory.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddress = await newImpl.getAddress();
  console.log(`     new impl:`, newImplAddress);

  const proxy = Factory.attach(proxyAddress);
  const tx = await (proxy as any).upgradeToAndCall(newImplAddress, "0x");
  await tx.wait(2);
  console.log(`     ✓ upgraded`);
  return newImplAddress;
}

task(
  "deploy-upgrade-businesshub",
  "UUPS upgrade BusinessHub + StealthPayments to latest compiled bytecode.",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — BusinessHub + StealthPayments impl refresh");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (addresses.BusinessHub) {
    console.log("1/2  BusinessHub upgrade...");
    const impl = await upgradeInPlace(hre, "BusinessHub", addresses.BusinessHub);
    addresses.BusinessHub_Impl = impl;
  }

  if (addresses.StealthPayments) {
    console.log("\n2/2  StealthPayments upgrade...");
    const impl = await upgradeInPlace(hre, "StealthPayments", addresses.StealthPayments);
    addresses.StealthPayments_Impl = impl;
  }

  saveDeployment(hre.network.name, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ✓ Upgrade complete");
  console.log("═══════════════════════════════════════════════════════════════");
});
