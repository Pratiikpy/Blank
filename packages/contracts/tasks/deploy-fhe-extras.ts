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

task("deploy-fhe-extras", "Deploy FHE-maximized contracts (PaymentReceipts + EncryptedFlags)").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const addresses = loadDeployment(hre.network.name);

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — FHE Extras Deployment");
    console.log("═══════════════════════════════════════════");
    console.log("  Deployer:", deployer.address);
    console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
    console.log("═══════════════════════════════════════════\n");

    // 1. PaymentReceipts
    console.log("1/2  Deploying PaymentReceipts (UUPS)...");
    const receipts = await deployProxy(hre, "PaymentReceipts");
    addresses.PaymentReceipts_Impl = receipts.implAddress;
    addresses.PaymentReceipts = receipts.proxyAddress;
    console.log("     ✓ proxy:", addresses.PaymentReceipts);

    // 2. EncryptedFlags (baseFeeRate=100 bps = 1%, merchantDiscount=5000 bps = 50% discount)
    console.log("\n2/2  Deploying EncryptedFlags (UUPS)...");
    const flags = await deployProxy(hre, "EncryptedFlags", [100, 5000]);
    addresses.EncryptedFlags_Impl = flags.implAddress;
    addresses.EncryptedFlags = flags.proxyAddress;
    console.log("     ✓ proxy:", addresses.EncryptedFlags);

    // Whitelist in EventHub
    console.log("\n     Whitelisting in EventHub...");
    const eventHub = (await hre.ethers.getContractFactory("EventHub")).attach(addresses.EventHub);
    const tx = await eventHub.batchWhitelist([addresses.PaymentReceipts, addresses.EncryptedFlags]);
    await tx.wait(2);
    console.log("     ✓ Both whitelisted");

    saveDeployment(hre.network.name, addresses);

    console.log("\n═══════════════════════════════════════════");
    console.log("  FHE Extras Deployed!");
    console.log("═══════════════════════════════════════════");
    console.log("  PaymentReceipts: ", addresses.PaymentReceipts);
    console.log("  EncryptedFlags:  ", addresses.EncryptedFlags);
    console.log("═══════════════════════════════════════════\n");
  }
);
