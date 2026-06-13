import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-upgrade-conditional-escrow — conditional invoice build.
 *
 * Ships two pieces:
 *   1. Deploy InvoiceApprovalResolver (plain contract; Reineira's
 *      IConditionResolver standard: release on buyer approval or after an
 *      auto-release deadline).
 *   2. Deploy a new EncryptedEscrow implementation (adds
 *      createConditionalEscrow + releaseIfConditionMet and the appended
 *      _escrowResolver slot) and upgrade the proxy in place.
 *
 * The storage append was re-blessed via `pnpm run storage:write` and verified
 * append-only: slots 0-5 unchanged, _escrowResolver at slot 6, __gap[49] at
 * slot 7. The task aborts if nextEscrowId does not survive the upgrade.
 *
 * Args:
 *   --dry-run : print intended actions without sending txs.
 */
task("deploy-upgrade-conditional-escrow", "Deploy InvoiceApprovalResolver + upgrade EncryptedEscrow")
  .addFlag("dryRun", "Print intended actions without sending txs")
  .setAction(async (args: { dryRun: boolean }, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "arb-sepolia" ? "arb-sepolia.json" :
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!file) throw new Error(`deploy-upgrade-conditional-escrow: unsupported network ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);

    const deployments: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));
    const escrowProxy = deployments.EncryptedEscrow;
    if (!escrowProxy) throw new Error(`deploy-upgrade-conditional-escrow: EncryptedEscrow missing in ${file}`);

    const [deployer] = await hre.ethers.getSigners();
    if (!deployer) throw new Error("deploy-upgrade-conditional-escrow: no signer — set PRIVATE_KEY");
    console.log(`network=${networkName}`);
    console.log(`deployer=${deployer.address}`);
    console.log(`EncryptedEscrow proxy=${escrowProxy}`);

    if (args.dryRun) {
      console.log(`\n[dry-run] would deploy InvoiceApprovalResolver`);
      console.log(`[dry-run] would deploy a new EncryptedEscrow impl`);
      console.log(`[dry-run] would call EncryptedEscrow.upgradeToAndCall(newImpl, 0x)`);
      return;
    }

    // ─── 1. Deploy the resolver ────────────────────────────────────────
    const ResolverFactory = await hre.ethers.getContractFactory("InvoiceApprovalResolver");
    const resolver = await ResolverFactory.deploy();
    await resolver.deploymentTransaction()?.wait(2);
    const resolverAddr = await resolver.getAddress();
    console.log(`[resolver] InvoiceApprovalResolver deployed at ${resolverAddr}`);

    // ─── 2. Deploy the new EncryptedEscrow implementation ──────────────
    const EscrowFactory = await hre.ethers.getContractFactory("EncryptedEscrow");
    const escrowImpl = await EscrowFactory.deploy();
    await escrowImpl.deploymentTransaction()?.wait(2);
    const escrowImplAddr = await escrowImpl.getAddress();
    console.log(`[escrow-impl] new EncryptedEscrow impl at ${escrowImplAddr}`);

    // ─── 3. Upgrade the proxy (owner-gated) ────────────────────────────
    const proxy = await hre.ethers.getContractAt("EncryptedEscrow", escrowProxy, deployer);
    const owner = await proxy.owner();
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`deploy-upgrade-conditional-escrow: deployer ${deployer.address} is not EncryptedEscrow owner ${owner}`);
    }
    const beforeNext = await proxy.nextEscrowId();
    const upgradeTx = await proxy.upgradeToAndCall(escrowImplAddr, "0x");
    console.log(`[escrow-upgrade] tx=${upgradeTx.hash}`);
    await upgradeTx.wait(2);

    // ─── 4. Verify state survived + resolver conforms ──────────────────
    const afterNext = await proxy.nextEscrowId();
    console.log(`[verify] nextEscrowId before=${beforeNext} after=${afterNext} (must match)`);
    if (beforeNext.toString() !== afterNext.toString()) {
      throw new Error("deploy-upgrade-conditional-escrow: nextEscrowId changed across upgrade — state corruption");
    }
    const id1 = BigInt(ResolverFactory.interface.getFunction("isConditionMet")!.selector);
    const id2 = BigInt(ResolverFactory.interface.getFunction("onConditionSet")!.selector);
    const ifaceId = "0x" + (id1 ^ id2).toString(16).padStart(8, "0");
    const conforms = await resolver.supportsInterface(ifaceId);
    console.log(`[verify] resolver supportsInterface(IConditionResolver)=${conforms}`);
    if (!conforms) throw new Error("deploy-upgrade-conditional-escrow: resolver does not advertise IConditionResolver");

    // ─── 5. Persist addresses ──────────────────────────────────────────
    const next = {
      ...deployments,
      InvoiceApprovalResolver: resolverAddr,
      EncryptedEscrow_Impl: escrowImplAddr,
    };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`\n[done] updated ${file}:`);
    console.log(`  InvoiceApprovalResolver = ${resolverAddr}`);
    console.log(`  EncryptedEscrow_Impl    = ${escrowImplAddr}`);
    console.log(`\nNext: add InvoiceApprovalResolver to packages/app/src/lib/constants.ts (arb-sepolia).`);
  });
