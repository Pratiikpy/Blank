import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── deploy-aa: ERC-4337 foundation deploy (FRESH chains only) ───────────
//
// Deploys BlankAccountFactory (which deploys the BlankAccount implementation
// in its constructor), then the verifying BlankPaymaster through
// deploy-paymaster-v2 so the paymaster is configured in the same run
// (account code hash, gas caps).
//
// Never run this on a chain that already has users: every account address
// is CREATE2-derived from the factory address, so a new factory gives every
// passkey a different, empty account. To replace only the paymaster, run
// deploy-paymaster-v2 on its own.
//
// After this: setup-aa (deposit), wire-paymaster-targets (allowlist), set
// BLANK_PAYMASTER_SIGNER_PK on the backend, then point packages/app at the
// new addresses.

const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

function deploymentPath(network: string): string {
  return path.join(__dirname, "..", "deployments", `${network}.json`);
}

task("deploy-aa", "Deploy BlankAccountFactory + verifying BlankPaymaster on a fresh chain")
  .addParam("signer", "Address of the paymaster backend verifying signer")
  .addFlag("force", "Deploy even though a BlankAccountFactory is already recorded (strands existing accounts)")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const filePath = deploymentPath(hre.network.name);
    if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${hre.network.name}`);
    const addresses: Record<string, string> = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (addresses.BlankAccountFactory && !args.force) {
      throw new Error(
        `BlankAccountFactory already deployed at ${addresses.BlankAccountFactory}. A new factory moves every ` +
          `account address. Use deploy-paymaster-v2 to replace the paymaster, or pass --force on a chain with no users.`,
      );
    }
    if (!addresses.TestUSDC) throw new Error("TestUSDC address missing from deployment file, deploy-all first");
    if (!hre.ethers.isAddress(args.signer) || args.signer === hre.ethers.ZeroAddress) {
      throw new Error("--signer must be a non-zero address");
    }

    console.log(`network=${hre.network.name} deployer=${deployer.address}`);
    console.log(`balance=${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH`);

    const Factory = await hre.ethers.getContractFactory("BlankAccountFactory");
    const factory = await Factory.deploy(ENTRYPOINT_V08);
    await factory.deploymentTransaction()?.wait(2);
    const factoryAddress = await factory.getAddress();
    const implAddress = await factory.accountImplementation();
    console.log(`BlankAccountFactory ${factoryAddress}`);
    console.log(`BlankAccount impl    ${implAddress}`);

    addresses.EntryPoint = ENTRYPOINT_V08;
    addresses.BlankAccountFactory = factoryAddress;
    addresses.BlankAccount_Impl = implAddress;
    fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2) + "\n");

    // Paymaster deploy + configuration lives in one place.
    await hre.run("deploy-paymaster-v2", { signer: args.signer });
  });
