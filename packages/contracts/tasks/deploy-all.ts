import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

interface DeployedAddresses {
  [key: string]: string;
}

function saveDeployment(network: string, addresses: DeployedAddresses) {
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2));
  console.log(`\nDeployment saved to: ${filePath}`);
}

async function deployProxy(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  initArgs: unknown[] = []
) {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const impl = await Factory.deploy();
  const implReceipt = await impl.deploymentTransaction()?.wait(2); // Wait 2 confirmations
  const implAddress = await impl.getAddress();
  console.log("     impl:", implAddress, "block:", implReceipt?.blockNumber);

  const initData = initArgs.length > 0
    ? Factory.interface.encodeFunctionData("initialize", initArgs)
    : Factory.interface.encodeFunctionData("initialize");

  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
  );
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.deploymentTransaction()?.wait(2); // Wait 2 confirmations
  const proxyAddress = await proxy.getAddress();

  return { implAddress, proxyAddress, factory: Factory };
}

task("deploy-all", "Deploy all Blank foundation contracts").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("═══════════════════════════════════════════");
    console.log("  Blank Deployment");
    console.log("═══════════════════════════════════════════");
    console.log("  Deployer:", deployer.address);
    console.log("  Network: ", hre.network.name);
    console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
    console.log("═══════════════════════════════════════════\n");

    const addresses: DeployedAddresses = {};

    // ─── 1. TestUSDC ─────────────────────────────────────────────
    console.log("1/7  Deploying TestUSDC...");
    const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
    const testUSDC = await TestUSDC.deploy();
    await testUSDC.deploymentTransaction()?.wait(2);
    addresses.TestUSDC = await testUSDC.getAddress();
    console.log("     ✓", addresses.TestUSDC);

    // ─── 2. TokenRegistry (proxy) ────────────────────────────────
    console.log("\n2/7  Deploying TokenRegistry (UUPS)...");
    const tokenRegistry = await deployProxy(hre, "TokenRegistry");
    addresses.TokenRegistry_Impl = tokenRegistry.implAddress;
    addresses.TokenRegistry = tokenRegistry.proxyAddress;
    console.log("     ✓ proxy:", addresses.TokenRegistry);

    // ─── 3. EventHub (proxy) ─────────────────────────────────────
    console.log("\n3/7  Deploying EventHub (UUPS)...");
    const eventHub = await deployProxy(hre, "EventHub");
    addresses.EventHub_Impl = eventHub.implAddress;
    addresses.EventHub = eventHub.proxyAddress;
    console.log("     ✓ proxy:", addresses.EventHub);

    // ─── 4. FHERC20Vault for USDC (proxy) ────────────────────────
    console.log("\n4/7  Deploying FHERC20Vault for USDC (UUPS)...");
    const vault = await deployProxy(hre, "FHERC20Vault", [
      addresses.TestUSDC,
      "Encrypted USDC",
      "eUSDC",
      6,
      addresses.EventHub,
    ]);
    addresses.FHERC20Vault_USDC_Impl = vault.implAddress;
    addresses.FHERC20Vault_USDC = vault.proxyAddress;
    console.log("     ✓ proxy:", addresses.FHERC20Vault_USDC);

    // ─── 5. PaymentHub (proxy) ───────────────────────────────────
    console.log("\n5/7  Deploying PaymentHub (UUPS)...");
    const paymentHub = await deployProxy(hre, "PaymentHub", [addresses.EventHub]);
    addresses.PaymentHub_Impl = paymentHub.implAddress;
    addresses.PaymentHub = paymentHub.proxyAddress;
    console.log("     ✓ proxy:", addresses.PaymentHub);

    // ─── 6. Post-deploy: Whitelist in EventHub ───────────────────
    console.log("\n6/7  Whitelisting contracts in EventHub...");
    const eventHubContract = (await hre.ethers.getContractFactory("EventHub")).attach(addresses.EventHub);
    const whitelistTx = await eventHubContract.batchWhitelist([
      addresses.FHERC20Vault_USDC,
      addresses.PaymentHub,
    ]);
    await whitelistTx.wait(2);
    console.log("     ✓ Vault + PaymentHub whitelisted");

    // ─── 7. Post-deploy: Register token ──────────────────────────
    console.log("\n7/7  Registering token in TokenRegistry...");
    const registryContract = (await hre.ethers.getContractFactory("TokenRegistry")).attach(addresses.TokenRegistry);
    const regTx = await registryContract.registerToken(
      addresses.FHERC20Vault_USDC,
      addresses.TestUSDC,
      "Encrypted USDC",
      "eUSDC",
      6
    );
    await regTx.wait(2);
    console.log("     ✓ eUSDC registered");

    // ─── Save ────────────────────────────────────────────────────
    saveDeployment(hre.network.name, addresses);

    console.log("\n═══════════════════════════════════════════");
    console.log("  Deployment Complete!");
    console.log("═══════════════════════════════════════════");
    console.log("  TestUSDC:          ", addresses.TestUSDC);
    console.log("  TokenRegistry:     ", addresses.TokenRegistry);
    console.log("  EventHub:          ", addresses.EventHub);
    console.log("  FHERC20Vault USDC: ", addresses.FHERC20Vault_USDC);
    console.log("  PaymentHub:        ", addresses.PaymentHub);
    console.log("═══════════════════════════════════════════");
    console.log("\n  Update packages/app/src/lib/constants.ts");
    console.log("  with these addresses to connect the frontend.\n");
  }
);
