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

function deployNonProxy(hre: HardhatRuntimeEnvironment) {
  return async (contractName: string, ...args: unknown[]) => {
    const Factory = await hre.ethers.getContractFactory(contractName);
    const contract = await Factory.deploy(...args);
    await contract.deploymentTransaction()?.wait(2);
    const address = await contract.getAddress();
    return address;
  };
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

task("deploy-new-features", "Deploy GiftMoney, StealthPayments, PrivacyRouter, MockDEX").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const addresses = loadDeployment(hre.network.name);

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — New Features Deployment");
    console.log("═══════════════════════════════════════════");
    console.log("  Deployer:", deployer.address);
    console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
    console.log("  Network: ", hre.network.name);
    console.log("═══════════════════════════════════════════\n");

    const deploy = deployNonProxy(hre);

    // 1. MockDEX (not upgradeable — simple test contract)
    let mockDexAddress = addresses.MockDEX;
    if (!mockDexAddress || mockDexAddress === "0x0000000000000000000000000000000000000000") {
      console.log("1/4  Deploying MockDEX...");
      mockDexAddress = await deploy("MockDEX");
      addresses.MockDEX = mockDexAddress;
      console.log("     ✓ MockDEX:", mockDexAddress);
    } else {
      console.log("1/4  MockDEX already deployed:", mockDexAddress);
    }

    // 2. GiftMoney (UUPS upgradeable) — initialize(address _eventHub)
    console.log("\n2/4  Deploying GiftMoney (UUPS)...");
    const giftMoney = await deployProxy(hre, "GiftMoney", [addresses.EventHub]);
    addresses.GiftMoney_Impl = giftMoney.implAddress;
    addresses.GiftMoney = giftMoney.proxyAddress;
    console.log("     ✓ proxy:", addresses.GiftMoney);

    // 3. StealthPayments (UUPS upgradeable) — initialize(address _eventHub)
    console.log("\n3/4  Deploying StealthPayments (UUPS)...");
    const stealth = await deployProxy(hre, "StealthPayments", [addresses.EventHub]);
    addresses.StealthPayments_Impl = stealth.implAddress;
    addresses.StealthPayments = stealth.proxyAddress;
    console.log("     ✓ proxy:", addresses.StealthPayments);

    // 4. PrivacyRouter (UUPS upgradeable) — initialize(address _dexRouter, address _eventHub)
    console.log("\n4/4  Deploying PrivacyRouter (UUPS)...");
    const router = await deployProxy(hre, "PrivacyRouter", [mockDexAddress, addresses.EventHub]);
    addresses.PrivacyRouter_Impl = router.implAddress;
    addresses.PrivacyRouter = router.proxyAddress;
    console.log("     ✓ proxy:", addresses.PrivacyRouter);

    // Whitelist new contracts in EventHub
    console.log("\n     Whitelisting in EventHub...");
    const eventHub = (await hre.ethers.getContractFactory("EventHub")).attach(addresses.EventHub);
    const tx = await eventHub.batchWhitelist([
      addresses.GiftMoney,
      addresses.StealthPayments,
      addresses.PrivacyRouter,
    ]);
    await tx.wait(2);
    console.log("     ✓ All whitelisted in EventHub");

    // Set up MockDEX with a reasonable exchange rate
    // 1 USDC (6 decimals) = 400000 "WETH" units (simulated)
    // Rate: 400000 (scaled by 1e6 means 0.4 WETH per USDC at 1e6 precision)
    console.log("\n     Setting MockDEX exchange rate...");
    const mockDex = (await hre.ethers.getContractFactory("MockDEX")).attach(mockDexAddress);
    // Set rate: TestUSDC -> TestUSDC at 1:1 (for testing same-token swaps)
    const setRateTx = await mockDex.setRateBidirectional(
      addresses.TestUSDC,
      addresses.TestUSDC,
      1000000 // 1:1 rate (1e6 = 100%)
    );
    await setRateTx.wait(2);
    console.log("     ✓ Rate set: 1 USDC = 1 USDC (test)");

    // Fund the MockDEX with test tokens for swaps
    console.log("\n     Funding MockDEX with test tokens...");
    const testUsdc = (await hre.ethers.getContractFactory("TestUSDC")).attach(addresses.TestUSDC);
    const mintTx = await testUsdc.mint(mockDexAddress, hre.ethers.parseUnits("100000", 6));
    await mintTx.wait(2);
    console.log("     ✓ Minted 100,000 TestUSDC to MockDEX");

    // Fund PrivacyRouter with plaintext reserves
    console.log("\n     Funding PrivacyRouter reserves...");
    const approveTx = await testUsdc.approve(addresses.PrivacyRouter, hre.ethers.parseUnits("50000", 6));
    await approveTx.wait(2);
    const privacyRouter = (await hre.ethers.getContractFactory("PrivacyRouter")).attach(addresses.PrivacyRouter);
    const fundTx = await privacyRouter.fundReserves(addresses.TestUSDC, hre.ethers.parseUnits("50000", 6));
    await fundTx.wait(2);
    console.log("     ✓ Funded 50,000 TestUSDC to PrivacyRouter");

    saveDeployment(hre.network.name, addresses);

    console.log("\n═══════════════════════════════════════════");
    console.log("  New Features Deployed!");
    console.log("═══════════════════════════════════════════");
    console.log("  MockDEX:          ", addresses.MockDEX);
    console.log("  GiftMoney:        ", addresses.GiftMoney);
    console.log("  StealthPayments:  ", addresses.StealthPayments);
    console.log("  PrivacyRouter:    ", addresses.PrivacyRouter);
    console.log("═══════════════════════════════════════════\n");
  }
);
