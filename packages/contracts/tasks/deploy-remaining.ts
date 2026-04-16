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

task("deploy-remaining", "Deploy remaining Blank contracts (Phase 2)").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const addresses = loadDeployment(hre.network.name);

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — Phase 2 Deployment");
    console.log("═══════════════════════════════════════════");
    console.log("  Deployer:", deployer.address);
    console.log("  Network: ", hre.network.name);
    console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
    console.log("  EventHub:", addresses.EventHub);
    console.log("═══════════════════════════════════════════\n");

    // ─── 1. GroupManager ─────────────────────────────────────────
    console.log("1/5  Deploying GroupManager (UUPS)...");
    const groupManager = await deployProxy(hre, "GroupManager", [addresses.EventHub]);
    addresses.GroupManager_Impl = groupManager.implAddress;
    addresses.GroupManager = groupManager.proxyAddress;
    console.log("     ✓ proxy:", addresses.GroupManager);

    // ─── 2. CreatorHub ───────────────────────────────────────────
    console.log("\n2/5  Deploying CreatorHub (UUPS)...");
    const creatorHub = await deployProxy(hre, "CreatorHub", [addresses.EventHub]);
    addresses.CreatorHub_Impl = creatorHub.implAddress;
    addresses.CreatorHub = creatorHub.proxyAddress;
    console.log("     ✓ proxy:", addresses.CreatorHub);

    // ─── 3. BusinessHub ──────────────────────────────────────────
    console.log("\n3/5  Deploying BusinessHub (UUPS)...");
    const businessHub = await deployProxy(hre, "BusinessHub", [addresses.EventHub]);
    addresses.BusinessHub_Impl = businessHub.implAddress;
    addresses.BusinessHub = businessHub.proxyAddress;
    console.log("     ✓ proxy:", addresses.BusinessHub);

    // ─── 4. P2PExchange ──────────────────────────────────────────
    console.log("\n4/5  Deploying P2PExchange (UUPS)...");
    const p2pExchange = await deployProxy(hre, "P2PExchange", [addresses.EventHub]);
    addresses.P2PExchange_Impl = p2pExchange.implAddress;
    addresses.P2PExchange = p2pExchange.proxyAddress;
    console.log("     ✓ proxy:", addresses.P2PExchange);

    // ─── 5. InheritanceManager ───────────────────────────────────
    console.log("\n5/5  Deploying InheritanceManager (UUPS)...");
    const inheritance = await deployProxy(hre, "InheritanceManager", [addresses.EventHub]);
    addresses.InheritanceManager_Impl = inheritance.implAddress;
    addresses.InheritanceManager = inheritance.proxyAddress;
    console.log("     ✓ proxy:", addresses.InheritanceManager);

    // ─── Whitelist all new contracts in EventHub ─────────────────
    console.log("\n     Whitelisting new contracts in EventHub...");
    const eventHubContract = (await hre.ethers.getContractFactory("EventHub")).attach(addresses.EventHub);
    const whitelistTx = await eventHubContract.batchWhitelist([
      addresses.GroupManager,
      addresses.CreatorHub,
      addresses.BusinessHub,
      addresses.P2PExchange,
      addresses.InheritanceManager,
    ]);
    await whitelistTx.wait(2);
    console.log("     ✓ All 5 contracts whitelisted");

    // ─── Save ────────────────────────────────────────────────────
    saveDeployment(hre.network.name, addresses);

    console.log("\n═══════════════════════════════════════════");
    console.log("  Phase 2 Deployment Complete!");
    console.log("═══════════════════════════════════════════");
    console.log("  GroupManager:       ", addresses.GroupManager);
    console.log("  CreatorHub:         ", addresses.CreatorHub);
    console.log("  BusinessHub:        ", addresses.BusinessHub);
    console.log("  P2PExchange:        ", addresses.P2PExchange);
    console.log("  InheritanceManager: ", addresses.InheritanceManager);
    console.log("═══════════════════════════════════════════\n");
  }
);
