import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-upgrade-cofhe-0-7 — migrate every FHE-touching proxy to the
 * cofhe-contracts 0.2.0 ABI.
 *
 * What changed under the proxies:
 *   - encrypted input from a user is now `externalEuintXX` + a `bytes` batch
 *     signature, replacing the deleted `InEuintXX` struct;
 *   - encrypted values crossing a contract boundary are `sharedEuintXX`,
 *     replacing the `FHE.allowTransient` + bare-handle pattern.
 *
 * Storage layout is unchanged (parameter types are not storage), so every
 * proxy address and all state survive. `pnpm storage:check` gates this.
 *
 * ORDER IS LOAD-BEARING. The vaults and PaymentReceipts are the callees in
 * every shared handoff. A hub upgraded before its vault calls the new
 * `transferFromVerified(sharedEuint64)` against an old implementation that
 * still takes a bare `euint64`; both are `bytes32` on the wire, so it
 * compiles, encodes, and reverts at runtime with NotShared. Callees first.
 *
 * There is an unavoidable window where hubs and vaults disagree. Treat this
 * as a short maintenance window per chain, not a rolling upgrade.
 *
 * Args:
 *   --dry-run  : print intended actions without sending txs.
 *   --only     : comma-separated deployment keys, for resuming a partial run.
 */

/** deployment key -> contract name + a view used to prove state survived */
const UPGRADES: Array<{ key: string; contract: string; probe: string }> = [
  // ─── callees first ───────────────────────────────────────────────────
  { key: "FHERC20Vault_USDC", contract: "FHERC20Vault", probe: "underlyingToken" },
  { key: "FHERC20Vault_USDT", contract: "FHERC20Vault", probe: "underlyingToken" },
  { key: "PaymentReceipts", contract: "PaymentReceipts", probe: "owner" },
  // ─── then every hub that hands a value to them ───────────────────────
  { key: "PaymentHub", contract: "PaymentHub", probe: "nextRequestId" },
  { key: "BusinessHub", contract: "BusinessHub", probe: "nextInvoiceId" },
  { key: "GroupManager", contract: "GroupManager", probe: "owner" },
  { key: "GiftMoney", contract: "GiftMoney", probe: "nextEnvelopeId" },
  { key: "ClaimLinks", contract: "ClaimLinks", probe: "owner" },
  { key: "Storefront", contract: "Storefront", probe: "owner" },
  { key: "EncryptedCrowdfund", contract: "EncryptedCrowdfund", probe: "owner" },
  { key: "EncryptedEscrow", contract: "EncryptedEscrow", probe: "nextEscrowId" },
  { key: "P2PExchange", contract: "P2PExchange", probe: "owner" },
  { key: "P2POfframp", contract: "P2POfframp", probe: "nextOfferId" },
  { key: "PrivacyRouter", contract: "PrivacyRouter", probe: "owner" },
  { key: "CreatorHub", contract: "CreatorHub", probe: "owner" },
  { key: "InheritanceManager", contract: "InheritanceManager", probe: "owner" },
  { key: "StealthPayments", contract: "StealthPayments", probe: "owner" },
  { key: "ProofOfBalance", contract: "ProofOfBalance", probe: "owner" },
  { key: "EncryptedFlags", contract: "EncryptedFlags", probe: "owner" },
];

task("deploy-upgrade-cofhe-0-7", "Upgrade every FHE proxy to the cofhe-contracts 0.2.0 ABI")
  .addFlag("dryRun", "Print intended actions without sending txs")
  .addOptionalParam("only", "Comma-separated deployment keys to upgrade")
  .setAction(async (args: { dryRun: boolean; only?: string }, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "arb-sepolia" ? "arb-sepolia.json" :
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!file) throw new Error(`deploy-upgrade-cofhe-0-7: unsupported network ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);
    const deployments: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));

    const [deployer] = await hre.ethers.getSigners();
    if (!deployer) throw new Error("deploy-upgrade-cofhe-0-7: no signer — set PRIVATE_KEY");

    const filter = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
    const plan = UPGRADES.filter((u) => (filter ? filter.has(u.key) : true))
                         .filter((u) => Boolean(deployments[u.key]));

    console.log(`network=${networkName}`);
    console.log(`deployer=${deployer.address}`);
    console.log(`balance=${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH`);
    console.log(`upgrading ${plan.length} proxies, callees first\n`);

    for (const u of UPGRADES) {
      if (!deployments[u.key]) console.log(`  (skip ${u.key}: not deployed on ${networkName})`);
    }

    if (args.dryRun) {
      for (const u of plan) {
        console.log(`[dry-run] ${u.key} (${u.contract}) proxy=${deployments[u.key]}`);
      }
      return;
    }

    const results: Array<{ key: string; impl: string; tx: string }> = [];
    const next = { ...deployments };

    for (const u of plan) {
      const proxyAddr = deployments[u.key]!;
      console.log(`\n── ${u.key} (${u.contract}) ─────────────────────`);

      const proxy = await hre.ethers.getContractAt(u.contract, proxyAddr, deployer);

      const owner: string = await proxy.owner();
      if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
        throw new Error(`${u.key}: deployer ${deployer.address} is not owner ${owner}`);
      }

      // read the probe BEFORE so we can prove state survived
      const before = await proxy[u.probe]();

      const Factory = await hre.ethers.getContractFactory(u.contract);
      const impl = await Factory.deploy();
      await impl.deploymentTransaction()?.wait(2);
      const implAddr = await impl.getAddress();
      console.log(`   impl=${implAddr}`);

      const tx = await proxy.upgradeToAndCall(implAddr, "0x");
      console.log(`   upgrade tx=${tx.hash}`);
      const rcpt = await tx.wait(2);
      if (rcpt?.status !== 1) throw new Error(`${u.key}: upgrade tx reverted`);

      const after = await proxy[u.probe]();
      if (String(before) !== String(after)) {
        throw new Error(`${u.key}: ${u.probe} changed across upgrade (${before} -> ${after}) — state corruption`);
      }
      console.log(`   verified ${u.probe} survived: ${after}`);

      next[`${u.key}_Impl`] = implAddr;
      results.push({ key: u.key, impl: implAddr, tx: tx.hash });

      // persist after every step so an interrupted run is resumable
      writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    }

    console.log(`\n── done: ${results.length} proxies upgraded on ${networkName} ──`);
    for (const r of results) console.log(`   ${r.key.padEnd(22)} impl=${r.impl}  tx=${r.tx}`);
    console.log(`\nProxy addresses are unchanged. Deployment file updated: ${file}`);
  });
