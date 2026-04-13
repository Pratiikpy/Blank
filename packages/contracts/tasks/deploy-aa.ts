import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── deploy-aa — ERC-4337 foundation deploy ──────────────────────────────
//
// Deploys the BlankAccount + BlankAccountFactory + BlankPaymaster trio to
// the target chain. The EntryPoint v0.8 address is constant across all
// EVM chains (CREATE2-deployed deterministically) — we don't deploy it.
//
// Output: appends the addresses to `deployments/<network>.json` so the
// frontend / relayer can read them.
//
// Post-deploy required steps (handled by the relayer/UI later):
//   - paymaster.setApprovedTarget(...) for every Blank hub
//   - paymaster.deposit() with ETH for sponsoring
//   - frontend computes counterfactual addresses via factory.getAddress()

const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

// Default paymaster config — these are reasonable defaults for testnet.
// In production: set per-chain fee caps based on actual gas economics.
const DEFAULT_FEE_RATE_BPS = 100;        // 1% of transferred value
const DEFAULT_MAX_FEE_CAP_USDC = 1n * 10n ** 6n; // 1 USDC max per tx

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

task("deploy-aa", "Deploy ERC-4337 BlankAccount + Factory + Paymaster").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const addresses = loadDeployment(hre.network.name);

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — ERC-4337 Foundation Deploy");
    console.log("═══════════════════════════════════════════");
    console.log("  Deployer:  ", deployer.address);
    console.log("  Network:   ", hre.network.name);
    console.log("  Balance:   ", hre.ethers.formatEther(balance), "ETH");
    console.log("  EntryPoint:", ENTRYPOINT_V08);
    console.log("  TestUSDC:  ", addresses.TestUSDC);
    console.log("═══════════════════════════════════════════\n");

    if (!addresses.TestUSDC) {
      throw new Error("TestUSDC address missing from deployment file — deploy-all first");
    }

    // 1. BlankAccountFactory (also deploys BlankAccount implementation in its constructor)
    console.log("1/2  Deploying BlankAccountFactory...");
    const Factory = await hre.ethers.getContractFactory("BlankAccountFactory");
    const factory = await Factory.deploy(ENTRYPOINT_V08);
    await factory.deploymentTransaction()?.wait(2);
    const factoryAddress = await factory.getAddress();
    const implAddress = await factory.accountImplementation();
    console.log("     ✓ Factory:        ", factoryAddress);
    console.log("     ✓ Account impl:   ", implAddress);

    // 2. BlankPaymaster — fee token = TestUSDC, treasury = deployer (override later)
    console.log("\n2/2  Deploying BlankPaymaster...");
    const Paymaster = await hre.ethers.getContractFactory("BlankPaymaster");
    const paymaster = await Paymaster.deploy(
      ENTRYPOINT_V08,
      addresses.TestUSDC,
      deployer.address, // treasury — override post-deploy via setTreasury
      DEFAULT_MAX_FEE_CAP_USDC,
      factoryAddress,
    );
    await paymaster.deploymentTransaction()?.wait(2);
    const paymasterAddress = await paymaster.getAddress();
    console.log("     ✓ Paymaster:      ", paymasterAddress);
    console.log("     fee rate:        ", DEFAULT_FEE_RATE_BPS, "bps (1%)");
    console.log("     max fee cap:     ", DEFAULT_MAX_FEE_CAP_USDC.toString(), "USDC units");
    console.log("     approved factory:", factoryAddress);
    console.log("     treasury:        ", deployer.address, "(override via setTreasury)");

    // Save addresses
    addresses.EntryPoint = ENTRYPOINT_V08;
    addresses.BlankAccountFactory = factoryAddress;
    addresses.BlankAccount_Impl = implAddress;
    addresses.BlankPaymaster = paymasterAddress;
    saveDeployment(hre.network.name, addresses);

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  AA Foundation Deploy Complete");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("\n  Next steps (separate session — UI + relayer):");
    console.log("    1. Build WebAuthn signup flow in /app");
    console.log("    2. Add /api/relay endpoint for sponsoring UserOps");
    console.log("    3. Approve targets:");
    console.log("       paymaster.setApprovedTarget(PaymentHub, true)");
    console.log("       paymaster.setApprovedTarget(FHERC20Vault_USDC, true)");
    console.log("       (etc. for every hub Blank wants to sponsor)");
    console.log("    4. Fund paymaster with ETH:");
    console.log("       paymaster.deposit{value: 0.05 ether}() // testnet sponsorship");
    console.log("    5. Wire useShield / useSendPayment / etc. to route through AA");
    console.log("       when user is on a smart account vs an EOA.\n");
  }
);
