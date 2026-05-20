import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-crowdfund — Wave 4 #257 deploy.
 *
 * UUPS proxy. Wires to existing EventHub. Persists addresses to deployments.
 * Post-deploy: scripts/wire-crowdfund.js for whitelist + PaymentReceipts.
 */
task("deploy-crowdfund", "Deploy EncryptedCrowdfund UUPS proxy")
  .setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!file) throw new Error(`deploy-crowdfund: unsupported ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);

    let existing: Record<string, string> = {};
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { throw new Error(`Need deploy-all first. ${err instanceof Error ? err.message : String(err)}`); }
    const eventHub = existing.EventHub;
    if (!eventHub || eventHub === "0x0000000000000000000000000000000000000000") {
      throw new Error(`deploy-crowdfund: EventHub missing in ${file}`);
    }

    const [deployer] = await hre.ethers.getSigners();
    console.log(`network=${networkName} deployer=${deployer.address} eventHub=${eventHub}`);

    const Factory = await hre.ethers.getContractFactory("EncryptedCrowdfund");
    const impl = await Factory.deploy();
    await impl.deploymentTransaction()?.wait(2);
    const implAddress = await impl.getAddress();
    console.log(`[crowdfund] impl: ${implAddress}`);

    const initData = Factory.interface.encodeFunctionData("initialize", [eventHub]);
    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const proxy = await ProxyFactory.deploy(implAddress, initData);
    await proxy.deploymentTransaction()?.wait(2);
    const proxyAddress = await proxy.getAddress();
    console.log(`[crowdfund] proxy: ${proxyAddress}`);

    const next = { ...existing, EncryptedCrowdfund_Impl: implAddress, EncryptedCrowdfund: proxyAddress };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`[crowdfund] wrote ${file}`);
    console.log(`Next: pnpm hardhat run scripts/wire-crowdfund.js --network ${networkName}`);
  });
