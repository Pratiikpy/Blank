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
});
