import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const TESTNET_WINDOW = 86400; // contract floor (24h)
const KEY_X = 0x1234567890abcdefn;
const KEY_Y = 0xfedcba0987654321n;

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

  it("event-only finalizeRecovery is retired", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.module.finalizeRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: retired");
  });

  it("M5 exploit: a single guardian veto no longer blocks a 2-of-3 recovery", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, KEY_X, KEY_Y);
    // g3 alone vetoes before g2 approves: 1 of the 2 votes needed.
    await expect(ctx.module.connect(ctx.g3).vetoRecovery(ctx.account.address))
      .to.emit(ctx.module, "RecoveryVetoVote").withArgs(ctx.account.address, ctx.g3.address, 1, 2)
      .and.not.to.emit(ctx.module, "RecoveryVetoed");
    const state = await ctx.module.recoveryState(ctx.account.address);
    expect(state.vetoed).to.equal(false);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.account.address);
    expect((await ctx.module.recoveryState(ctx.account.address)).approvals).to.equal(2);
  });

  it("veto quorum (N - threshold + 1) blocks the request", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.account).addGuardian(ctx.g4.address);
    await ctx.module.connect(ctx.account).setThreshold(3); // 4 guardians, quorum 2
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, KEY_X, KEY_Y);
    expect(await ctx.module.vetoQuorum(ctx.account.address)).to.equal(2);
    await ctx.module.connect(ctx.g3).vetoRecovery(ctx.account.address);
    await expect(ctx.module.connect(ctx.g4).vetoRecovery(ctx.account.address))
      .to.emit(ctx.module, "RecoveryVetoed");
    await expect(ctx.module.connect(ctx.g2).approveRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: no live request");
  });

  it("M5 exploit: a guardian cannot replace a live request", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, KEY_X, KEY_Y);
    await expect(
      ctx.module.connect(ctx.g2).requestRecovery(ctx.account.address, 7n, 8n),
    ).to.be.revertedWith("GuardianModule: request already live");
  });

  it("a guardian cannot both approve and veto", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, KEY_X, KEY_Y);
    await expect(ctx.module.connect(ctx.g1).vetoRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: already approved");
    await ctx.module.connect(ctx.g3).vetoRecovery(ctx.account.address);
    await expect(ctx.module.connect(ctx.g3).approveRecovery(ctx.account.address))
      .to.be.revertedWith("GuardianModule: already vetoed");
  });

  it("rejects a zero pubkey at request time", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await expect(ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, 0n, 0n))
      .to.be.revertedWith("GuardianModule: zero pubkey");
  });

  it("threshold must be a strict majority", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.account).addGuardian(ctx.g4.address);
    await expect(ctx.module.connect(ctx.account).setThreshold(2))
      .to.be.revertedWith("GuardianModule: threshold below majority");
    await ctx.module.connect(ctx.account).setThreshold(3);
  });

  it("recovery window: setter and initializer enforce the 24h floor", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.module.setRecoveryWindow(60)).to.be.revertedWith("GuardianModule: window bounds");
    await expect(ctx.module.setRecoveryWindow(86399)).to.be.revertedWith("GuardianModule: window bounds");
    await ctx.module.setRecoveryWindow(2 * 86400);
    expect(await ctx.module.effectiveRecoveryWindow()).to.equal(2 * 86400);
    await expect(deployProxy("GuardianModule", [600])).to.be.revertedWith("GuardianModule: window too short");
  });

  it("too many guardians are rejected", async () => {
    const ctx = await loadFixture(deployFixture);
    for (let i = 0; i < 10; i++) {
      await ctx.module.connect(ctx.account).addGuardian(hre.ethers.Wallet.createRandom().address);
    }
    await expect(ctx.module.connect(ctx.account).addGuardian(ctx.g1.address))
      .to.be.revertedWith("GuardianModule: too many guardians");
  });

  it("non-guardian cannot request / approve / veto", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await expect(
      ctx.module.connect(ctx.attacker).requestRecovery(ctx.account.address, KEY_X, KEY_Y),
    ).to.be.revertedWith("GuardianModule: not guardian");
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, KEY_X, KEY_Y);
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
      ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, KEY_X, KEY_Y),
    ).to.be.revertedWith("GuardianModule: recovery not configured");
  });

  it("account can cancel its own recovery", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, KEY_X, KEY_Y);
    await expect(ctx.module.connect(ctx.account).cancelRecovery())
      .to.emit(ctx.module, "RecoveryCancelled");
    const state = await ctx.module.recoveryState(ctx.account.address);
    expect(state.requestedAt).to.equal(0);
  });

  it("removeGuardian preserves correctness and resets threshold below floor", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.account).removeGuardian(ctx.g1.address);
    // 2 guardians left -> threshold reset.
    expect(await ctx.module.thresholdOf(ctx.account.address)).to.equal(0);
    expect(await ctx.module.isGuardian(ctx.account.address, ctx.g1.address)).to.equal(false);
  });

  it("L3: removeGuardian clamps a threshold that would become unreachable", async () => {
    const ctx = await loadFixture(deployFixture);
    await seedGuardians(ctx);
    await ctx.module.connect(ctx.account).addGuardian(ctx.g4.address);
    await ctx.module.connect(ctx.account).setThreshold(4);
    await ctx.module.connect(ctx.account).removeGuardian(ctx.g4.address);
    expect(await ctx.module.thresholdOf(ctx.account.address)).to.equal(3);
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
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.account.address, KEY_X, KEY_Y);
    expect(await ctx.module.hasApproved(ctx.account.address, ctx.g1.address)).to.equal(true);
    expect(await ctx.module.hasApproved(ctx.account.address, ctx.g2.address)).to.equal(false);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.account.address);
    expect(await ctx.module.hasApproved(ctx.account.address, ctx.g2.address)).to.equal(true);
  });
});

// Wave 5.5 — finalizeRecoveryAndRotate: the end-to-end recovery path that
// actually calls BlankAccount.setOwner on-chain. Uses a mock BlankAccount
// because the real one needs an EntryPoint instance.
describe("GuardianModule — Wave 5.5 finalizeRecoveryAndRotate", () => {
  async function deployRotateFixture() {
    const [_owner, g1, g2, g3, g4, attacker, newOwnerAddr] = await hre.ethers.getSigners();
    const module = await deployProxy("GuardianModule", [TESTNET_WINDOW]);

    const MockAccount = await hre.ethers.getContractFactory("MockBlankAccountForRecovery");
    const account = await MockAccount.deploy();
    await account.waitForDeployment();
    // Account opts into recovery via this module — mirrors the real
    // BlankAccount.setRecoveryModule() flow that Wave 5.5 also ships.
    await account.setRecoveryModule(await module.getAddress());

    const accountAddr = await account.getAddress();
    // Account self-configures its guardian set (in production the
    // BlankAccount executes this UserOp via its passkey).
    await hre.network.provider.send("hardhat_setBalance", [accountAddr, "0xDE0B6B3A7640000"]);
    await hre.network.provider.send("hardhat_impersonateAccount", [accountAddr]);
    const accountSigner = await hre.ethers.getSigner(accountAddr);
    await module.connect(accountSigner).addGuardian(g1.address);
    await module.connect(accountSigner).addGuardian(g2.address);
    await module.connect(accountSigner).addGuardian(g3.address);
    await module.connect(accountSigner).setThreshold(2);
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [accountAddr]);

    return { module, account, accountAddr, g1, g2, g3, g4, attacker, newOwnerAddr };
  }

  const PUBKEY_X = 0x1234567890abcdefn;
  const PUBKEY_Y = 0xfedcba0987654321n;

  it("happy path: rotates pubkey on-chain after threshold + window", async () => {
    const ctx = await deployRotateFixture();
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, KEY_X, KEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);

    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");

    expect(await ctx.account.setOwnerCallCount()).to.equal(0n);

    await expect(
      ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y),
    )
      .to.emit(ctx.module, "RecoveryRotated").withArgs(ctx.accountAddr, PUBKEY_X, PUBKEY_Y)
      .and.to.emit(ctx.module, "RecoveryFinalized").withArgs(ctx.accountAddr, hre.ethers.ZeroAddress);

    expect(await ctx.account.ownerX()).to.equal(PUBKEY_X);
    expect(await ctx.account.ownerY()).to.equal(PUBKEY_Y);
    expect(await ctx.account.setOwnerCallCount()).to.equal(1n);
    expect(await ctx.account.lastCaller()).to.equal(await ctx.module.getAddress());
  });

  it("caller must be one of the approving guardians", async () => {
    const ctx = await deployRotateFixture();
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, KEY_X, KEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");

    // g3 didn't approve this session even though they're a guardian.
    await expect(
      ctx.module.connect(ctx.g3).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y),
    ).to.be.revertedWith("GuardianModule: caller did not approve");

    // attacker (non-guardian) also rejected.
    await expect(
      ctx.module.connect(ctx.attacker).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y),
    ).to.be.revertedWith("GuardianModule: caller did not approve");
  });

  it("zero pubkey rejected", async () => {
    const ctx = await deployRotateFixture();
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, KEY_X, KEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");

    await expect(
      ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, 0, 0),
    ).to.be.revertedWith("GuardianModule: zero pubkey");
  });

  it("reverts when recoveryModule not wired on the account", async () => {
    const ctx = await deployRotateFixture();
    // Un-wire by setting recoveryModule to a random address.
    await ctx.account.setRecoveryModule(ctx.attacker.address);

    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, KEY_X, KEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");

    // The BlankAccount.setOwner call reverts with "not recovery module"
    // because our mock's recoveryModule no longer equals the module addr.
    // The whole tx reverts (CEI: r.finalized stays unset → retryable).
    await expect(
      ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y),
    ).to.be.revertedWith("Mock: not recovery module");

    const state = await ctx.module.recoveryState(ctx.accountAddr);
    expect(state.finalized).to.equal(false);
  });

  it("cannot rotate twice (finalized flag latches)", async () => {
    const ctx = await deployRotateFixture();
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, KEY_X, KEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");

    await ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y);
    await expect(
      ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y),
    ).to.be.revertedWith("GuardianModule: already finalized");
  });

  it("quorum veto blocks rotate even after window", async () => {
    const ctx = await deployRotateFixture();
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, PUBKEY_X, PUBKEY_Y);
    await ctx.module.connect(ctx.g2).vetoRecovery(ctx.accountAddr);
    await ctx.module.connect(ctx.g3).vetoRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");

    await expect(
      ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y),
    ).to.be.revertedWith("GuardianModule: vetoed");
  });

  it("H3 exploit: finalizer cannot swap in a key the guardians did not approve", async () => {
    const ctx = await deployRotateFixture();
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, PUBKEY_X, PUBKEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");
    await expect(
      ctx.module.connect(ctx.g2).finalizeRecoveryAndRotate(ctx.accountAddr, 111n, 222n),
    ).to.be.revertedWith("GuardianModule: key mismatch");
    expect(await ctx.account.setOwnerCallCount()).to.equal(0n);
    expect(await ctx.module.recoveryKeyHash(ctx.accountAddr)).to.equal(
      hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [PUBKEY_X, PUBKEY_Y])),
    );
  });

  it("M3 exploit: recovery can run a second time after a finalized one", async () => {
    const ctx = await deployRotateFixture();
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, PUBKEY_X, PUBKEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");
    await ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y);

    await ctx.module.connect(ctx.g3).requestRecovery(ctx.accountAddr, 33n, 44n);
    // Approvals from the first request do not carry over.
    expect(await ctx.module.hasApproved(ctx.accountAddr, ctx.g1.address)).to.equal(false);
    await ctx.module.connect(ctx.g1).approveRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");
    await ctx.module.connect(ctx.g3).finalizeRecoveryAndRotate(ctx.accountAddr, 33n, 44n);
    expect(await ctx.account.ownerX()).to.equal(33n);
    expect(await ctx.account.setOwnerCallCount()).to.equal(2n);
  });

  it("L3 exploit: approvals from removed guardians do not count", async () => {
    const ctx = await deployRotateFixture();
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, PUBKEY_X, PUBKEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);

    await hre.network.provider.send("hardhat_impersonateAccount", [ctx.accountAddr]);
    const acct = await hre.ethers.getSigner(ctx.accountAddr);
    await ctx.module.connect(acct).addGuardian(ctx.g4.address);
    await ctx.module.connect(acct).removeGuardian(ctx.g2.address);
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [ctx.accountAddr]);

    expect((await ctx.module.recoveryState(ctx.accountAddr)).approvals).to.equal(1);
    await hre.network.provider.send("evm_increaseTime", [TESTNET_WINDOW + 1]);
    await hre.network.provider.send("evm_mine");
    await expect(
      ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y),
    ).to.be.revertedWith("GuardianModule: below threshold");
  });

  it("window floor applies to proxies initialized with a short window", async () => {
    const ctx = await deployRotateFixture();
    // Simulate a legacy proxy whose stored window is 600s.
    await hre.network.provider.send("hardhat_setStorageAt", [
      await ctx.module.getAddress(), "0x2", hre.ethers.zeroPadValue("0x0258", 32),
    ]);
    expect(await ctx.module.RECOVERY_WINDOW_SECONDS()).to.equal(600);
    expect(await ctx.module.effectiveRecoveryWindow()).to.equal(86400);
    await ctx.module.connect(ctx.g1).requestRecovery(ctx.accountAddr, PUBKEY_X, PUBKEY_Y);
    await ctx.module.connect(ctx.g2).approveRecovery(ctx.accountAddr);
    await hre.network.provider.send("evm_increaseTime", [601]);
    await hre.network.provider.send("evm_mine");
    await expect(
      ctx.module.connect(ctx.g1).finalizeRecoveryAndRotate(ctx.accountAddr, PUBKEY_X, PUBKEY_Y),
    ).to.be.revertedWith("GuardianModule: window open");
  });
});
