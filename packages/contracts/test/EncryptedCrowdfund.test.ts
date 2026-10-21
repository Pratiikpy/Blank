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

const CONTRIB_COUNTED = 0;
const CONTRIB_PENDING = 1;
const CONTRIB_VOID = 2;

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
  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await testUSDC.getAddress(), "Test USDC", "USDC", USDC_DECIMALS);
  await crowdfund.setTokenRegistry(await registry.getAddress());

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

async function encUint64(client: any, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

/// Decrypts a contribution's public funded bit and settles it on-chain, the way
/// the app's automatic second step does. Anyone may submit it.
async function confirmContributionAt(ctx: any, campaignId: bigint | number, index: bigint | number, caller: any = ctx.dave) {
  const handle = await ctx.crowdfund.getContributionFundingCheck(campaignId, index);
  await hre.cofhe.connectWithHardhatSigner(ctx.client, caller);
  const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
  return ctx.crowdfund.connect(caller).confirmContribution(campaignId, index, Boolean(proof.decryptedValue), proof.signature);
}

/// Confirms the most recent contribution on any campaign.
async function confirmLatest(ctx: any) {
  const events = await ctx.crowdfund.queryFilter(ctx.crowdfund.filters.Contributed());
  const last = events[events.length - 1];
  await confirmContributionAt(ctx, last.args.campaignId, last.args.contributionIndex);
}

/// Settles a claimRefund: decrypts the public "moved a non-zero amount" bit.
async function confirmRefundAt(ctx: any, campaignId: bigint | number, index: bigint | number, caller: any = ctx.dave) {
  const handle = await ctx.crowdfund.getRefundCheck(campaignId, index);
  await hre.cofhe.connectWithHardhatSigner(ctx.client, caller);
  const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
  return ctx.crowdfund.connect(caller).confirmRefund(campaignId, index, Boolean(proof.decryptedValue), proof.signature);
}

describe("EncryptedCrowdfund", () => {
  it("creates a campaign", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(),
      ...encGoal,
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
    const enc = await encUint64(ctx.client, ctx.alice, usdc(1), await ctx.crowdfund.getAddress());
    await expect(
      ctx.crowdfund.connect(ctx.alice).createCampaign(await ctx.vault.getAddress(), ...enc, 60, "x", ZERO_BYTES32),
    ).to.be.revertedWith("Crowdfund: bad duration");
  });

  it("contributors add to encrypted total", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...encGoal, 7 * 86400, "C", ZERO_BYTES32,
    );

    const c1 = await encUint64(ctx.client, ctx.bob, usdc(40), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.bob).contribute(0, ...c1);
    await confirmLatest(ctx);
    const c2 = await encUint64(ctx.client, ctx.charlie, usdc(30), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, ...c2);
    await confirmLatest(ctx);

    expect(await ctx.crowdfund.getContributionCount(0)).to.equal(2);

    // Funds locked in the contract.
    const sfBalance = await ctx.vault.balanceOf(await ctx.crowdfund.getAddress());
    await mock_expectPlaintext(ctx.alice.provider, sfBalance, usdc(70));
  });

  it("creator cannot contribute to own campaign", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...encGoal, 3600, "C", ZERO_BYTES32,
    );
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.crowdfund.getAddress());
    await expect(
      ctx.crowdfund.connect(ctx.alice).contribute(0, ...enc),
    ).to.be.revertedWith("Crowdfund: creator cannot contribute");
  });

  it("happy path: goal met → creator releases", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...encGoal, 3600, "Goal-met", ZERO_BYTES32,
    );

    const c1 = await encUint64(ctx.client, ctx.bob, usdc(40), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.bob).contribute(0, ...c1);
    await confirmLatest(ctx);
    const c2 = await encUint64(ctx.client, ctx.charlie, usdc(20), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, ...c2);
    await confirmLatest(ctx);

    // 60 raised >= 50 goal → success.
    await time.increase(3601);
    await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

    // Decrypt off-chain + publish result.
    const handle = await ctx.crowdfund.getGoalCheckHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
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
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(500), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...encGoal, 3600, "Fails", ZERO_BYTES32,
    );

    const c1 = await encUint64(ctx.client, ctx.bob, usdc(40), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.bob).contribute(0, ...c1);
    await confirmLatest(ctx);
    const c2 = await encUint64(ctx.client, ctx.charlie, usdc(20), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, ...c2);
    await confirmLatest(ctx);

    // 60 raised < 500 goal → failure.
    await time.increase(3601);
    await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

    const handle = await ctx.crowdfund.getGoalCheckHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
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
    // The funds moved, but a contribution is only marked refunded once the
    // moved amount is shown to be non-zero.
    await expect(ctx.crowdfund.connect(ctx.bob).claimRefund(0, 0)).to.be.revertedWith("Crowdfund: refund pending");
    await confirmRefundAt(ctx, 0, 0);
    await confirmRefundAt(ctx, 0, 1);

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
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...encGoal, 3600, "Past", ZERO_BYTES32,
    );
    await time.increase(3601);
    const enc = await encUint64(ctx.client, ctx.bob, usdc(10), await ctx.crowdfund.getAddress());
    await expect(
      ctx.crowdfund.connect(ctx.bob).contribute(0, ...enc),
    ).to.be.revertedWith("Crowdfund: past deadline");
  });

  // §2.2 of BEST_VERSION_FULL_PLAN: zero-contributions close grief.
  it("rejects close on a campaign with zero contributions", async () => {
    const ctx = await loadFixture(deployFixture);
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...encGoal, 3600, "Empty", ZERO_BYTES32,
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
    const encGoal = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...encGoal, 3600, "Double-publish", ZERO_BYTES32,
    );

    const c1 = await encUint64(ctx.client, ctx.bob, usdc(40), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.bob).contribute(0, ...c1);
    await confirmLatest(ctx);
    const c2 = await encUint64(ctx.client, ctx.charlie, usdc(20), await ctx.crowdfund.getAddress());
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, ...c2);
    await confirmLatest(ctx);

    await time.increase(3601);
    await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

    const handle = await ctx.crowdfund.getGoalCheckHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();

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
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100), await ctx.crowdfund.getAddress());

      await expect(
        ctx.crowdfund.connect(ctx.alice).createCampaign(
          await ctx.vault.getAddress(), ...encGoal, 3600, "with note", ZERO_BYTES32,
        ),
      ).to.emit(ctx.crowdfund, "CampaignCreated");
    });

    it("emits Contributed on contribute", async () => {
      const ctx = await loadFixture(deployFixture);
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(100), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(), ...encGoal, 3600, "C", ZERO_BYTES32,
      );

      const c1 = await encUint64(ctx.client, ctx.bob, usdc(40), await ctx.crowdfund.getAddress());
      await expect(ctx.crowdfund.connect(ctx.bob).contribute(0, ...c1))
        .to.emit(ctx.crowdfund, "Contributed");
    });

    it("emits CampaignClosed + CloseResultPublished + CampaignReleased on goal-met flow", async () => {
      const ctx = await loadFixture(deployFixture);
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(), ...encGoal, 3600, "Met", ZERO_BYTES32,
      );

      const c1 = await encUint64(ctx.client, ctx.bob, usdc(40), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.bob).contribute(0, ...c1);
      await confirmLatest(ctx);
      const c2 = await encUint64(ctx.client, ctx.charlie, usdc(20), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.charlie).contribute(0, ...c2);
      await confirmLatest(ctx);

      await time.increase(3601);
      await expect(ctx.crowdfund.connect(ctx.dave).closeCampaign(0))
        .to.emit(ctx.crowdfund, "CampaignClosed");

      const handle = await ctx.crowdfund.getGoalCheckHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
      const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();

      await expect(
        ctx.crowdfund.connect(ctx.dave).publishCloseResult(0, Boolean(proof.decryptedValue), proof.signature),
      ).to.emit(ctx.crowdfund, "CloseResultPublished");

      await expect(ctx.crowdfund.connect(ctx.alice).claimRelease(0))
        .to.emit(ctx.crowdfund, "CampaignReleased");
    });

    it("emits ContributionRefunded on goal-not-met refund", async () => {
      const ctx = await loadFixture(deployFixture);
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(500), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(), ...encGoal, 3600, "Fail", ZERO_BYTES32,
      );

      const c1 = await encUint64(ctx.client, ctx.bob, usdc(40), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.bob).contribute(0, ...c1);
      await confirmLatest(ctx);

      await time.increase(3601);
      await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

      const handle = await ctx.crowdfund.getGoalCheckHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
      const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
      await ctx.crowdfund.connect(ctx.dave).publishCloseResult(0, Boolean(proof.decryptedValue), proof.signature);

      await expect(ctx.crowdfund.connect(ctx.bob).claimRefund(0, 0))
        .to.emit(ctx.crowdfund, "RefundRequested").withArgs(0, ctx.bob.address, 0)
        .and.not.to.emit(ctx.crowdfund, "ContributionRefunded");
      await expect(confirmRefundAt(ctx, 0, 0))
        .to.emit(ctx.crowdfund, "ContributionRefunded").withArgs(0, ctx.bob.address, 0);
    });
  });

  // §2.7 + §15.3.1 event-assertion gap: PaymentReceiptsSet fires on
  // setPaymentReceipts and carries previous + current.
  describe("PaymentReceiptsSet event", () => {
    it("emits PaymentReceiptsSet with previous=zero, current=newAddr on first set", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = await ctx.vault.getAddress();

      await expect(ctx.crowdfund.connect(ctx.owner).setPaymentReceipts(fake))
        .to.emit(ctx.crowdfund, "PaymentReceiptsSet")
        .withArgs(hre.ethers.ZeroAddress, fake);

      expect(await ctx.crowdfund.paymentReceipts()).to.equal(fake);
    });

    it("emits PaymentReceiptsSet with the prior address on subsequent set", async () => {
      const ctx = await loadFixture(deployFixture);
      const first = await ctx.vault.getAddress();
      const second = await ctx.testUSDC.getAddress();

      await ctx.crowdfund.connect(ctx.owner).setPaymentReceipts(first);

      await expect(ctx.crowdfund.connect(ctx.owner).setPaymentReceipts(second))
        .to.emit(ctx.crowdfund, "PaymentReceiptsSet")
        .withArgs(first, second);
    });

    it("only owner can call setPaymentReceipts", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = await ctx.vault.getAddress();

      await expect(
        ctx.crowdfund.connect(ctx.alice).setPaymentReceipts(fake),
      ).to.be.reverted;
    });

    it("E5: setters reject a codeless address; zero still switches receipts off", async () => {
      const ctx = await loadFixture(deployFixture);
      const eoa = "0x000000000000000000000000000000000000bEEF";
      await expect(ctx.crowdfund.setEventHub(eoa)).to.be.revertedWith("Crowdfund: bad event hub");
      await expect(ctx.crowdfund.setPaymentReceipts(eoa)).to.be.revertedWith("Crowdfund: bad receipts");
      await expect(ctx.crowdfund.setEventHub(await ctx.vault.getAddress())).to.not.be.reverted;
      await expect(ctx.crowdfund.setPaymentReceipts(hre.ethers.ZeroAddress)).to.not.be.reverted;
      await expect(ctx.crowdfund.connect(ctx.alice).setEventHub(await ctx.vault.getAddress())).to.be.reverted;
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
      const encZeroGoal = await encUint64(ctx.client, ctx.alice, usdc(0), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(),
        ...encZeroGoal,
        3600,
        "zero-goal-grief",
        ZERO_BYTES32,
      );

      // Bob contributes $40.
      const bob = await encUint64(ctx.client, ctx.bob, usdc(40), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.bob).contribute(0, ...bob);
      await confirmLatest(ctx);

      await time.increase(3601);
      await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

      const handle = await ctx.crowdfund.getGoalCheckHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
      const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();

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
      const encGoal = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(),
        ...encGoal,
        3600,
        "positive-goal",
        ZERO_BYTES32,
      );

      const bob = await encUint64(ctx.client, ctx.bob, usdc(60), await ctx.crowdfund.getAddress());
      await ctx.crowdfund.connect(ctx.bob).contribute(0, ...bob);
      await confirmLatest(ctx);

      await time.increase(3601);
      await ctx.crowdfund.connect(ctx.dave).closeCampaign(0);

      const handle = await ctx.crowdfund.getGoalCheckHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
      const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
      expect(Boolean(proof.decryptedValue)).to.equal(true);
    });
  });
});

async function publishVerdict(ctx: any, id: number) {
  const handle = await ctx.crowdfund.getGoalCheckHandle(id);
  await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
  const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
  await ctx.crowdfund.connect(ctx.dave).publishCloseResult(id, Boolean(proof.decryptedValue), proof.signature);
}

describe("EncryptedCrowdfund — audit fixes", () => {
  it("C6: creator cannot claimRelease twice and drain other campaigns on the vault", async () => {
    const ctx = await loadFixture(deployFixture);
    const cf = await ctx.crowdfund.getAddress();
    // Campaign 0 (alice) and campaign 1 (bob) share the vault.
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...(await encUint64(ctx.client, ctx.alice, usdc(10), cf)), 3600, "A", ZERO_BYTES32,
    );
    await ctx.crowdfund.connect(ctx.bob).createCampaign(
      await ctx.vault.getAddress(), ...(await encUint64(ctx.client, ctx.bob, usdc(500), cf)), 3600, "B", ZERO_BYTES32,
    );
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, ...(await encUint64(ctx.client, ctx.charlie, usdc(20), cf)));
    await confirmLatest(ctx);
    await ctx.crowdfund.connect(ctx.dave).contribute(1, ...(await encUint64(ctx.client, ctx.dave, usdc(40), cf)));
    await confirmLatest(ctx);

    await time.increase(3601);
    await ctx.crowdfund.closeCampaign(0);
    await publishVerdict(ctx, 0);

    await ctx.crowdfund.connect(ctx.alice).claimRelease(0);
    expect(await ctx.crowdfund.releasePaid(0)).to.equal(true);
    await expect(ctx.crowdfund.connect(ctx.alice).claimRelease(0)).to.be.revertedWith("Crowdfund: already released");

    // Campaign 1's 40 is still in custody for Dave's refund.
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(cf), usdc(40));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_020));
  });

  it("H1 exploit: a campaign swept before the upgrade cannot be swept again", async () => {
    const ctx = await loadFixture(deployFixture);
    const cf = await ctx.crowdfund.getAddress();
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...(await encUint64(ctx.client, ctx.alice, usdc(10), cf)), 3600, "A", ZERO_BYTES32,
    );
    await ctx.crowdfund.connect(ctx.bob).createCampaign(
      await ctx.vault.getAddress(), ...(await encUint64(ctx.client, ctx.bob, usdc(10), cf)), 3600, "B", ZERO_BYTES32,
    );
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, ...(await encUint64(ctx.client, ctx.charlie, usdc(20), cf)));
    await confirmLatest(ctx);
    await ctx.crowdfund.connect(ctx.dave).contribute(1, ...(await encUint64(ctx.client, ctx.dave, usdc(40), cf)));
    await confirmLatest(ctx);
    await time.increase(3601);
    await ctx.crowdfund.closeCampaign(0);
    await publishVerdict(ctx, 0);
    await ctx.crowdfund.closeCampaign(1);
    await publishVerdict(ctx, 1);
    await ctx.crowdfund.connect(ctx.alice).claimRelease(0);

    // Rewind to the pre-upgrade state: no releasePaid entry (slot 8 mapping)
    // and no migration flag (slot 9). Status alone still reads Released.
    const paidSlot = hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 8]));
    await hre.network.provider.send("hardhat_setStorageAt", [cf, paidSlot, ZERO_BYTES32]);
    await hre.network.provider.send("hardhat_setStorageAt", [cf, "0x9", ZERO_BYTES32]);
    expect(await ctx.crowdfund.releasePaid(0)).to.equal(false);
    expect(await ctx.crowdfund.legacyMigrationDone()).to.equal(false);

    // Window between upgrade and migration: release is closed for everyone.
    await expect(ctx.crowdfund.connect(ctx.alice).claimRelease(0)).to.be.revertedWith("Crowdfund: migration pending");
    await expect(ctx.crowdfund.connect(ctx.bob).claimRelease(1)).to.be.revertedWith("Crowdfund: migration pending");

    // Atomic migration through upgradeToAndCall, ids from CampaignReleased events.
    const ids = (await ctx.crowdfund.queryFilter(ctx.crowdfund.filters.CampaignReleased())).map((e: any) => e.args.campaignId);
    expect(ids).to.deep.equal([0n]);
    const Factory = await hre.ethers.getContractFactory("EncryptedCrowdfund");
    const impl = await Factory.deploy();
    const data = Factory.interface.encodeFunctionData("markLegacyReleased", [ids]);
    await expect(ctx.crowdfund.connect(ctx.alice).upgradeToAndCall(await impl.getAddress(), data)).to.be.reverted;
    await expect(ctx.crowdfund.upgradeToAndCall(await impl.getAddress(), data))
      .to.emit(ctx.crowdfund, "LegacyReleaseMarked").withArgs(0n);
    await expect(ctx.crowdfund.connect(ctx.alice).finishLegacyMigration()).to.be.reverted;
    await expect(ctx.crowdfund.finishLegacyMigration()).to.emit(ctx.crowdfund, "LegacyMigrationFinished");
    await expect(ctx.crowdfund.markLegacyReleased([1])).to.be.revertedWith("Crowdfund: migration done");
    await expect(ctx.crowdfund.finishLegacyMigration()).to.be.revertedWith("Crowdfund: migration done");

    await expect(ctx.crowdfund.connect(ctx.alice).claimRelease(0)).to.be.revertedWith("Crowdfund: already released");
    await ctx.crowdfund.connect(ctx.bob).claimRelease(1);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(cf), 0n);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_020));
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_040));
  });

  it("fresh proxies start with the legacy migration closed", async () => {
    const ctx = await loadFixture(deployFixture);
    expect(await ctx.crowdfund.legacyMigrationDone()).to.equal(true);
    await expect(ctx.crowdfund.markLegacyReleased([0])).to.be.revertedWith("Crowdfund: migration done");
  });

  it("privacy: contributors never get decrypt access to the running total; creator gets it at close", async () => {
    const ctx = await loadFixture(deployFixture);
    const cf = await ctx.crowdfund.getAddress();
    const acl = await hre.cofhe.mocks.getMockACL();
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...(await encUint64(ctx.client, ctx.alice, usdc(50), cf)), 3600, "P", ZERO_BYTES32,
    );
    await ctx.crowdfund.connect(ctx.bob).contribute(0, ...(await encUint64(ctx.client, ctx.bob, usdc(10), cf)));
    await confirmLatest(ctx);
    await ctx.crowdfund.connect(ctx.charlie).contribute(0, ...(await encUint64(ctx.client, ctx.charlie, usdc(5), cf)));
    await confirmLatest(ctx);

    let raised = await ctx.crowdfund.getEncryptedRaised(0);
    expect(await acl.isAllowed(raised, ctx.charlie.address)).to.equal(false);
    expect(await acl.isAllowed(raised, ctx.bob.address)).to.equal(false);
    expect(await acl.isAllowed(raised, ctx.alice.address)).to.equal(false);

    await time.increase(3601);
    await ctx.crowdfund.closeCampaign(0);
    raised = await ctx.crowdfund.getEncryptedRaised(0);
    expect(await acl.isAllowed(raised, ctx.alice.address)).to.equal(true);
    await mock_expectPlaintext(ctx.alice.provider, raised, usdc(15));
  });

  it("vault allowlist: unregistered vault reverts on create; unset registry fails closed", async () => {
    const ctx = await loadFixture(deployFixture);
    const cf = await ctx.crowdfund.getAddress();
    const Stub = await hre.ethers.getContractFactory("MockVaultStub");
    const fake = await Stub.deploy(await ctx.testUSDC.getAddress());
    await expect(
      ctx.crowdfund.connect(ctx.alice).createCampaign(
        await fake.getAddress(), ...(await encUint64(ctx.client, ctx.alice, usdc(1), cf)), 3600, "F", ZERO_BYTES32,
      ),
    ).to.be.revertedWith("Crowdfund: vault not allowed");

    const fresh = await deployProxy("EncryptedCrowdfund", [hre.ethers.ZeroAddress]);
    await expect(
      fresh.connect(ctx.alice).createCampaign(
        await ctx.vault.getAddress(), ...(await encUint64(ctx.client, ctx.alice, usdc(1), await fresh.getAddress())), 3600, "F", ZERO_BYTES32,
      ),
    ).to.be.revertedWith("Crowdfund: vault not allowed");
    await expect(fresh.setTokenRegistry(ctx.alice.address)).to.be.revertedWith("Crowdfund: bad registry");
  });

  it("short-balance contribution records 0, so raised reflects only moved funds", async () => {
    const ctx = await loadFixture(deployFixture);
    const cf = await ctx.crowdfund.getAddress();
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...(await encUint64(ctx.client, ctx.alice, usdc(50), cf)), 3600, "S", ZERO_BYTES32,
    );
    // Bob has 1,000 shielded; asks to contribute 5,000.
    await ctx.crowdfund.connect(ctx.bob).contribute(0, ...(await encUint64(ctx.client, ctx.bob, usdc(5_000), cf)));
    await confirmLatest(ctx);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.crowdfund.getEncryptedRaised(0), 0n);
    expect(await ctx.crowdfund.contributionState(0, 0)).to.equal(CONTRIB_VOID);
  });
});

// The vault moves zero instead of reverting when a contributor is short. The
// encrypted total is unaffected (zero adds nothing), but a contribution only
// counts as one, and only a refund only counts as paid, once a single public
// bit has been decrypted and published.
describe("EncryptedCrowdfund, funding gate", () => {
  const MAX = (1n << 64n) - 1n;
  const abi = hre.ethers.AbiCoder.defaultAbiCoder();
  // Slots of the appended mappings (storage-layouts/EncryptedCrowdfund.json).
  const CONTRIBUTION_STATE_SLOT = 10;
  const UNCOUNTED_SLOT = 12;

  // Eve holds nothing in the vault but has approved the crowdfund, so the only
  // reason her contributions can fail is a short balance.
  async function gateFixture() {
    const ctx = await deployFixture();
    const eve = (await hre.ethers.getSigners())[5];
    await ctx.vault.connect(eve).approvePlaintext(await ctx.crowdfund.getAddress(), MAX);
    return { ...ctx, eve };
  }

  async function campaign(ctx: any, goal: bigint, duration = 3600) {
    const cf = await ctx.crowdfund.getAddress();
    await ctx.crowdfund.connect(ctx.alice).createCampaign(
      await ctx.vault.getAddress(), ...(await encUint64(ctx.client, ctx.alice, goal, cf)), duration, "gate", ZERO_BYTES32,
    );
    return (await ctx.crowdfund.nextCampaignId()) - 1n;
  }

  async function contribute(ctx: any, who: any, id: bigint, amount: bigint) {
    const cf = await ctx.crowdfund.getAddress();
    await ctx.crowdfund.connect(who).contribute(id, ...(await encUint64(ctx.client, who, amount, cf)));
    return (await ctx.crowdfund.getContributionCount(id)) - 1n;
  }

  async function fundedBit(ctx: any, id: bigint, index: bigint) {
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const handle = await ctx.crowdfund.getContributionFundingCheck(id, index);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
    return { value: Boolean(proof.decryptedValue), signature: proof.signature };
  }

  async function closeAndPublish(ctx: any, id: bigint) {
    await time.increase(3601);
    await ctx.crowdfund.connect(ctx.dave).closeCampaign(id);
    await publishVerdict(ctx, Number(id));
  }

  it("a funded contribution starts PendingFunding, counts toward the total, but not toward the close guard", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(50));
    const index = await contribute(ctx, ctx.bob, id, usdc(60));
    expect(await ctx.crowdfund.contributionState(id, index)).to.equal(CONTRIB_PENDING);
    expect(await ctx.crowdfund.uncountedContributions(id)).to.equal(1);
    // The money is locked, and the encrypted total already holds it.
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(await ctx.crowdfund.getAddress()), usdc(60));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.crowdfund.getEncryptedRaised(id), usdc(60));

    await time.increase(3601);
    await expect(ctx.crowdfund.connect(ctx.dave).closeCampaign(id))
      .to.be.revertedWith("Crowdfund: no contributions to close against");
  });

  it("funded path end to end: a stranger confirms, the campaign closes, the goal is met, the creator is paid", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(50));
    const index = await contribute(ctx, ctx.bob, id, usdc(60));
    const bit = await fundedBit(ctx, id, index);
    expect(bit.value).to.equal(true);

    await expect(ctx.crowdfund.connect(ctx.eve).confirmContribution(id, index, bit.value, bit.signature))
      .to.emit(ctx.crowdfund, "ContributionConfirmed").withArgs(id, ctx.bob.address, index)
      .and.not.to.emit(ctx.crowdfund, "ContributionVoided");
    expect(await ctx.crowdfund.contributionState(id, index)).to.equal(CONTRIB_COUNTED);
    expect(await ctx.crowdfund.uncountedContributions(id)).to.equal(0);

    await closeAndPublish(ctx, id);
    expect((await ctx.crowdfund.getCampaign(id)).goalMet).to.equal(true);
    await ctx.crowdfund.connect(ctx.alice).claimRelease(id);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_060));
  });

  it("zero-balance contributor: the contribution ends Void, adds nothing and never satisfies the close guard", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(50));
    const index = await contribute(ctx, ctx.eve, id, usdc(50));
    const bit = await fundedBit(ctx, id, index);
    expect(bit.value).to.equal(false);

    await expect(ctx.crowdfund.connect(ctx.bob).confirmContribution(id, index, bit.value, bit.signature))
      .to.emit(ctx.crowdfund, "ContributionVoided").withArgs(id, ctx.eve.address, index)
      .and.not.to.emit(ctx.crowdfund, "ContributionConfirmed");
    expect(await ctx.crowdfund.contributionState(id, index)).to.equal(CONTRIB_VOID);
    expect(await ctx.crowdfund.uncountedContributions(id)).to.equal(1);
    expect(await ctx.crowdfund.getContributionCount(id)).to.equal(1);

    await time.increase(3601);
    await expect(ctx.crowdfund.connect(ctx.dave).closeCampaign(id))
      .to.be.revertedWith("Crowdfund: no contributions to close against");
  });

  it("a Void contribution beside a real one leaves the verdict and refunds correct, and its refund stays retryable", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(100));
    const real = await contribute(ctx, ctx.bob, id, usdc(60));
    const empty = await contribute(ctx, ctx.eve, id, usdc(50));
    await confirmContributionAt(ctx, id, real);
    await confirmContributionAt(ctx, id, empty);

    await closeAndPublish(ctx, id);
    // 60 raised < 100 goal; Eve's void 50 did not inflate the total.
    expect((await ctx.crowdfund.getCampaign(id)).goalMet).to.equal(false);

    await ctx.crowdfund.connect(ctx.bob).claimRefund(id, real);
    await confirmRefundAt(ctx, id, real);
    expect((await ctx.crowdfund.getContribution(id, real)).refunded).to.equal(true);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_000));

    // Eve's refund moves nothing, so it must not be marked refunded.
    await ctx.crowdfund.connect(ctx.eve).claimRefund(id, empty);
    await expect(confirmRefundAt(ctx, id, empty))
      .to.emit(ctx.crowdfund, "RefundNotPaid").withArgs(id, ctx.eve.address, empty)
      .and.not.to.emit(ctx.crowdfund, "ContributionRefunded");
    expect((await ctx.crowdfund.getContribution(id, empty)).refunded).to.equal(false);
    expect(await ctx.crowdfund.refundInFlight(id, empty)).to.equal(false);
    // Retryable: the call is accepted again.
    await expect(ctx.crowdfund.connect(ctx.eve).claimRefund(id, empty)).to.emit(ctx.crowdfund, "RefundRequested");
  });

  it("an unconfirmed funded contribution still counts toward the goal and is swept on release", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(50));
    const confirmed = await contribute(ctx, ctx.bob, id, usdc(40));
    const late = await contribute(ctx, ctx.charlie, id, usdc(20));
    await confirmContributionAt(ctx, id, confirmed);
    expect(await ctx.crowdfund.uncountedContributions(id)).to.equal(1);

    await closeAndPublish(ctx, id);
    expect((await ctx.crowdfund.getCampaign(id)).goalMet).to.equal(true);
    await ctx.crowdfund.connect(ctx.alice).claimRelease(id);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_060));

    // Settling the late one after close is allowed and only touches its own state.
    await confirmContributionAt(ctx, id, late);
    expect(await ctx.crowdfund.contributionState(id, late)).to.equal(CONTRIB_COUNTED);
  });

  it("confirmContribution rejects a bad index, a repeat, and a lie about the bit", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(50));
    const index = await contribute(ctx, ctx.eve, id, usdc(5));
    await expect(ctx.crowdfund.confirmContribution(id, 9, true, "0x")).to.be.revertedWith("Crowdfund: bad index");

    const bit = await fundedBit(ctx, id, index);
    expect(bit.value).to.equal(false);
    await expect(ctx.crowdfund.confirmContribution(id, index, true, bit.signature)).to.be.reverted;
    expect(await ctx.crowdfund.contributionState(id, index)).to.equal(CONTRIB_PENDING);

    // A verdict published straight to the Task Manager cannot be flipped by the argument.
    const tm = await hre.cofhe.mocks.getMockTaskManager();
    await tm.publishDecryptResult(await ctx.crowdfund.getContributionFundingCheck(id, index), 0, bit.signature);
    await ctx.crowdfund.confirmContribution(id, index, true, "0x");
    expect(await ctx.crowdfund.contributionState(id, index)).to.equal(CONTRIB_VOID);
    await expect(ctx.crowdfund.confirmContribution(id, index, false, bit.signature))
      .to.be.revertedWith("Crowdfund: not pending funding");
  });

  it("refund is two-step: funds move on claim, the flag flips only on confirm, and a repeat is blocked in between", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(500));
    const index = await contribute(ctx, ctx.bob, id, usdc(40));
    await confirmContributionAt(ctx, id, index);
    await closeAndPublish(ctx, id);

    await expect(ctx.crowdfund.confirmRefund(id, index, true, "0x")).to.be.revertedWith("Crowdfund: no refund pending");
    await ctx.crowdfund.connect(ctx.bob).claimRefund(id, index);
    expect(await ctx.crowdfund.refundInFlight(id, index)).to.equal(true);
    expect((await ctx.crowdfund.getContribution(id, index)).refunded).to.equal(false);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_000));
    await expect(ctx.crowdfund.connect(ctx.bob).claimRefund(id, index)).to.be.revertedWith("Crowdfund: refund pending");

    await expect(confirmRefundAt(ctx, id, index, ctx.charlie))
      .to.emit(ctx.crowdfund, "ContributionRefunded").withArgs(id, ctx.bob.address, index);
    expect((await ctx.crowdfund.getContribution(id, index)).refunded).to.equal(true);
    expect(await ctx.crowdfund.refundInFlight(id, index)).to.equal(false);
    await expect(ctx.crowdfund.connect(ctx.bob).claimRefund(id, index)).to.be.revertedWith("Crowdfund: already refunded");
    await expect(ctx.crowdfund.confirmRefund(id, index, true, "0x")).to.be.revertedWith("Crowdfund: no refund pending");
    // No double payout from the second claim attempts.
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_000));
  });

  it("refund confirmation takes the published bit, not the argument", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(500));
    // A real contribution lets the campaign close; Eve's moves nothing.
    await confirmContributionAt(ctx, id, await contribute(ctx, ctx.bob, id, usdc(10)));
    const index = await contribute(ctx, ctx.eve, id, usdc(40));
    await confirmContributionAt(ctx, id, index);
    await closeAndPublish(ctx, id);
    await ctx.crowdfund.connect(ctx.eve).claimRefund(id, index);

    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const handle = await ctx.crowdfund.getRefundCheck(id, index);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
    expect(Boolean(proof.decryptedValue)).to.equal(false);
    await expect(ctx.crowdfund.confirmRefund(id, index, true, proof.signature)).to.be.reverted;

    const tm = await hre.cofhe.mocks.getMockTaskManager();
    await tm.publishDecryptResult(handle, 0, proof.signature);
    await ctx.crowdfund.confirmRefund(id, index, true, "0x");
    expect((await ctx.crowdfund.getContribution(id, index)).refunded).to.equal(false);
  });

  it("publishCloseResult takes the stored verdict when it was already published, and a lie cannot flip it", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(50));
    const index = await contribute(ctx, ctx.bob, id, usdc(60));
    await confirmContributionAt(ctx, id, index);
    await time.increase(3601);
    await ctx.crowdfund.connect(ctx.dave).closeCampaign(id);

    const handle = await ctx.crowdfund.getGoalCheckHandle(id);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.dave);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
    expect(Boolean(proof.decryptedValue)).to.equal(true);
    // Unpublished: a false claim is rejected by the signature check.
    await expect(ctx.crowdfund.publishCloseResult(id, false, proof.signature)).to.be.reverted;

    // Someone else publishes the verdict straight to the Task Manager first.
    const tm = await hre.cofhe.mocks.getMockTaskManager();
    await tm.publishDecryptResult(handle, 1, proof.signature);
    await expect(ctx.crowdfund.publishCloseResult(id, false, "0x"))
      .to.emit(ctx.crowdfund, "CloseResultPublished").withArgs(id, true);
    const c = await ctx.crowdfund.getCampaign(id);
    expect(c.goalMet).to.equal(true);
    expect(c.status).to.equal(STATUS_RELEASED);
  });

  // Contributions made before the upgrade have state Counted and no entry in
  // uncountedContributions. Zeroing both for a pending contribution models them.
  it("legacy contributions count toward the close guard and refund as before", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await campaign(ctx, usdc(500));
    const index = await contribute(ctx, ctx.bob, id, usdc(40));
    const cfAddr = await ctx.crowdfund.getAddress();
    const outer = hre.ethers.keccak256(abi.encode(["uint256", "uint256"], [id, CONTRIBUTION_STATE_SLOT]));
    const stateSlot = hre.ethers.keccak256(abi.encode(["uint256", "bytes32"], [index, outer]));
    const uncountedSlot = hre.ethers.keccak256(abi.encode(["uint256", "uint256"], [id, UNCOUNTED_SLOT]));
    await hre.network.provider.send("hardhat_setStorageAt", [cfAddr, stateSlot, hre.ethers.ZeroHash]);
    await hre.network.provider.send("hardhat_setStorageAt", [cfAddr, uncountedSlot, hre.ethers.ZeroHash]);
    expect(await ctx.crowdfund.contributionState(id, index)).to.equal(CONTRIB_COUNTED);
    expect(await ctx.crowdfund.uncountedContributions(id)).to.equal(0);

    await expect(ctx.crowdfund.confirmContribution(id, index, true, "0x")).to.be.revertedWith("Crowdfund: not pending funding");
    await closeAndPublish(ctx, id);
    await ctx.crowdfund.connect(ctx.bob).claimRefund(id, index);
    await confirmRefundAt(ctx, id, index);
    expect((await ctx.crowdfund.getContribution(id, index)).refunded).to.equal(true);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_000));
  });
});
