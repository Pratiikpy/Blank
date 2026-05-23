import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-p2p-offramp — Wave 5 Block 1 deploy.
 *
 * Ships three UUPS proxies in order:
 *   1. MockReclaimVerifier (fallback when Reclaim sandbox is down)
 *   2. ReclaimAdapter (wraps the verifier with allowlist + replay)
 *   3. P2POfframp (the headline contract)
 *
 * Wires the offramp as an allowed caller on the adapter, sets the
 * arbiter, and whitelists the offramp + adapter on EventHub.
 *
 * Args:
 *   --arbiter  : 3-of-5 multisig address. Owner can rotate post-deploy.
 *   --operator : MockReclaimVerifier's signing operator. Pass
 *                address(0) to ship with the mock disabled so all
 *                traffic must go through a real Reclaim verifier.
 *   --window   : challenge window seconds (default 300 = 5 min for
 *                testnet; 24 hours for mainnet if it ever happens).
 *
 * Persists addresses to deployments/<network>.json.
 */
task("deploy-p2p-offramp", "Deploy MockReclaimVerifier + ReclaimAdapter + P2POfframp UUPS proxies")
  .addParam("arbiter", "Arbiter multisig address")
  .addOptionalParam("operator", "MockReclaimVerifier operator (0x0 = disabled)", "0x0000000000000000000000000000000000000000")
  .addOptionalParam("window", "Challenge window seconds", "300")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!file) throw new Error(`deploy-p2p-offramp: unsupported ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);

    let existing: Record<string, string> = {};
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { throw new Error(`Need deploy-all first. ${err instanceof Error ? err.message : String(err)}`); }

    const eventHub = existing.EventHub;
    if (!eventHub || eventHub === "0x0000000000000000000000000000000000000000") {
      throw new Error(`deploy-p2p-offramp: EventHub missing in ${file}`);
    }

    const [deployer] = await hre.ethers.getSigners();
    const challengeWindow = Number(args.window);
    if (!Number.isInteger(challengeWindow) || challengeWindow < 60 || challengeWindow > 7 * 24 * 3600) {
      throw new Error(`deploy-p2p-offramp: --window must be 60..604800 seconds`);
    }

    console.log(`network=${networkName} deployer=${deployer.address}`);
    console.log(`arbiter=${args.arbiter} operator=${args.operator} window=${challengeWindow}s`);

    // 1) MockReclaimVerifier
    const VerifierFactory = await hre.ethers.getContractFactory("MockReclaimVerifier");
    const verifierImpl = await VerifierFactory.deploy();
    await verifierImpl.deploymentTransaction()?.wait(2);
    const verifierImplAddr = await verifierImpl.getAddress();

    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const verifierInit = VerifierFactory.interface.encodeFunctionData("initialize", [args.operator]);
    const verifierProxy = await ProxyFactory.deploy(verifierImplAddr, verifierInit);
    await verifierProxy.deploymentTransaction()?.wait(2);
    const verifierAddr = await verifierProxy.getAddress();
    console.log(`[mock-reclaim] impl=${verifierImplAddr} proxy=${verifierAddr}`);

    // 2) ReclaimAdapter
    const AdapterFactory = await hre.ethers.getContractFactory("ReclaimAdapter");
    const adapterImpl = await AdapterFactory.deploy();
    await adapterImpl.deploymentTransaction()?.wait(2);
    const adapterImplAddr = await adapterImpl.getAddress();
    const adapterInit = AdapterFactory.interface.encodeFunctionData("initialize", [verifierAddr]);
    const adapterProxy = await ProxyFactory.deploy(adapterImplAddr, adapterInit);
    await adapterProxy.deploymentTransaction()?.wait(2);
    const adapterAddr = await adapterProxy.getAddress();
    console.log(`[reclaim-adapter] impl=${adapterImplAddr} proxy=${adapterAddr}`);

    // 3) P2POfframp
    const OfframpFactory = await hre.ethers.getContractFactory("P2POfframp");
    const offrampImpl = await OfframpFactory.deploy();
    await offrampImpl.deploymentTransaction()?.wait(2);
    const offrampImplAddr = await offrampImpl.getAddress();
    const offrampInit = OfframpFactory.interface.encodeFunctionData("initialize", [
      args.arbiter, adapterAddr, eventHub, challengeWindow,
    ]);
    const offrampProxy = await ProxyFactory.deploy(offrampImplAddr, offrampInit);
    await offrampProxy.deploymentTransaction()?.wait(2);
    const offrampAddr = await offrampProxy.getAddress();
    console.log(`[p2p-offramp] impl=${offrampImplAddr} proxy=${offrampAddr}`);

    // 4) Wire: adapter accepts calls from offramp; eventHub allows
    //         both contracts to emit activity rows.
    const adapter = AdapterFactory.attach(adapterAddr) as any;
    await (await adapter.setCaller(offrampAddr, true)).wait(2);
    console.log(`[wire] adapter.allowedCallers[${offrampAddr}] = true`);

    const eventHubFactory = await hre.ethers.getContractFactory("EventHub");
    const eventHubContract = eventHubFactory.attach(eventHub) as any;
    try {
      await (await eventHubContract.batchWhitelist([offrampAddr, adapterAddr])).wait(2);
      console.log(`[wire] eventHub.batchWhitelist([offramp, adapter])`);
    } catch (err) {
      console.warn(`[wire] eventHub whitelist failed (manual follow-up needed): ${err instanceof Error ? err.message : String(err)}`);
    }

    const next = {
      ...existing,
      MockReclaimVerifier_Impl: verifierImplAddr,
      MockReclaimVerifier: verifierAddr,
      ReclaimAdapter_Impl: adapterImplAddr,
      ReclaimAdapter: adapterAddr,
      P2POfframp_Impl: offrampImplAddr,
      P2POfframp: offrampAddr,
    };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`[deploy-p2p-offramp] wrote ${file}`);
    console.log(`Next:`);
    console.log(`  1. Verify on explorer:`);
    console.log(`     pnpm hardhat verify --network ${networkName} ${offrampAddr}`);
    console.log(`  2. Storage layout baseline:`);
    console.log(`     pnpm hardhat check-storage-layout --write`);
    console.log(`  3. Pin addresses in packages/app/src/lib/constants.ts:`);
    console.log(`       P2POfframp:        ${offrampAddr}`);
    console.log(`       ReclaimAdapter:    ${adapterAddr}`);
    console.log(`       MockReclaimVerifier: ${verifierAddr}`);
  });
