import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const TESTNET_WINDOW = 600; // 10 minutes

async function deployProxy(name: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(name);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const initData = initArgs.length > 0
    ? Factory.interface.encodeFunctionData("initialize", initArgs)
    : Factory.interface.encodeFunctionData("initialize");
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as any;
}

async function deployFixture() {
  const [owner, account, g1, g2, g3, g4, newOwner, attacker] = await hre.ethers.getSigners();
  const module = await deployProxy("GuardianModule", [TESTNET_WINDOW]);
  return { owner, account, g1, g2, g3, g4, newOwner, attacker, module };
}

async function seedGuardians(ctx: any) {
  await ctx.module.connect(ctx.account).addGuardian(ctx.g1.address);
  await ctx.module.connect(ctx.account).addGuardian(ctx.g2.address);
  await ctx.module.connect(ctx.account).addGuardian(ctx.g3.address);
  await ctx.module.connect(ctx.account).setThreshold(2);
}

describe("GuardianModule", () => {
  it("rejects addGuardian(0)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.module.connect(ctx.account).addGuardian(hre.ethers.ZeroAddress))
      .to.be.revertedWith("GuardianModule: guardian=0");
  });

  it("rejects self-guardian", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.module.connect(ctx.account).addGuardian(ctx.account.address))
      .to.be.revertedWith("GuardianModule: self-guardian forbidden");
  });

  it("rejects setThreshold below floor or before 3 guardians", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.module.connect(ctx.account).addGuardian(ctx.g1.address);
    await expect(ctx.module.connect(ctx.account).setThreshold(2))
      .to.be.revertedWith("GuardianModule: need 3+ guardians");

    await ctx.module.connect(ctx.account).addGuardian(ctx.g2.address);
    await ctx.module.connect(ctx.account).addGuardian(ctx.g3.address);
    await expect(ctx.module.connect(ctx.account).setThreshold(1))
      .to.be.revertedWith("GuardianModule: threshold floor 2");
    await expect(ctx.module.connect(ctx.account).setThreshold(99))
      .to.be.revertedWith("GuardianModule: threshold > N");
  });

  it("happy path: request + approve to threshold + window-skip + finalize", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);

    await expect(
      ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, ctx.newOwner.address),
    ).to.emit(ctx.module, "RecoveryRequested");

    // g1 auto-approved at request. g2 brings approvals to 2 = threshold.
    await expect(ctx.module.connect(ctx.g2).approveRecovery(ctx.account.address))
      .to.emit(ctx.module, "RecoveryApproved");

    // Can't finalize before window expires.
    await expect(ctx.module.finalizeRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: window open");

    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");

    await expect(ctx.module.finalizeRecovery(ctx.account.address))
      .to.emit(ctx.module, "RecoveryFinalized").withArgs(ctx.account.address, ctx.newOwner.address);

    const state = await ctx.module.recoveryState(ctx.account.address);
    expect(state.finalized).to.equal(true);
  });

  it("veto by any guardian blocks finalize", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, ctx.newOwner.address);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.account.address);

    await expect(ctx.module.connect(ctx.g3).vetoRecovery(ctx.account.address))
      .to.emit(ctx.module, "RecoveryVetoed");

    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");
    await expect(ctx.module.finalizeRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: vetoed");
  });

  it("non-guardian cannot request / approve / veto", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await expect(
      ctx.module.connect(ctx.attacker).requestRecovery(ctx.account.address, ctx.newOwner.address),
    ).to.be.revertedWith("GuardianModule: not guardian");
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, ctx.newOwner.address);
    await expect(ctx.module.connect(ctx.attacker).approveRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: not guardian");
    await expect(ctx.module.connect(ctx.attacker).vetoRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: not guardian");
  });

  it("can't request recovery when not configured", async () => {
    const ctx = await loadFixture(deployFixture);
    // Only 2 guardians, no threshold set.
    await ctx.module.connect(ctx.account).addGuardian(ctx.g1.address);
    await ctx.module.connect(ctx.account).addGuardian(ctx.g2.address);
    await expect(
      ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, ctx.newOwner.address),
    ).to.be.revertedWith("GuardianModule: recovery not configured");
  });

  it("account can cancel its own recovery", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, ctx.newOwner.address);
    await expect(ctx.module.connect(ctx.account).cancelRecovery())
      .to.emit(ctx.module, "RecoveryCancelled");
    const state = await ctx.module.recoveryState(ctx.account.address);
    expect(state.requestedAt).to.equal(0);
  });

  it("approve below threshold => finalize reverts even after window", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, ctx.newOwner.address);
    // Only g1's auto-approval (1) -> below threshold of 2.
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");
    await expect(ctx.module.finalizeRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: below threshold");
  });

  it("removeGuardian preserves correctness and resets threshold below floor", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.account).removeGuardian(ctx.g1.address);
    // 2 guardians left -> threshold reset.
    expect(await ctx.module.thresholdOf(ctx.account.address)).to.equal(0);
    expect(await ctx.module.isGuardian(ctx.account.address, ctx.g1.address)).to.equal(false);
  });

  it("guardiansOf returns the configured list", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    // ethers v6 returns a Result object; spread to a plain array.
    const list = [...(await ctx.module.guardiansOf(ctx.account.address))];
    expect(list).to.have.members([ctx.g1.address, ctx.g2.address, ctx.g3.address]);
  });

  it("hasApproved reflects per-guardian approval state", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, ctx.newOwner.address);
    expect(await ctx.module.hasApproved(ctx.account.address, ctx.g1.address)).to.equal(true);
    expect(await ctx.module.hasApproved(ctx.account.address, ctx.g2.address)).to.equal(false);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.account.address);
    expect(await ctx.module.hasApproved(ctx.account.address, ctx.g2.address)).to.equal(true);
  });
});
