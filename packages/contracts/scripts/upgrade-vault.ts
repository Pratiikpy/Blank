import { ethers } from "hardhat";

async function main() {
  const signer = (await ethers.getSigners())[0];
  const bal = await ethers.provider.getBalance(signer.address);
  console.log("Deployer:", signer.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH");

  if (bal < ethers.parseEther("0.001")) {
    console.log("ERROR: Deployer has insufficient ETH for deployment");
    process.exit(1);
  }

  // Deploy new FHERC20Vault implementation with allowBalanceReader
  console.log("\nDeploying new FHERC20Vault implementation...");
  const Factory = await ethers.getContractFactory("FHERC20Vault");
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("New impl:", implAddr);

  // Upgrade USDC vault proxy on Base Sepolia
  const USDC_VAULT = "0x789f0bC466E172eD737493e9796a6d0a3aB0ff23";
  console.log(`\nUpgrading USDC vault proxy ${USDC_VAULT}...`);
  const proxy = await ethers.getContractAt("FHERC20Vault", USDC_VAULT);
  const tx = await proxy.upgradeToAndCall(implAddr, "0x");
  await tx.wait();
  console.log("Upgrade tx:", tx.hash);

  // Also upgrade USDT vault if it exists
  const USDT_VAULT = "0x7Af02f6e1759a7b6219fCc69a8dd430ACb453861";
  try {
    console.log(`\nUpgrading USDT vault proxy ${USDT_VAULT}...`);
    const proxy2 = await ethers.getContractAt("FHERC20Vault", USDT_VAULT);
    const tx2 = await proxy2.upgradeToAndCall(implAddr, "0x");
    await tx2.wait();
    console.log("USDT upgrade tx:", tx2.hash);
  } catch (e: any) {
    console.log("USDT vault upgrade skipped:", e.message?.slice(0, 60));
  }

  console.log("\nFHERC20Vault upgraded with allowBalanceReader on Base Sepolia!");
}

main().catch((e) => { console.error(e); process.exit(1); });
