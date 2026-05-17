import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const STATUS_OPEN = 0;
const STATUS_CLOSED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDING = 3;

async function deployProxy(contractName: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const initData =
    initArgs.length > 0
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
  const [owner, alice, bob, charlie, dave] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const testUSDC = await TestUSDC.deploy();
  await testUSDC.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await testUSDC.getAddress(), "Blank USDC Vault", "bvUSDC", USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const crowdfund = await deployProxy("EncryptedCrowdfund", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await crowdfund.getAddress()]);

  for (const signer of [alice, bob, charlie, dave]) {
    await testUSDC.mint(signer.address, usdc(10_000));
    await testUSDC.connect(signer).approve(await vault.getAddress(), usdc(10_000));
    await vault.connect(signer).shield(usdc(1_000));
  }

  const MAX = (1n << 64n) - 1n;
  for (const signer of [alice, bob, charlie, dave]) {
    await vault.connect(signer).approvePlaintext(await crowdfund.getAddress(), MAX);
  }

  return { owner, alice, bob, charlie, dave, client, testUSDC, vault, crowdfund };
}

async function encUint64(client: any, signer: any, amount: bigint) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const [enc] = await client.encryptInputs([Encryptable.uint64(amount)]).execute();
  return enc;
}

describe("EncryptedCrowdfund", () => {
  it("creates a campaign", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100));
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(),
      encGoal,
      7 * 86400,
      "Save the bees",
      ZERO_BYTES32,
    );
    const c = await ctx.crowdfund.getCampaign(0);
    expect(c.creator).to.equal(ctx.alice.address);
    expect(c.title).to.equal("Save the bees");
    expect(c.status).to.equal(STATUS_OPEN);
  });

  it("rejects bad duration", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(1));
    await expect(
      ctx.crowdfund.connect(ctx.alice).createCampaign(await ctx.vault.getAddress(), enc, 60, "x", ZERO_BYTES32),
    ).to.be.revertedWith("Crowdfund: bad duration");
  });

  it("contributors add to encrypted total", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100));
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), encGoal, 7 * 86400, "C", ZERO_BYTES32,
    );

    const c1 = await encUint64(ctx.client, ctx.bob, usdc(40));
    await ctx.crowdfund.connect(ctx.bob).contribute(0, c1);
    const c2 = await encUint64(ctx.client, ctx.charlie, usdc(30));
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, c2);

    expect(await ctx.crowdfund.getContributionCount(0)).to.equal(2);

    // Funds locked in the contract.
    const sfBalance = await ctx.vault.balanceOf(await ctx.crowdfund.getAddress());
    await mock_expectPlaintext(ctx.alice.provider, sfBalance, usdc(70));
  });

  it("creator cannot contribute to own campaign", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100));
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), encGoal, 3600, "C", ZERO_BYTES32,
    );
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10));
    await expect(
      ctx.crowdfund.connect(ctx.alice).contribute(0, enc),
    ).to.be.revertedWith("Crowdfund: creator cannot contribute");
  });

  it("happy path: goal met → creator releases", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(50));
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), encGoal, 3600, "Goal-met", ZERO_BYTES32,
    );

    const c1 = await encUint64(ctx.client, ctx.bob, usdc(40));
    await ctx.crowdfund.connect(ctx.bob).contribute(0, c1);
    const c2 = await encUint64(ctx.client, ctx.charlie, usdc(20));
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, c2);

    // 60 raised >= 50 goal → success.
    await time.increase(3601);
    await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

    // Decrypt off-chain + publish result.
    const handle = await ctx.crowdfund.getGoalCheckHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.crowdfund.connect(ctx.dave).publishCloseResult(0, Boolean(proof.decryptedValue), proof.signature);

    const c = await ctx.crowdfund.getCampaign(0);
    expect(c.goalMet).to.equal(true);
    expect(c.status).to.equal(STATUS_RELEASED);

    // Alice claims release: contract -> alice.
    const aliceBefore = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBefore, usdc(1_000));
    await ctx.crowdfund.connect(ctx.alice).claimRelease(0);
    const aliceAfter = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceAfter, usdc(1_060));
  });

  it("failure path: goal NOT met → contributors refund", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(500));
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), encGoal, 3600, "Fails", ZERO_BYTES32,
    );

    const c1 = await encUint64(ctx.client, ctx.bob, usdc(40));
    await ctx.crowdfund.connect(ctx.bob).contribute(0, c1);
    const c2 = await encUint64(ctx.client, ctx.charlie, usdc(20));
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, c2);

    // 60 raised < 500 goal → failure.
    await time.increase(3601);
    await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

    const handle = await ctx.crowdfund.getGoalCheckHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.crowdfund.connect(ctx.dave).publishCloseResult(0, Boolean(proof.decryptedValue), proof.signature);

    const c = await ctx.crowdfund.getCampaign(0);
    expect(c.goalMet).to.equal(false);
    expect(c.status).to.equal(STATUS_REFUNDING);

    // Alice cannot release.
    await expect(
      ctx.crowdfund.connect(ctx.alice).claimRelease(0),
    ).to.be.revertedWith("Crowdfund: goal not met");

    // Bob + charlie refund.
    await ctx.crowdfund.connect(ctx.bob).claimRefund(0, 0);
    await ctx.crowdfund.connect(ctx.charlie).claimRefund(0, 1);

    const bobAfter = await ctx.vault.balanceOf(ctx.bob.address);
    const charlieAfter = await ctx.vault.balanceOf(ctx.charlie.address);
    await mock_expectPlaintext(ctx.bob.provider, bobAfter, usdc(1_000));
    await mock_expectPlaintext(ctx.charlie.provider, charlieAfter, usdc(1_000));

    // Idempotent — bob can't double-refund.
    await expect(
      ctx.crowdfund.connect(ctx.bob).claimRefund(0, 0),
    ).to.be.revertedWith("Crowdfund: already refunded");
  });

  it("cannot contribute past deadline", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100));
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), encGoal, 3600, "Past", ZERO_BYTES32,
    );
    await time.increase(3601);
    const enc = await encUint64(ctx.client, ctx.bob, usdc(10));
    await expect(
      ctx.crowdfund.connect(ctx.bob).contribute(0, enc),
    ).to.be.revertedWith("Crowdfund: past deadline");
  });

  // §2.2 of BEST_VERSION_FULL_PLAN: zero-contributions close grief.
  it("rejects close on a campaign with zero contributions", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100));
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), encGoal, 3600, "Empty", ZERO_BYTES32,
    );
    await time.increase(3601);

    // No contributors. Without the §2.2 guard, FHE.gte(0, encGoal)
    // would evaluate, c.goalCheck would store, and downstream events would
    // signal a fake "successful campaign" to indexers.
    await expect(
      ctx.crowdfund.connect(ctx.dave).closeCampaign(0),
    ).to.be.revertedWith("Crowdfund: no contributions to close against");
  });

  // §15.3.1: double-publish must revert.
  it("rejects publishCloseResult called twice on the same campaign", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(50));
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), encGoal, 3600, "Double-publish", ZERO_BYTES32,
    );

    const c1 = await encUint64(ctx.client, ctx.bob, usdc(40));
    await ctx.crowdfund.connect(ctx.bob).contribute(0, c1);
    const c2 = await encUint64(ctx.client, ctx.charlie, usdc(20));
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, c2);

    await time.increase(3601);
    await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

    const handle = await ctx.crowdfund.getGoalCheckHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();

    await ctx.crowdfund.connect(ctx.dave).publishCloseResult(0, Boolean(proof.decryptedValue), proof.signature);

    // Second publish must revert. The resultPublished guard fires first.
    await expect(
      ctx.crowdfund.connect(ctx.dave).publishCloseResult(0, Boolean(proof.decryptedValue), proof.signature),
    ).to.be.revertedWith("Crowdfund: already published");
  });

  // §15.3.1: state-change events on each lifecycle transition.
  describe("State-change events", () => {
    it("emits CampaignCreated on createCampaign", async () => {
      const ctx = await loadFixture(deployFixture);
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100));

      await expect(
        ctx.crowdfund.connect(ctx.alice).createCampaign(
          await ctx.vault.getAddress(), encGoal, 3600, "with note", ZERO_BYTES32,
        ),
      ).to.emit(ctx.crowdfund, "CampaignCreated");
    });

    it("emits Contributed on contribute", async () => {
      const ctx = await loadFixture(deployFixture);
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100));
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(), encGoal, 3600, "C", ZERO_BYTES32,
      );

      const c1 = await encUint64(ctx.client, ctx.bob, usdc(40));
      await expect(ctx.crowdfund.connect(ctx.bob).contribute(0, c1))
        .to.emit(ctx.crowdfund, "Contributed");
    });

    it("emits CampaignClosed + CloseResultPublished + CampaignReleased on goal-met flow", async () => {
      const ctx = await loadFixture(deployFixture);
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(50));
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(), encGoal, 3600, "Met", ZERO_BYTES32,
      );

      const c1 = await encUint64(ctx.client, ctx.bob, usdc(40));
      await ctx.crowdfund.connect(ctx.bob).contribute(0, c1);
      const c2 = await encUint64(ctx.client, ctx.charlie, usdc(20));
      await ctx.crowdfund.connect(ctx.charlie).contribute(0, c2);

      await time.increase(3601);
      await expect(ctx.crowdfund.connect(ctx.dave).closeCampaign(0))
        .to.emit(ctx.crowdfund, "CampaignClosed");

      const handle = await ctx.crowdfund.getGoalCheckHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
      const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();

      await expect(
        ctx.crowdfund.connect(ctx.dave).publishCloseResult(0, Boolean(proof.decryptedValue), proof.signature),
      ).to.emit(ctx.crowdfund, "CloseResultPublished");

      await expect(ctx.crowdfund.connect(ctx.alice).claimRelease(0))
        .to.emit(ctx.crowdfund, "CampaignReleased");
    });

    it("emits ContributionRefunded on goal-not-met refund", async () => {
      const ctx = await loadFixture(deployFixture);
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(500));
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(), encGoal, 3600, "Fail", ZERO_BYTES32,
      );

      const c1 = await encUint64(ctx.client, ctx.bob, usdc(40));
      await ctx.crowdfund.connect(ctx.bob).contribute(0, c1);

      await time.increase(3601);
      await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

      const handle = await ctx.crowdfund.getGoalCheckHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
      const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
      await ctx.crowdfund.connect(ctx.dave).publishCloseResult(0, Boolean(proof.decryptedValue), proof.signature);

      await expect(ctx.crowdfund.connect(ctx.bob).claimRefund(0, 0))
        .to.emit(ctx.crowdfund, "ContributionRefunded");
    });
  });

  // §2.7 + §15.3.1 event-assertion gap: PaymentReceiptsSet fires on
  // setPaymentReceipts and carries previous + current.
  describe("PaymentReceiptsSet event", () => {
    it("emits PaymentReceiptsSet with previous=zero, current=newAddr on first set", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = "0x000000000000000000000000000000000000bEEF";

      await expect(ctx.crowdfund.connect(ctx.owner).setPaymentReceipts(fake))
        .to.emit(ctx.crowdfund, "PaymentReceiptsSet")
        .withArgs(hre.ethers.ZeroAddress, fake);

      expect(await ctx.crowdfund.paymentReceipts()).to.equal(fake);
    });

    it("emits PaymentReceiptsSet with the prior address on subsequent set", async () => {
      const ctx = await loadFixture(deployFixture);
      const first = "0x000000000000000000000000000000000000dEaD";
      const second = "0x000000000000000000000000000000000000bEEF";

      await ctx.crowdfund.connect(ctx.owner).setPaymentReceipts(first);

      await expect(ctx.crowdfund.connect(ctx.owner).setPaymentReceipts(second))
        .to.emit(ctx.crowdfund, "PaymentReceiptsSet")
        .withArgs(first, second);
    });

    it("only owner can call setPaymentReceipts", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = "0x000000000000000000000000000000000000bEEF";

      await expect(
        ctx.crowdfund.connect(ctx.alice).setPaymentReceipts(fake),
      ).to.be.reverted;
    });
  });

  describe("§1.14 A4 — zero-goal grief prevention", () => {
    it("CRITICAL: encGoal=0 with contributions still produces verdict=FALSE (no creator drain)", async () => {
      // Attack: creator sets encGoal=0; victim contributes; without
      // the goalIsPositive AND, FHE.gte(raised, 0) is true and creator
      // could claimRelease the victim's funds.
      // Fix: closeCampaign AND-s `FHE.gt(encGoal, 0)` into the verdict.
      // Verdict goes to refunding instead.
      const ctx = await loadFixture(deployFixture);
      const encZeroGoal = await encUint64(ctx.client, ctx.alice, usdc(0));
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(),
        encZeroGoal,
        3600,
        "zero-goal-grief",
        ZERO_BYTES32,
      );

      // Bob contributes $40.
      const bob = await encUint64(ctx.client, ctx.bob, usdc(40));
      await ctx.crowdfund.connect(ctx.bob).contribute(0, bob);

      await time.increase(3601);
      await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

      const handle = await ctx.crowdfund.getGoalCheckHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
      const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();

      // The fix: verdict must be FALSE despite raised(40) >= goal(0).
      expect(Boolean(proof.decryptedValue)).to.equal(false);

      await ctx.crowdfund.connect(ctx.dave).publishCloseResult(
        0, Boolean(proof.decryptedValue), proof.signature,
      );
      const c = await ctx.crowdfund.getCampaign(0);
      expect(c.goalMet).to.equal(false);
      expect(c.status).to.equal(STATUS_REFUNDING);

      // Creator can't drain — claimRelease reverts on goalMet=false.
      await expect(
        ctx.crowdfund.connect(ctx.alice).claimRelease(0),
      ).to.be.revertedWith("Crowdfund: goal not met");
    });

    it("positive encGoal still works (regression sanity)", async () => {
      // The new goalIsPositive AND must not break legitimate campaigns.
      const ctx = await loadFixture(deployFixture);
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(50));
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(),
        encGoal,
        3600,
        "positive-goal",
        ZERO_BYTES32,
      );

      const bob = await encUint64(ctx.client, ctx.bob, usdc(60));
      await ctx.crowdfund.connect(ctx.bob).contribute(0, bob);

      await time.increase(3601);
      await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

      const handle = await ctx.crowdfund.getGoalCheckHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
      const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
      expect(Boolean(proof.decryptedValue)).to.equal(true);
    });
  });
});
