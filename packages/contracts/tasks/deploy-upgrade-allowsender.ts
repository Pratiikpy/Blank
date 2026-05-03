import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── UUPS upgrade: FHE.allow(x, msg.sender) -> FHE.allowSender(x) ───────
//
// Mechanical perf optimization across 9 contracts. allowSender reads
// msg.sender inside the precompile context, saving one ABI-encoded
// calldata slot per call. Same on-chain effect as the old form, smaller
// bytecode, cheaper hot paths (transfer, recordPayment, createInvoice).
//
// Sourced from references/fhenix-neo/core.md (Fhenix's own canonical AI
// training material, performance tip #3).
//
// No storage changes, no re-init, empty calldata — the safest possible
// UUPS upgrade. Storage layout snapshots verified clean before deploy.

const CONTRACTS_TO_UPGRADE: Array<{ name: string; deployKey: string; aliasKey?: string }> = [
  { name: "BusinessHub",     deployKey: "BusinessHub" },
  { name: "CreatorHub",      deployKey: "CreatorHub" },
  { name: "EncryptedFlags",  deployKey: "EncryptedFlags" },
  // FHERC20Vault is deployed twice on Base Sepolia (USDC + USDT proxies),
  // once on Eth Sepolia (USDC only). Both proxies share the same impl
  // bytecode, so we deploy ONE new impl per network and point both at it.
  { name: "FHERC20Vault",    deployKey: "FHERC20Vault_USDC", aliasKey: "FHERC20Vault_USDT" },
  { name: "GiftMoney",       deployKey: "GiftMoney" },
  { name: "GroupManager",    deployKey: "GroupManager" },
  { name: "P2PExchange",     deployKey: "P2PExchange" },
  { name: "PaymentHub",      deployKey: "PaymentHub" },
  { name: "StealthPayments", deployKey: "StealthPayments" },
];

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2));
  console.log(`\nDeployment file updated: ${filePath}`);
}

async function deployImplOnly(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
): Promise<string> {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const newImpl = await Factory.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  return await newImpl.getAddress();
}

async function upgradeProxyTo(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  proxyAddress: string,
  newImplAddress: string,
): Promise<void> {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const proxy = Factory.attach(proxyAddress);
  const tx = await (proxy as any).upgradeToAndCall(newImplAddress, "0x");
  await tx.wait(2);
}

task(
  "deploy-upgrade-allowsender",
  "UUPS upgrade all 9 contracts to bytecode using FHE.allowSender (perf optimization, semantic-equivalent).",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — allowSender perf optimization upgrade");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("  Source:  ", "references/fhenix-neo/core.md perf tip #3");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results: Array<{ contract: string; proxy: string; impl: string; aliasProxy?: string }> = [];

  for (let i = 0; i < CONTRACTS_TO_UPGRADE.length; i++) {
    const { name, deployKey, aliasKey } = CONTRACTS_TO_UPGRADE[i];
    const proxyAddress = addresses[deployKey];

    console.log(`${i + 1}/${CONTRACTS_TO_UPGRADE.length}  ${name}`);

    if (!proxyAddress || proxyAddress === "0x0000000000000000000000000000000000000000") {
      console.log(`     SKIP — not deployed on ${hre.network.name}\n`);
      continue;
    }

    console.log(`     proxy:`, proxyAddress);

    // Deploy ONE new impl, point primary proxy at it.
    const implAddress = await deployImplOnly(hre, name);
    console.log(`     new impl:`, implAddress);

    await upgradeProxyTo(hre, name, proxyAddress, implAddress);
    console.log(`     ✓ primary upgraded`);
    addresses[`${deployKey}_Impl`] = implAddress;

    // If a second proxy uses the same impl (FHERC20Vault USDT), point it too.
    if (aliasKey && addresses[aliasKey] && addresses[aliasKey] !== "0x0000000000000000000000000000000000000000") {
      const aliasProxy = addresses[aliasKey];
      console.log(`     alias proxy (${aliasKey}):`, aliasProxy);
      await upgradeProxyTo(hre, name, aliasProxy, implAddress);
      console.log(`     ✓ alias upgraded\n`);
      addresses[`${aliasKey}_Impl`] = implAddress;
      results.push({ contract: name, proxy: proxyAddress, impl: implAddress, aliasProxy });
    } else {
      console.log("");
      results.push({ contract: name, proxy: proxyAddress, impl: implAddress });
    }
  }

  saveDeployment(hre.network.name, addresses);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ✓ Upgrade complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Upgraded ${results.length} contract(s) on ${hre.network.name}`);
  for (const r of results) {
    console.log(`  - ${r.contract.padEnd(20)} ${r.proxy} -> ${r.impl}`);
    if (r.aliasProxy) console.log(`    (alias proxy upgraded too: ${r.aliasProxy})`);
  }
  console.log("═══════════════════════════════════════════════════════════════");
});
