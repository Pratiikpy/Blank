import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * Deploy BlankHandles (Wave 5 Block 2) as a UUPS proxy.
 *
 *   pnpm hardhat deploy-blank-handles --network <eth-sepolia|base-sepolia>
 *
 * Writes the deployed proxy + impl addresses back to
 * packages/contracts/deployments/<network>.json. Operator then:
 *
 *   1. Pin BlankHandles address in packages/app/src/lib/constants.ts
 *   2. Seed reserved-words list via setReservedList
 *   3. Wire setRecoveryHook once Block 3 ships
 */
task("deploy-blank-handles", "Deploy BlankHandles UUPS proxy")
  .setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" :
      networkName === "arb-sepolia" ? "arb-sepolia.json" : null;
    if (!file) throw new Error(`deploy-blank-handles: unsupported ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);

    let existing: Record<string, string> = {};
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { throw new Error(`Need deploy-all first. ${err instanceof Error ? err.message : String(err)}`); }

    const [deployer] = await hre.ethers.getSigners();
    console.log(`network=${networkName} deployer=${deployer.address}`);

    const Factory = await hre.ethers.getContractFactory("BlankHandles");
    const impl = await Factory.deploy();
    await impl.deploymentTransaction()?.wait(2);
    const implAddress = await impl.getAddress();
    console.log(`[blank-handles] impl: ${implAddress}`);

    const initData = Factory.interface.encodeFunctionData("initialize", []);
    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const proxy = await ProxyFactory.deploy(implAddress, initData);
    await proxy.deploymentTransaction()?.wait(2);
    const proxyAddress = await proxy.getAddress();
    console.log(`[blank-handles] proxy: ${proxyAddress}`);

    const next = { ...existing, BlankHandles_Impl: implAddress, BlankHandles: proxyAddress };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`[blank-handles] wrote ${file}`);
    console.log(`Next:`);
    console.log(`  1. Pin BlankHandles address in packages/app/src/lib/constants.ts`);
    console.log(`  2. Seed reserved-words via setReservedList(hashes, true)`);
    console.log(`  3. Wire setRecoveryHook(<GuardianModule>) once Block 3 ships`);
  });
