import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── deploy-paymaster-v2: verifying BlankPaymaster ───────────────────────
//
// Deploys the verifying BlankPaymaster against the EXISTING
// BlankAccountFactory (account addresses depend on the factory address, so
// the factory is never redeployed here) and configures it:
//   - accountCodeHash = keccak256(ERC1967Proxy runtime code), the code every
//     BlankAccount proxy carries
//   - gas caps, optional per-sender interval, fee config (free by default)
// The old paymaster address is kept as BlankPaymaster_v1.
//
// --signer is the ADDRESS of the backend key held in BLANK_PAYMASTER_SIGNER_PK.
// The key itself never touches this task.
//
// After this: run `setup-aa` to approve targets and fund the deposit, then
// update BlankPaymaster in packages/app (constants.ts, api/_lib/addresses.ts).

const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

task("deploy-paymaster-v2", "Deploy and configure the verifying BlankPaymaster")
  .addParam("signer", "Address of the backend verifying signer")
  .addOptionalParam("maxFeeGwei", "Cap on maxFeePerGas (gwei)", "50")
  .addOptionalParam("maxPriorityGwei", "Cap on maxPriorityFeePerGas (gwei)", "5")
  .addOptionalParam("maxCostEth", "Cap on a single op's maxCost (ETH)", "0.02")
  .addOptionalParam("interval", "Minimum seconds between sponsored ops per sender", "0")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
    if (!fs.existsSync(file)) throw new Error(`No deployment file for ${hre.network.name}`);
    const addresses: Record<string, string> = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!addresses.BlankAccountFactory || !addresses.TestUSDC) {
      throw new Error("BlankAccountFactory / TestUSDC missing from deployment file");
    }
    if (!hre.ethers.isAddress(args.signer) || args.signer === hre.ethers.ZeroAddress) {
      throw new Error("--signer must be a non-zero address");
    }

    const [deployer] = await hre.ethers.getSigners();
    const Paymaster = await hre.ethers.getContractFactory("BlankPaymaster");
    const paymaster = await Paymaster.deploy(
      ENTRYPOINT_V08,
      addresses.TestUSDC,
      deployer.address,
      addresses.BlankAccountFactory,
      args.signer,
    );
    await paymaster.deploymentTransaction()?.wait(2);
    const pmAddress = await paymaster.getAddress();
    console.log(`BlankPaymaster v2: ${pmAddress}`);

    const proxyArtifact = await hre.artifacts.readArtifact(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const codeHash = hre.ethers.keccak256(proxyArtifact.deployedBytecode);
    await (await paymaster.setAccountCodeHash(codeHash)).wait();
    console.log(`  accountCodeHash ${codeHash}`);

    const gwei = (v: string) => hre.ethers.parseUnits(v, "gwei");
    await (await paymaster.setGasCaps(
      gwei(args.maxFeeGwei), gwei(args.maxPriorityGwei), hre.ethers.parseEther(args.maxCostEth),
    )).wait();
    console.log(`  gas caps fee=${args.maxFeeGwei} gwei priority=${args.maxPriorityGwei} gwei cost=${args.maxCostEth} ETH`);

    const interval = Number(args.interval);
    if (interval > 0) {
      await (await paymaster.setSponsorInterval(interval)).wait();
      console.log(`  sponsor interval ${interval}s`);
    }

    if (addresses.BlankPaymaster) addresses.BlankPaymaster_v1 = addresses.BlankPaymaster;
    addresses.BlankPaymaster = pmAddress;
    fs.writeFileSync(file, JSON.stringify(addresses, null, 2) + "\n");
    console.log(`Wrote ${file}. Next: setup-aa, then repoint packages/app to ${pmAddress}.`);
  });
