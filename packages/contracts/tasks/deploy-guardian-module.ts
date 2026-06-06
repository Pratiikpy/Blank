import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * Deploy GuardianModule (Wave 5 Block 3) as a UUPS proxy.
 *
 *   pnpm hardhat deploy-guardian-module --network <chain> --window 600
 *
 * --window default 600s (10 min) for testnet. Mainnet (if ever) should
 * use 86400 (24h). Writes the addresses back to deployments/<chain>.json.
 *
 * After deploy, operator should also call BlankHandles.setRecoveryHook
 * with this module's address so the handle rebind happens automatically
 * on RecoveryFinalized.
 */
task("deploy-guardian-module", "Deploy GuardianModule UUPS proxy")
  .addOptionalParam("window", "Recovery challenge window seconds", "600")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" :
      networkName === "arb-sepolia" ? "arb-sepolia.json" : null;
    if (!file) throw new Error(`deploy-guardian-module: unsupported ${networkName} (use base-sepolia, eth-sepolia, or arb-sepolia)`);
    const path = resolve(__dirname, "..", "deployments", file);

    let existing: Record<string, string> = {};
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { throw new Error(`Need deploy-all first. ${err instanceof Error ? err.message : String(err)}`); }

    const win = Number(args.window);
    if (!Number.isInteger(win) || win < 60 || win > 30 * 24 * 3600) {
      throw new Error(`deploy-guardian-module: --window must be 60..2592000`);
    }

    const [deployer] = await hre.ethers.getSigners();
    console.log(`network=${networkName} deployer=${deployer.address} window=${win}s`);

    const Factory = await hre.ethers.getContractFactory("GuardianModule");
    const impl = await Factory.deploy();
    await impl.deploymentTransaction()?.wait(2);
    const implAddress = await impl.getAddress();

    const initData = Factory.interface.encodeFunctionData("initialize", [win]);
    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const proxy = await ProxyFactory.deploy(implAddress, initData);
    await proxy.deploymentTransaction()?.wait(2);
    const proxyAddress = await proxy.getAddress();

    const next = { ...existing, GuardianModule_Impl: implAddress, GuardianModule: proxyAddress };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`[guardian-module] impl=${implAddress} proxy=${proxyAddress}`);
    console.log(`Wrote ${file}.`);
    console.log(`Next:`);
    console.log(`  1. Pin GuardianModule in packages/app/src/lib/constants.ts`);
    console.log(`  2. Wire BlankHandles.setRecoveryHook(${proxyAddress})`);
    console.log(`  3. Wave 5.5: extend BlankAccount to consume RecoveryFinalized events`);
  });
