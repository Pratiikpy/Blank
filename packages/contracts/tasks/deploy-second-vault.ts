import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// Deploy a 2nd ERC20 (TestUSDT) + matching FHERC20Vault so P2PExchange has
// two tokens to trade between (the contract requires tokenGive ≠ tokenWant).
// Idempotent: re-running adds the new addresses without touching existing ones.

async function deployProxy(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  initArgs: unknown[] = [],
) {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const impl = await Factory.deploy();
  const implReceipt = await impl.deploymentTransaction()?.wait(2);
  const implAddress = await impl.getAddress();
  console.log("     impl:", implAddress, "block:", implReceipt?.blockNumber);

  const initData = Factory.interface.encodeFunctionData("initialize", initArgs);
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.deploymentTransaction()?.wait(2);
  const proxyAddress = await proxy.getAddress();
  return { implAddress, proxyAddress };
}

task("deploy-second-vault", "Deploy TestUSDT + FHERC20Vault_USDT for swap testing")
  .setAction(async (_, hre: HardhatRuntimeEnvironment) => {
    const network = hre.network.name === "base-sepolia" ? "base-sepolia" : hre.network.name;
    const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
    const existing: Record<string, string> = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, "utf8"))
      : {};

    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("═══════════════════════════════════════════");
    console.log("  Deploy 2nd vault — network:", network);
    console.log("  Deployer:", deployer.address);
    console.log("  Balance :", hre.ethers.formatEther(balance), "ETH");
    console.log("═══════════════════════════════════════════\n");

    if (!existing.EventHub) throw new Error("EventHub not yet deployed — run deploy-all first");

    // ─── 1. Deploy a 2nd ERC20 token (TestUSDT) ────────────────────────
    // We reuse the TestUSDC contract (same shape: mint/faucet, 6 decimals)
    // — the underlying token's symbol doesn't matter to the FHE vault, only
    // its decimals. The vault carries its own display name/symbol.
    console.log("1/3  Deploying TestUSDT (uses TestUSDC bytecode, 6 decimals)...");
    const TestToken = await hre.ethers.getContractFactory("TestUSDC");
    const testUSDT = await TestToken.deploy();
    await testUSDT.deploymentTransaction()?.wait(2);
    existing.TestUSDT = await testUSDT.getAddress();
    console.log("     ✓", existing.TestUSDT);

    // ─── 2. Deploy FHERC20Vault for USDT ──────────────────────────────
    console.log("\n2/3  Deploying FHERC20Vault for USDT (UUPS)...");
    const vault = await deployProxy(hre, "FHERC20Vault", [
      existing.TestUSDT,
      "Encrypted USDT",
      "eUSDT",
      6,
      existing.EventHub,
    ]);
    existing.FHERC20Vault_USDT_Impl = vault.implAddress;
    existing.FHERC20Vault_USDT = vault.proxyAddress;
    console.log("     ✓ proxy:", existing.FHERC20Vault_USDT);

    // ─── 3. Whitelist the new vault in EventHub ────────────────────────
    console.log("\n3/3  Whitelisting USDT vault in EventHub...");
    const eventHubContract = (await hre.ethers.getContractFactory("EventHub")).attach(
      existing.EventHub,
    );
    const tx = await eventHubContract.batchWhitelist([existing.FHERC20Vault_USDT]);
    await tx.wait(2);
    console.log("     ✓ Whitelisted");

    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    console.log("\n═══════════════════════════════════════════");
    console.log("  Saved to:", filePath);
    console.log("  TestUSDT          :", existing.TestUSDT);
    console.log("  FHERC20Vault_USDT :", existing.FHERC20Vault_USDT);
    console.log("═══════════════════════════════════════════");
  });
