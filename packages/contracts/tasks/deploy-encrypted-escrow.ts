import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-encrypted-escrow — Wave 4 #249.
 * UUPS proxy. Persists addresses + post-deploys via wire-encrypted-escrow.js.
 */
task("deploy-encrypted-escrow", "Deploy EncryptedEscrow UUPS proxy")
  .setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file = networkName === "base-sepolia" ? "base-sepolia.json"
      : networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!file) throw new Error(`unsupported ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);

    let existing: Record<string, string> = {};
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { throw new Error(`Need deploy-all first. ${err instanceof Error ? err.message : String(err)}`); }
    const eventHub = existing.EventHub;
    if (!eventHub || eventHub === "0x0000000000000000000000000000000000000000") {
      throw new Error(`EventHub missing in ${file}`);
    }

    const [deployer] = await hre.ethers.getSigners();
    console.log(`[encrypted-escrow] network=${networkName} deployer=${deployer.address}`);

    const Factory = await hre.ethers.getContractFactory("EncryptedEscrow");
    const impl = await Factory.deploy();
    await impl.deploymentTransaction()?.wait(2);
    const implAddress = await impl.getAddress();
    console.log(`[encrypted-escrow] impl: ${implAddress}`);

    const initData = Factory.interface.encodeFunctionData("initialize", [eventHub]);
    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const proxy = await ProxyFactory.deploy(implAddress, initData);
    await proxy.deploymentTransaction()?.wait(2);
    const proxyAddress = await proxy.getAddress();
    console.log(`[encrypted-escrow] proxy: ${proxyAddress}`);

    const next = { ...existing, EncryptedEscrow_Impl: implAddress, EncryptedEscrow: proxyAddress };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`[encrypted-escrow] wrote ${file}`);
  });
