import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";
import { SELF_ADMIN_ABI, wireSelfAdminApprovals } from "./lib/paymaster-targets";

// ─── deploy-paymaster-v2: verifying BlankPaymaster ───────────────────────
//
// Deploys the verifying BlankPaymaster against the EXISTING
// BlankAccountFactory (account addresses depend on the factory address, so
// the factory is never redeployed here) and configures it:
//   - accountCodeHash = keccak256(ERC1967Proxy runtime code), the code every
//     BlankAccount proxy carries
//   - gas caps, optional per-sender interval, fee config (free by default)
//   - self-call approvals: BlankAccount_Impl_security_v1 (upgrade),
//     SessionKeyValidator (enableValidator), GuardianModule (setRecoveryModule)
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
  .addOptionalParam("sample", "An existing BlankAccount proxy to read the account code hash from")
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

    // The code hash must be that of the proxies THIS factory deploys. The
    // factory was compiled and deployed earlier, possibly with a different
    // compiler build than today's artifacts, so read it from a real proxy
    // instead of trusting the local artifact. --sample names an existing
    // account; otherwise a throwaway probe account (fixed dummy key, unusable
    // owner) is created once via the factory and reused on later runs.
    const factory = await hre.ethers.getContractAt("BlankAccountFactory", addresses.BlankAccountFactory);
    let sample: string = args.sample ?? "";
    if (!sample) {
      const PROBE_SALT = BigInt(hre.ethers.id("blank-paymaster-codehash-probe"));
      sample = await factory["getAddress(uint256,uint256,address,uint256)"](1n, 1n, hre.ethers.ZeroAddress, PROBE_SALT);
      if ((await hre.ethers.provider.getCode(sample)) === "0x") {
        await (await factory.createAccount(1n, 1n, hre.ethers.ZeroAddress, PROBE_SALT)).wait(2);
        console.log(`  created code-hash probe account ${sample}`);
      }
    }
    const runtime = await hre.ethers.provider.getCode(sample);
    if (runtime === "0x") throw new Error(`no code at sample account ${sample}`);
    const codeHash = hre.ethers.keccak256(runtime);
    const proxyArtifact = await hre.artifacts.readArtifact(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const artifactHash = hre.ethers.keccak256(proxyArtifact.deployedBytecode);
    if (artifactHash !== codeHash) {
      console.log(`  note: live proxy code hash differs from the local artifact (${artifactHash}); using the live one`);
    }
    await (await paymaster.setAccountCodeHash(codeHash)).wait();
    console.log(`  accountCodeHash ${codeHash} (from ${sample})`);

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

    // Self-calls new accounts need to adopt the current implementation and
    // modules without ETH (tasks/lib/paymaster-targets.ts).
    console.log(`  self-call approvals:`);
    const selfAdmin = new hre.ethers.Contract(pmAddress, SELF_ADMIN_ABI, deployer);
    await wireSelfAdminApprovals(selfAdmin, addresses);

    if (addresses.BlankPaymaster) addresses.BlankPaymaster_v1 = addresses.BlankPaymaster;
    addresses.BlankPaymaster = pmAddress;
    fs.writeFileSync(file, JSON.stringify(addresses, null, 2) + "\n");
    console.log(`Wrote ${file}.`);
    console.log(`Next:`);
    console.log(`  1. setup-aa (fund the deposit) and wire-paymaster-targets (allowlist)`);
    console.log(`  2. set BLANK_PAYMASTER_SIGNER_PK on Vercel to the key for ${args.signer}`);
    console.log(`  3. repoint BlankPaymaster in packages/app (constants.ts, api/_lib/addresses.ts) to ${pmAddress}`);
    console.log(`  4. GET /api/paymaster/sponsor?chainId=${hre.network.config.chainId} must report ready: true`);
  });
