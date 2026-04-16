import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

async function deployProxy(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  initArgs: unknown[] = []
) {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const impl = await Factory.deploy();
  await impl.deploymentTransaction()?.wait(2);
  const implAddress = await impl.getAddress();
  console.log("     impl:", implAddress);

  const initData = initArgs.length > 0
    ? Factory.interface.encodeFunctionData("initialize", initArgs)
    : Factory.interface.encodeFunctionData("initialize");

  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
  );
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.deploymentTransaction()?.wait(2);
  const proxyAddress = await proxy.getAddress();

  return { implAddress, proxyAddress };
}

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const dir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(dir, `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2));
  console.log(`\nDeployment updated: ${filePath}`);
}

task("deploy-upgrade-v2", "Deploy updated contracts (V2) — fresh proxies for struct changes, upgrade for storage-safe changes").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const addresses = loadDeployment(hre.network.name);

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — V2 Upgrade Deployment");
    console.log("═══════════════════════════════════════════");
    console.log("  Deployer:", deployer.address);
    console.log("  Network: ", hre.network.name);
    console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
    console.log("  EventHub:", addresses.EventHub);
    console.log("═══════════════════════════════════════════\n");

    // Store old addresses for summary
    const oldAddresses = {
      InheritanceManager: addresses.InheritanceManager,
      InheritanceManager_Impl: addresses.InheritanceManager_Impl || "N/A",
      GiftMoney: addresses.GiftMoney,
      GiftMoney_Impl: addresses.GiftMoney_Impl || "N/A",
      GroupManager: addresses.GroupManager,
      GroupManager_Impl: addresses.GroupManager_Impl || "N/A",
      BusinessHub: addresses.BusinessHub,
      BusinessHub_Impl: addresses.BusinessHub_Impl || "N/A",
    };

    // ─── 1. InheritanceManager — FRESH proxy (struct changed: added vaults array) ───
    console.log("1/4  Deploying InheritanceManager V2 (FRESH proxy — struct changed)...");
    console.log("     Old proxy:", oldAddresses.InheritanceManager);
    const inheritance = await deployProxy(hre, "InheritanceManager", [addresses.EventHub]);
    addresses.InheritanceManager_V1 = oldAddresses.InheritanceManager;
    addresses.InheritanceManager_Impl = inheritance.implAddress;
    addresses.InheritanceManager = inheritance.proxyAddress;
    console.log("     ✓ NEW proxy:", addresses.InheritanceManager);

    // ─── 2. GiftMoney — FRESH proxy (struct changed: added expiryTimestamp) ─────────
    console.log("\n2/4  Deploying GiftMoney V2 (FRESH proxy — struct changed)...");
    console.log("     Old proxy:", oldAddresses.GiftMoney);
    const giftMoney = await deployProxy(hre, "GiftMoney", [addresses.EventHub]);
    addresses.GiftMoney_V1 = oldAddresses.GiftMoney;
    addresses.GiftMoney_Impl = giftMoney.implAddress;
    addresses.GiftMoney = giftMoney.proxyAddress;
    console.log("     ✓ NEW proxy:", addresses.GiftMoney);

    // ─── 3. GroupManager — UPGRADE in place (new mapping is storage-safe) ───────────
    console.log("\n3/4  Upgrading GroupManager (new impl — storage-safe append)...");
    console.log("     Proxy (unchanged):", addresses.GroupManager);
    const GroupManagerFactory = await hre.ethers.getContractFactory("GroupManager");
    const newGroupManagerImpl = await GroupManagerFactory.deploy();
    await newGroupManagerImpl.deploymentTransaction()?.wait(2);
    const newGroupManagerImplAddress = await newGroupManagerImpl.getAddress();
    console.log("     New impl:", newGroupManagerImplAddress);

    // Call upgradeToAndCall on the existing proxy (UUPS pattern)
    const groupManagerProxy = GroupManagerFactory.attach(addresses.GroupManager);
    const upgradeTx = await groupManagerProxy.upgradeToAndCall(newGroupManagerImplAddress, "0x");
    await upgradeTx.wait(2);
    addresses.GroupManager_Impl = newGroupManagerImplAddress;
    console.log("     ✓ Proxy upgraded to new implementation");

    // ─── 4. BusinessHub — Deploy new impl only (no contract changes, ABI-only update) ─
    console.log("\n4/4  Deploying BusinessHub new impl (ABI update only, no contract changes)...");
    console.log("     Proxy (unchanged):", addresses.BusinessHub);
    const BusinessHubFactory = await hre.ethers.getContractFactory("BusinessHub");
    const newBusinessHubImpl = await BusinessHubFactory.deploy();
    await newBusinessHubImpl.deploymentTransaction()?.wait(2);
    const newBusinessHubImplAddress = await newBusinessHubImpl.getAddress();
    console.log("     New impl:", newBusinessHubImplAddress);

    // Upgrade proxy to new impl (even though code is same, ensures ABI matches on-chain bytecode)
    const businessHubProxy = BusinessHubFactory.attach(addresses.BusinessHub);
    const bizUpgradeTx = await businessHubProxy.upgradeToAndCall(newBusinessHubImplAddress, "0x");
    await bizUpgradeTx.wait(2);
    addresses.BusinessHub_Impl = newBusinessHubImplAddress;
    console.log("     ✓ Proxy upgraded to new implementation");

    // ─── 5. Whitelist NEW proxies in EventHub ───────────────────────────────────────
    console.log("\n     Whitelisting new contract proxies in EventHub...");
    const eventHub = (await hre.ethers.getContractFactory("EventHub")).attach(addresses.EventHub);
    // Only InheritanceManager and GiftMoney have new proxy addresses
    // GroupManager and BusinessHub keep same proxy, no re-whitelisting needed
    const whitelistTx = await eventHub.batchWhitelist([
      addresses.InheritanceManager,
      addresses.GiftMoney,
    ]);
    await whitelistTx.wait(2);
    console.log("     ✓ InheritanceManager V2 + GiftMoney V2 whitelisted");

    // ─── Save ───────────────────────────────────────────────────────────────────────
    saveDeployment(hre.network.name, addresses);

    // ─── Summary ────────────────────────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  V2 Upgrade Deployment Complete!");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("");
    console.log("  InheritanceManager (FRESH proxy — struct changed):");
    console.log("    Old proxy: ", oldAddresses.InheritanceManager);
    console.log("    Old impl:  ", oldAddresses.InheritanceManager_Impl);
    console.log("    New proxy: ", addresses.InheritanceManager);
    console.log("    New impl:  ", addresses.InheritanceManager_Impl);
    console.log("");
    console.log("  GiftMoney (FRESH proxy — struct changed):");
    console.log("    Old proxy: ", oldAddresses.GiftMoney);
    console.log("    Old impl:  ", oldAddresses.GiftMoney_Impl);
    console.log("    New proxy: ", addresses.GiftMoney);
    console.log("    New impl:  ", addresses.GiftMoney_Impl);
    console.log("");
    console.log("  GroupManager (UPGRADED in place — storage-safe):");
    console.log("    Proxy:     ", addresses.GroupManager, "(unchanged)");
    console.log("    Old impl:  ", oldAddresses.GroupManager_Impl);
    console.log("    New impl:  ", addresses.GroupManager_Impl);
    console.log("");
    console.log("  BusinessHub (UPGRADED in place — ABI-only update):");
    console.log("    Proxy:     ", addresses.BusinessHub, "(unchanged)");
    console.log("    Old impl:  ", oldAddresses.BusinessHub_Impl);
    console.log("    New impl:  ", addresses.BusinessHub_Impl);
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("\n  Update packages/app/src/lib/constants.ts with:");
    console.log("    InheritanceManager:", addresses.InheritanceManager);
    console.log("    GiftMoney:         ", addresses.GiftMoney);
    console.log("  (GroupManager + BusinessHub proxies are unchanged)\n");
  }
);
