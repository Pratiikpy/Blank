import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable } from "@cofhe/sdk";
import { parseUnits } from "ethers";

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

const STATUS_ACTIVE = 0;
const STATUS_DISPUTED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDED = 3;

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
  const [owner, alice, bob, charlie] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const testUSDC = await TestUSDC.deploy();
  await testUSDC.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await testUSDC.getAddress(), "Blank USDC Vault", "bvUSDC", USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const escrow = await deployProxy("EncryptedEscrow", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await escrow.getAddress()]);

  for (const signer of [alice, bob, charlie]) {
    await testUSDC.mint(signer.address, usdc(10_000));
    await testUSDC.connect(signer).approve(await vault.getAddress(), usdc(10_000));
    await vault.connect(signer).shield(usdc(1_000));
  }
  const MAX = (1n << 64n) - 1n;
  for (const signer of [alice, bob, charlie]) {
    await vault.connect(signer).approvePlaintext(await escrow.getAddress(), MAX);
  }

  return { owner, alice, bob, charlie, client, vault, escrow };
}

async function encUint64(client: any, signer: any, amount: bigint) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const [enc] = await client.encryptInputs([Encryptable.uint64(amount)]).execute();
  return enc;
}

describe("EncryptedEscrow", () => {
  it("creates an encrypted escrow", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(50));
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      enc,
      "Build a website",
      hre.ethers.ZeroAddress,
      Math.floor(Date.now() / 1000) + 7 * 86400,
    );

    const e = await ctx.escrow.getEscrow(0);
    expect(e.depositor).to.equal(ctx.alice.address);
    expect(e.beneficiary).to.equal(ctx.bob.address);
    expect(e.status).to.equal(STATUS_ACTIVE);

    // Funds locked in contract.
    const escrowAddr = await ctx.escrow.getAddress();
    const sfBalance = await ctx.vault.balanceOf(escrowAddr);
    await mock_expectPlaintext(ctx.alice.provider, sfBalance, usdc(50));
    const aliceBalance = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBalance, usdc(950));
  });

  it("happy path: markDelivered + approveRelease → release to beneficiary", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(50));
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), enc,
      "x", hre.ethers.ZeroAddress, Math.floor(Date.now() / 1000) + 7 * 86400,
    );

    await ctx.escrow.connect(ctx.bob).markDelivered(0);
    await ctx.escrow.connect(ctx.alice).approveRelease(0);

    const e = await ctx.escrow.getEscrow(0);
    expect(e.status).to.equal(STATUS_RELEASED);
    const bobBalance = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.bob.provider, bobBalance, usdc(1_050));
  });

  it("approveRelease before delivery: release fires when delivery is marked", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(50));
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), enc,
      "x", hre.ethers.ZeroAddress, Math.floor(Date.now() / 1000) + 7 * 86400,
    );

    await ctx.escrow.connect(ctx.alice).approveRelease(0);
    // Still active because beneficiary hasn't marked delivered yet.
    let e = await ctx.escrow.getEscrow(0);
    expect(e.status).to.equal(STATUS_ACTIVE);

    await ctx.escrow.connect(ctx.bob).markDelivered(0);
    e = await ctx.escrow.getEscrow(0);
    expect(e.status).to.equal(STATUS_RELEASED);
  });

  it("dispute → arbiter releases to beneficiary", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(40));
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), enc,
      "with arbiter", ctx.charlie.address, Math.floor(Date.now() / 1000) + 7 * 86400,
    );

    await ctx.escrow.connect(ctx.alice).disputeEscrow(0);
    await ctx.escrow.connect(ctx.charlie).arbiterDecide(0, true);

    const e = await ctx.escrow.getEscrow(0);
    expect(e.status).to.equal(STATUS_RELEASED);
    const bobBalance = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.bob.provider, bobBalance, usdc(1_040));
  });

  it("dispute → arbiter refunds to depositor", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(40));
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), enc,
      "with arbiter", ctx.charlie.address, Math.floor(Date.now() / 1000) + 7 * 86400,
    );

    await ctx.escrow.connect(ctx.bob).disputeEscrow(0);
    await ctx.escrow.connect(ctx.charlie).arbiterDecide(0, false);

    const aliceBalance = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBalance, usdc(1_000));
  });

  it("expired escrow: depositor refunds after deadline", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(25));
    const deadline = Math.floor(Date.now() / 1000) + 7 * 86400;
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), enc,
      "x", hre.ethers.ZeroAddress, deadline,
    );

    // Cannot refund before deadline.
    await expect(
      ctx.escrow.connect(ctx.alice).claimExpiredEscrow(0),
    ).to.be.revertedWith("EncryptedEscrow: not yet expired");

    await time.increase(7 * 86400 + 1);
    await ctx.escrow.connect(ctx.alice).claimExpiredEscrow(0);

    const e = await ctx.escrow.getEscrow(0);
    expect(e.status).to.equal(STATUS_REFUNDED);
    const aliceBalance = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBalance, usdc(1_000));
  });

  it("non-arbiter cannot decide", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10));
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), enc,
      "x", ctx.charlie.address, Math.floor(Date.now() / 1000) + 7 * 86400,
    );
    await ctx.escrow.connect(ctx.alice).disputeEscrow(0);

    await expect(
      ctx.escrow.connect(ctx.alice).arbiterDecide(0, false),
    ).to.be.revertedWith("EncryptedEscrow: not arbiter");
  });

  it("no-arbiter escrow rejects dispute (would be permanent fund-lock)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10));
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), enc,
      "x", hre.ethers.ZeroAddress, Math.floor(Date.now() / 1000) + 7 * 86400,
    );

    await expect(
      ctx.escrow.connect(ctx.alice).disputeEscrow(0),
    ).to.be.revertedWith("EncryptedEscrow: no arbiter, use claimExpiredEscrow at deadline");
    await expect(
      ctx.escrow.connect(ctx.bob).disputeEscrow(0),
    ).to.be.revertedWith("EncryptedEscrow: no arbiter, use claimExpiredEscrow at deadline");

    const e = await ctx.escrow.getEscrow(0);
    expect(e.status).to.equal(STATUS_ACTIVE);
  });

  it("rejects deadline less than 1 day out", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10));
    await expect(
      ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), enc,
        "x", hre.ethers.ZeroAddress, Math.floor(Date.now() / 1000) + 60,
      ),
    ).to.be.revertedWith("EncryptedEscrow: deadline < 1 day out");
  });

  it("rejects self-deposit (depositor === beneficiary)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10));
    await expect(
      ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.alice.address, await ctx.vault.getAddress(), enc,
        "x", hre.ethers.ZeroAddress, Math.floor(Date.now() / 1000) + 7 * 86400,
      ),
    ).to.be.revertedWith("EncryptedEscrow: bad beneficiary");
  });
});
