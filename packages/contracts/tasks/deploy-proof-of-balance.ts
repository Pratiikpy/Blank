import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

task("deploy-proof-of-balance", "Deploy ProofOfBalance UUPS proxy")
  .setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" :
      networkName === "arb-sepolia" ? "arb-sepolia.json" : null;
    if (!file) throw new Error(`deploy-proof-of-balance: unsupported ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);

    let existing: Record<string, string> = {};
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { throw new Error(`Need deploy-all first. ${err instanceof Error ? err.message : String(err)}`); }

    const [deployer] = await hre.ethers.getSigners();
    console.log(`network=${networkName} deployer=${deployer.address}`);

    const Factory = await hre.ethers.getContractFactory("ProofOfBalance");
    const impl = await Factory.deploy();
    await impl.deploymentTransaction()?.wait(2);
    const implAddress = await impl.getAddress();

    const initData = Factory.interface.encodeFunctionData("initialize", []);
    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const proxy = await ProxyFactory.deploy(implAddress, initData);
    await proxy.deploymentTransaction()?.wait(2);
    const proxyAddress = await proxy.getAddress();

    const next = { ...existing, ProofOfBalance_Impl: implAddress, ProofOfBalance: proxyAddress };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`[proof-of-balance] impl=${implAddress} proxy=${proxyAddress}`);
    console.log(`Pin in packages/app/src/lib/constants.ts:`);
    console.log(`  ProofOfBalance: "${proxyAddress}"`);
  });
