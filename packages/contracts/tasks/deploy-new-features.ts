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

    // Set up MockDEX exchange rate. The contract takes a bidirectional pair
    // (tokenA, tokenB, forwardRate, reverseRate) and reverts on tokenA == tokenB,
    // so a rate is only set when two distinct tokens exist. TestUSDT ships in
    // deploy-second-vault (a later step), so on a fresh run only TestUSDC is
    // present here and the same-token placeholder is skipped — the private-swap
    // demo is wired separately on chains that enable a second-token swap.
    const mockDex = (await hre.ethers.getContractFactory("MockDEX")).attach(mockDexAddress);
    const rateTokenA = addresses.TestUSDC;
    const rateTokenB = addresses.TestUSDT ?? addresses.TestUSDC;
    if (rateTokenA && rateTokenB && rateTokenA.toLowerCase() !== rateTokenB.toLowerCase()) {
      console.log("\n     Setting MockDEX exchange rate (USDC <-> USDT 1:1)...");
      const setRateTx = await mockDex.setRateBidirectional(
        rateTokenA,
        rateTokenB,
        1000000, // forward 1:1 (1e6 = 100%)
        1000000, // reverse 1:1
      );
      await setRateTx.wait(2);
      console.log("     ✓ Rate set: 1 USDC = 1 USDT (test)");
    } else {
      console.log("\n     Skipping MockDEX rate: only one token deployed (same-token rate is disallowed by the contract)");
    }

    // Fund the MockDEX with test tokens for swaps
    console.log("\n     Funding MockDEX with test tokens...");
    const testUsdc = (await hre.ethers.getContractFactory("TestUSDC")).attach(addresses.TestUSDC);
    const mintTx = await testUsdc.mint(mockDexAddress, hre.ethers.parseUnits("100000", 6));
    await mintTx.wait(2);
    console.log("     ✓ Minted 100,000 TestUSDC to MockDEX");

    // Fund PrivacyRouter with plaintext reserves. fundReserves pulls the
    // tokens from msg.sender, so the deployer must hold them first. On a
    // fresh chain the deployer has no TestUSDC (the open mint above only
    // funded MockDEX), so mint the reserve amount to the deployer here.
    console.log("\n     Funding PrivacyRouter reserves...");
    const mintSelfTx = await testUsdc.mint(deployer.address, hre.ethers.parseUnits("50000", 6));
    await mintSelfTx.wait(2);
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
