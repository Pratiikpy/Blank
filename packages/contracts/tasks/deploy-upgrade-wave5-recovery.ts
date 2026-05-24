import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-upgrade-wave5-recovery — Wave 5.5
 *
 * Ships two upgrades that complete the guardian-recovery loop:
 *
 *   1. NEW BlankAccount impl — adds setRecoveryModule(address) so
 *      existing user accounts (whose recoveryModule was set to 0x0 in
 *      Wave 4 initialize) can opt into guardian recovery via a passkey-
 *      signed UserOp. Pure code-add, no storage layout change.
 *
 *   2. UPGRADE GuardianModule proxy — adds finalizeRecoveryAndRotate
 *      which calls BlankAccount.setOwner directly. Pure code-add, no
 *      storage layout change. Existing finalizeRecovery still works
 *      for backward-compat indexers.
 *
 * After this task runs:
 *   - GuardianModule proxy serves the new logic immediately on both
 *     chains (one upgrade call per chain).
 *   - BlankAccount impl is deployed but NOT auto-applied to every
 *     existing user proxy. Each user upgrades on their next interaction
 *     via the GasWalletPanel "upgrade available" banner pattern.
 *
 * The deployments JSON is updated with:
 *   - BlankAccount_Impl_wave5_recovery: <new impl address>
 *   - GuardianModule_Impl_wave5_5: <new impl address>
 *
 * Args:
 *   --dry-run : print intended actions without sending txs.
 */
task("deploy-upgrade-wave5-recovery", "Deploy + upgrade Wave 5.5 recovery (BlankAccount + GuardianModule)")
  .addFlag("dryRun", "Print intended actions without sending txs")
  .setAction(async (args: { dryRun: boolean }, hre: HardhatRuntimeEnvironment) => {
    const networkName = hre.network.name;
    const file =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!file) throw new Error(`deploy-upgrade-wave5-recovery: unsupported ${networkName}`);
    const path = resolve(__dirname, "..", "deployments", file);

    const deployments: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));
    const guardianModuleProxy = deployments.GuardianModule;
    if (!guardianModuleProxy) {
      throw new Error(`deploy-upgrade-wave5-recovery: GuardianModule missing in ${file} — run deploy-guardian-module first`);
    }

    const [deployer] = await hre.ethers.getSigners();
    console.log(`network=${networkName}`);
    console.log(`deployer=${deployer.address}`);
    console.log(`GuardianModule proxy=${guardianModuleProxy}`);

    if (args.dryRun) {
      console.log(`\n[dry-run] would deploy:`);
      console.log(`  - BlankAccount impl (with setRecoveryModule)`);
      console.log(`  - GuardianModule impl (with finalizeRecoveryAndRotate)`);
      console.log(`[dry-run] would call GuardianModule.upgradeToAndCall(newImpl, 0x)`);
      return;
    }

    // ─── 1. Deploy new BlankAccount impl ───────────────────────────
    const entryPointAddr = deployments.EntryPoint;
    if (!entryPointAddr) throw new Error("deploy-upgrade-wave5-recovery: EntryPoint missing in deployments");
    const BlankAccountFactory = await hre.ethers.getContractFactory("BlankAccount");
    const blankImpl = await BlankAccountFactory.deploy(entryPointAddr);
    await blankImpl.deploymentTransaction()?.wait(2);
    const blankImplAddr = await blankImpl.getAddress();
    console.log(`[blank-account-impl] deployed at ${blankImplAddr}`);

    // ─── 2. Deploy new GuardianModule impl ────────────────────────
    const GuardianFactory = await hre.ethers.getContractFactory("GuardianModule");
    const guardianImpl = await GuardianFactory.deploy();
    await guardianImpl.deploymentTransaction()?.wait(2);
    const guardianImplAddr = await guardianImpl.getAddress();
    console.log(`[guardian-module-impl] deployed at ${guardianImplAddr}`);

    // ─── 3. Upgrade GuardianModule proxy ───────────────────────────
    const guardianProxy = await hre.ethers.getContractAt("GuardianModule", guardianModuleProxy, deployer);
    const currentOwner = await guardianProxy.owner();
    if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`deploy-upgrade-wave5-recovery: deployer ${deployer.address} is not GuardianModule owner ${currentOwner}`);
    }
    const upgradeTx = await guardianProxy.upgradeToAndCall(guardianImplAddr, "0x");
    console.log(`[guardian-upgrade] tx=${upgradeTx.hash}`);
    await upgradeTx.wait(2);

    // ─── 4. Verify post-upgrade ────────────────────────────────────
    const recoveryWindow = await guardianProxy.RECOVERY_WINDOW_SECONDS();
    console.log(`[verify] RECOVERY_WINDOW_SECONDS=${recoveryWindow}`);

    // ─── 5. Persist new impl addresses ─────────────────────────────
    const next = {
      ...deployments,
      BlankAccount_Impl_wave5_recovery: blankImplAddr,
      GuardianModule_Impl_wave5_5: guardianImplAddr,
    };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");

    console.log(`\nNext steps:`);
    console.log(`  - Update constants.ts:`);
    console.log(`      BlankAccount_Impl_wave5_recovery: "${blankImplAddr}"`);
    console.log(`  - Existing user accounts upgrade lazily: the next time they sign a UserOp,`);
    console.log(`    they can include an upgradeTo(${blankImplAddr}) op to opt in.`);
    console.log(`  - After upgrade, the user calls setRecoveryModule(${guardianModuleProxy}) from`);
    console.log(`    another passkey-signed UserOp. Then they add guardians + set threshold.`);
    console.log(`  - Recovery flow now ends with finalizeRecoveryAndRotate(account, newX, newY)`);
    console.log(`    which rotates the passkey on-chain in one tx.`);
  });
