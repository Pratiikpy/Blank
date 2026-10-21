import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

const STATUS_ACTIVE = 0;
const STATUS_DISPUTED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDED = 3;
const STATUS_PENDING_FUNDING = 4;
const STATUS_VOID = 5;

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

  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(
    await vault.getAddress(), await testUSDC.getAddress(), "USD Coin", "USDC", USDC_DECIMALS,
  );
  await escrow.setTokenRegistry(await registry.getAddress());

  const Resolver = await hre.ethers.getContractFactory("InvoiceApprovalResolver");
  const resolver = await Resolver.deploy();
  await resolver.waitForDeployment();

  for (const signer of [alice, bob, charlie]) {
    await testUSDC.mint(signer.address, usdc(10_000));
    await testUSDC.connect(signer).approve(await vault.getAddress(), usdc(10_000));
    await vault.connect(signer).shield(usdc(1_000));
  }
  const MAX = (1n << 64n) - 1n;
  for (const signer of [alice, bob, charlie]) {
    await vault.connect(signer).approvePlaintext(await escrow.getAddress(), MAX);
  }

  return { owner, alice, bob, charlie, client, vault, escrow, resolver, registry, testUSDC, eventHub };
}

async function encUint64(client: any, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

/// Decrypts the public funded bit of an escrow and settles it on-chain, the
/// way the app's automatic second step does. Anyone may submit it.
async function confirmEscrow(ctx: any, id: number | bigint, caller: any = ctx.owner) {
  const handle = await ctx.escrow.getFundingCheck(id);
  await hre.cofhe.connectWithHardhatSigner(ctx.client, caller);
  const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
  return ctx.escrow.connect(caller).confirmFunding(id, Boolean(proof.decryptedValue), proof.signature);
}

/// Confirms the most recently created escrow.
async function fundLatest(ctx: any) {
  await confirmEscrow(ctx, (await ctx.escrow.nextEscrowId()) - 1n);
}

describe("EncryptedEscrow", () => {
  it("creates an encrypted escrow", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      ...enc,
      "Build a website",
      hre.ethers.ZeroAddress,
      (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);

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

  // ─── Arbiter conflict-of-interest gate (CoI fix in /goal session) ──
  // createEscrow now rejects arbiter == msg.sender (depositor) and
  // arbiter == beneficiary. Both shapes were real security bugs:
  //   arbiter == depositor: depositor can disputeEscrow →
  //     arbiterDecide(false) and pull funds back instantly, bypassing
  //     the 1-day deadline gate.
  //   arbiter == beneficiary: the arbiter has direct self-interest to
  //     rule in their own favor.
  // The address(0) ("no arbiter") path stays accepted.
  it("createEscrow rejects arbiter == depositor (conflict of interest)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.escrow.getAddress());
    await expect(
      ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address,
        await ctx.vault.getAddress(),
        ...enc,
        "self-deal attempt",
        ctx.alice.address, // arbiter == depositor
        (await time.latest()) + 7 * 86400,
      ),
    ).to.be.revertedWith("EncryptedEscrow: arbiter == depositor");
  });

  it("createEscrow rejects arbiter == beneficiary (conflict of interest)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.escrow.getAddress());
    await expect(
      ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address,
        await ctx.vault.getAddress(),
        ...enc,
        "self-deal attempt",
        ctx.bob.address, // arbiter == beneficiary
        (await time.latest()) + 7 * 86400,
      ),
    ).to.be.revertedWith("EncryptedEscrow: arbiter == beneficiary");
  });

  it("happy path: markDelivered + approveRelease → release to beneficiary", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "x", hre.ethers.ZeroAddress, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);

    await ctx.escrow.connect(ctx.bob).markDelivered(0);
    await ctx.escrow.connect(ctx.alice).approveRelease(0);

    const e = await ctx.escrow.getEscrow(0);
    expect(e.status).to.equal(STATUS_RELEASED);
    const bobBalance = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.bob.provider, bobBalance, usdc(1_050));
  });

  it("approveRelease before delivery: release fires when delivery is marked", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(50), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "x", hre.ethers.ZeroAddress, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);

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
    const enc = await encUint64(ctx.client, ctx.alice, usdc(40), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "with arbiter", ctx.charlie.address, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);

    await ctx.escrow.connect(ctx.alice).disputeEscrow(0);
    await ctx.escrow.connect(ctx.charlie).arbiterDecide(0, true);

    const e = await ctx.escrow.getEscrow(0);
    expect(e.status).to.equal(STATUS_RELEASED);
    const bobBalance = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.bob.provider, bobBalance, usdc(1_040));
  });

  it("dispute → arbiter refunds to depositor", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(40), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "with arbiter", ctx.charlie.address, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);

    await ctx.escrow.connect(ctx.bob).disputeEscrow(0);
    await expect(ctx.escrow.connect(ctx.charlie).arbiterDecide(0, false))
      .to.emit(ctx.escrow, "EscrowRefunded").withArgs(0, ctx.alice.address)
      .and.not.to.emit(ctx.escrow, "EscrowReleased");

    const aliceBalance = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBalance, usdc(1_000));
    // A11: a refund must read as Refunded, not Released.
    expect((await ctx.escrow.getEscrow(0)).status).to.equal(STATUS_REFUNDED);
  });

  // A10: an arbiter who never rules must not lock funds forever.
  it("dispute timeout: depositor reclaims after DISPUTE_TIMEOUT, not before", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(40), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "silent arbiter", ctx.charlie.address, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);
    await ctx.escrow.connect(ctx.bob).disputeEscrow(0);
    expect(await ctx.escrow.getDisputedAt(0)).to.equal(await time.latest());

    await expect(ctx.escrow.connect(ctx.alice).claimDisputeTimeout(0))
      .to.be.revertedWith("EncryptedEscrow: dispute not timed out");
    await time.increase(30 * 86400);
    await expect(ctx.escrow.connect(ctx.bob).claimDisputeTimeout(0))
      .to.be.revertedWith("EncryptedEscrow: not depositor");
    await expect(ctx.escrow.connect(ctx.alice).claimDisputeTimeout(0))
      .to.emit(ctx.escrow, "EscrowRefunded").withArgs(0, ctx.alice.address);

    expect((await ctx.escrow.getEscrow(0)).status).to.equal(STATUS_REFUNDED);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
    await expect(ctx.escrow.connect(ctx.charlie).arbiterDecide(0, true))
      .to.be.revertedWith("EncryptedEscrow: not disputed");
  });

  it("claimDisputeTimeout rejects an escrow that is not disputed", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(5), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "x", ctx.charlie.address, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);
    await time.increase(60 * 86400);
    await expect(ctx.escrow.connect(ctx.alice).claimDisputeTimeout(0))
      .to.be.revertedWith("EncryptedEscrow: not disputed");
  });

  // A1: a vault outside the registry could fake transfers and forge income.
  it("createEscrow and createConditionalEscrow reject an unregistered vault", async () => {
    const ctx = await loadFixture(deployFixture);
    const Stub = await hre.ethers.getContractFactory("MockVaultStub");
    const fake = await (await Stub.deploy(await ctx.testUSDC.getAddress())).getAddress();
    const enc = await encUint64(ctx.client, ctx.alice, usdc(5), await ctx.escrow.getAddress());
    await expect(
      ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address, fake, ...enc, "x", hre.ethers.ZeroAddress, (await time.latest()) + 7 * 86400,
      ),
    ).to.be.revertedWith("EncryptedEscrow: vault not allowed");
    await expect(
      ctx.escrow.connect(ctx.alice).createConditionalEscrow(
        ctx.bob.address, fake, ...enc, "x", await ctx.resolver.getAddress(), "0x",
        (await time.latest()) + 7 * 86400,
      ),
    ).to.be.revertedWith("EncryptedEscrow: vault not allowed");
  });

  it("fails closed when no registry is set, and a deactivated vault cannot open escrows", async () => {
    const ctx = await loadFixture(deployFixture);
    const Escrow = await hre.ethers.getContractFactory("EncryptedEscrow");
    const impl = await Escrow.deploy();
    const Proxy = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const p = await Proxy.deploy(
      await impl.getAddress(),
      Escrow.interface.encodeFunctionData("initialize", [await ctx.eventHub.getAddress()]),
    );
    const bare = Escrow.attach(await p.getAddress()) as any;
    const enc = await encUint64(ctx.client, ctx.alice, usdc(5), await bare.getAddress());
    await expect(
      bare.connect(ctx.alice).createEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc, "x", hre.ethers.ZeroAddress,
        (await time.latest()) + 7 * 86400,
      ),
    ).to.be.revertedWith("EncryptedEscrow: vault not allowed");

    await ctx.registry.deactivateToken(await ctx.vault.getAddress());
    const enc2 = await encUint64(ctx.client, ctx.alice, usdc(5), await ctx.escrow.getAddress());
    await expect(
      ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc2, "x", hre.ethers.ZeroAddress,
        (await time.latest()) + 7 * 86400,
      ),
    ).to.be.revertedWith("EncryptedEscrow: vault not allowed");
  });

  it("existing escrows still refund after their vault is deactivated", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(25), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc, "x", hre.ethers.ZeroAddress,
      (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);
    await ctx.registry.deactivateToken(await ctx.vault.getAddress());
    await time.increase(7 * 86400 + 1);
    await ctx.escrow.connect(ctx.alice).claimExpiredEscrow(0);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
  });

  // A12: the record holds what moved, so a short balance locks zero. Since the
  // funding gate such an escrow ends Void and the zero can never be released.
  it("records the moved amount on a short balance and the escrow ends Void", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(5_000), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc, "x", hre.ethers.ZeroAddress,
      (await time.latest()) + 7 * 86400,
    );
    await mock_expectPlaintext(ctx.bob.provider, await ctx.escrow.getEncryptedAmount(0), 0n);
    await fundLatest(ctx);
    expect((await ctx.escrow.getEscrow(0)).status).to.equal(STATUS_VOID);
    await expect(ctx.escrow.connect(ctx.bob).markDelivered(0)).to.be.revertedWith("EncryptedEscrow: not active");
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_000));
  });

  it("A6: setters reject codeless addresses; registry setter is owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    const eoa = "0x000000000000000000000000000000000000bEEF";
    await expect(ctx.escrow.setEventHub(eoa)).to.be.revertedWith("EncryptedEscrow: bad event hub");
    await expect(ctx.escrow.setPaymentReceipts(eoa)).to.be.revertedWith("EncryptedEscrow: bad receipts");
    await expect(ctx.escrow.setTokenRegistry(eoa)).to.be.revertedWith("EncryptedEscrow: bad registry");
    await expect(ctx.escrow.connect(ctx.alice).setTokenRegistry(await ctx.registry.getAddress())).to.be.reverted;
    await expect(ctx.escrow.setPaymentReceipts(hre.ethers.ZeroAddress)).to.not.be.reverted;
  });

  it("expired escrow: depositor refunds after deadline", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(25), await ctx.escrow.getAddress());
    const deadline = (await time.latest()) + 7 * 86400;
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "x", hre.ethers.ZeroAddress, deadline,
    );
    await fundLatest(ctx);

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
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "x", ctx.charlie.address, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);
    await ctx.escrow.connect(ctx.alice).disputeEscrow(0);

    await expect(
      ctx.escrow.connect(ctx.alice).arbiterDecide(0, false),
    ).to.be.revertedWith("EncryptedEscrow: not arbiter");
  });

  // §2.5 A17 of BEST_VERSION_FULL_PLAN: idempotency guards.
  it("markDelivered rejects double-call (idempotency)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "x", ctx.charlie.address, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);
    await ctx.escrow.connect(ctx.bob).markDelivered(0);

    await expect(
      ctx.escrow.connect(ctx.bob).markDelivered(0),
    ).to.be.revertedWith("EncryptedEscrow: already delivered");
  });

  it("approveRelease rejects double-call (idempotency)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "x", ctx.charlie.address, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);
    await ctx.escrow.connect(ctx.alice).approveRelease(0);

    await expect(
      ctx.escrow.connect(ctx.alice).approveRelease(0),
    ).to.be.revertedWith("EncryptedEscrow: already approved");
  });

  it("no-arbiter escrow rejects dispute (would be permanent fund-lock)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "x", hre.ethers.ZeroAddress, (await time.latest()) + 7 * 86400,
    );
    await fundLatest(ctx);

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
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());
    await expect(
      ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc,
        "x", hre.ethers.ZeroAddress, (await time.latest()) + 60,
      ),
    ).to.be.revertedWith("EncryptedEscrow: deadline < 1 day out");
  });

  it("rejects self-deposit (depositor === beneficiary)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());
    await expect(
      ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.alice.address, await ctx.vault.getAddress(), ...enc,
        "x", hre.ethers.ZeroAddress, (await time.latest()) + 7 * 86400,
      ),
    ).to.be.revertedWith("EncryptedEscrow: bad beneficiary");
  });

  // §15.3.1: state-change events on each lifecycle transition.
  // Each event must fire so indexers can mirror state without polling.
  describe("State-change events", () => {
    it("emits EscrowCreated on createEscrow", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());

      await expect(
        ctx.escrow.connect(ctx.alice).createEscrow(
          ctx.bob.address,
          await ctx.vault.getAddress(),
          ...enc,
          "with note",
          hre.ethers.ZeroAddress,
          (await time.latest()) + 7 * 86400,
        ),
      ).to.emit(ctx.escrow, "EscrowCreated");
    });

    it("emits EscrowDelivered + EscrowApproved + EscrowReleased on happy path", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(15), await ctx.escrow.getAddress());
      await ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc,
        "happy", hre.ethers.ZeroAddress, (await time.latest()) + 7 * 86400,
      );
      await fundLatest(ctx);

      await expect(ctx.escrow.connect(ctx.bob).markDelivered(0))
        .to.emit(ctx.escrow, "EscrowDelivered");

      // approveRelease fires both EscrowApproved and EscrowReleased
      // since markDelivered already happened.
      const tx = ctx.escrow.connect(ctx.alice).approveRelease(0);
      await expect(tx).to.emit(ctx.escrow, "EscrowApproved");
      await expect(tx).to.emit(ctx.escrow, "EscrowReleased");
    });

    it("emits EscrowDisputed + EscrowArbiterDecided on dispute path", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(20), await ctx.escrow.getAddress());
      await ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc,
        "dispute", ctx.charlie.address, (await time.latest()) + 7 * 86400,
      );
      await fundLatest(ctx);

      await expect(ctx.escrow.connect(ctx.alice).disputeEscrow(0))
        .to.emit(ctx.escrow, "EscrowDisputed");

      await expect(ctx.escrow.connect(ctx.charlie).arbiterDecide(0, true))
        .to.emit(ctx.escrow, "EscrowArbiterDecided");
    });

    it("emits EscrowExpiryClaimed on claimExpiredEscrow", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(25), await ctx.escrow.getAddress());
      const deadline = (await time.latest()) + 7 * 86400;
      await ctx.escrow.connect(ctx.alice).createEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc,
        "expired", hre.ethers.ZeroAddress, deadline,
      );
      await fundLatest(ctx);

      await time.increase(7 * 86400 + 1);

      await expect(ctx.escrow.connect(ctx.alice).claimExpiredEscrow(0))
        .to.emit(ctx.escrow, "EscrowExpiryClaimed");
    });
  });

  // §2.7 + §15.3.1 event-assertion gap: PaymentReceiptsSet fires on
  // setPaymentReceipts and carries previous + current.
  describe("PaymentReceiptsSet event", () => {
    it("emits PaymentReceiptsSet with previous=zero, current=newAddr on first set", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = await ctx.resolver.getAddress();

      await expect(ctx.escrow.connect(ctx.owner).setPaymentReceipts(fake))
        .to.emit(ctx.escrow, "PaymentReceiptsSet")
        .withArgs(hre.ethers.ZeroAddress, fake);

      expect(await ctx.escrow.paymentReceipts()).to.equal(fake);
    });

    it("emits PaymentReceiptsSet with the prior address on subsequent set", async () => {
      const ctx = await loadFixture(deployFixture);
      const first = await ctx.resolver.getAddress();
      const second = await ctx.vault.getAddress();

      await ctx.escrow.connect(ctx.owner).setPaymentReceipts(first);

      await expect(ctx.escrow.connect(ctx.owner).setPaymentReceipts(second))
        .to.emit(ctx.escrow, "PaymentReceiptsSet")
        .withArgs(first, second);
    });

    it("only owner can call setPaymentReceipts", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = await ctx.resolver.getAddress();

      await expect(
        ctx.escrow.connect(ctx.alice).setPaymentReceipts(fake),
      ).to.be.reverted;
    });
  });

  // Conditional escrow (Reineira IConditionResolver standard): release on
  // buyer approval or after an auto-release deadline. Vendor-protective — the
  // depositor (buyer) cannot refund a resolver-gated escrow.
  describe("Conditional escrow (resolver-gated)", () => {
    const abi = hre.ethers.AbiCoder.defaultAbiCoder();
    const resolverData = (buyer: string, deadline: number) =>
      abi.encode(["address", "uint64"], [buyer, deadline]);

    it("releases to the vendor once the buyer approves", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(60), await ctx.escrow.getAddress());
      const deadline = (await time.latest()) + 7 * 86400;
      const resolverAddr = await ctx.resolver.getAddress();

      await ctx.escrow.connect(ctx.alice).createConditionalEscrow(
        ctx.bob.address,
        await ctx.vault.getAddress(),
        ...enc,
        "milestone job",
        resolverAddr,
        resolverData(ctx.alice.address, deadline),
        deadline,
      );
      await fundLatest(ctx);

      await expect(
        ctx.escrow.connect(ctx.bob).releaseIfConditionMet(0),
      ).to.be.revertedWith("EncryptedEscrow: condition not met");

      await ctx.resolver.connect(ctx.alice).approve(await ctx.escrow.getAddress(), 0);
      await ctx.escrow.connect(ctx.bob).releaseIfConditionMet(0);

      const e = await ctx.escrow.getEscrow(0);
      expect(e.status).to.equal(STATUS_RELEASED);
      const bobBalance = await ctx.vault.balanceOf(ctx.bob.address);
      await mock_expectPlaintext(ctx.bob.provider, bobBalance, usdc(1_060));
    });

    it("auto-releases to the vendor after the deadline with no approval", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(40), await ctx.escrow.getAddress());
      const deadline = (await time.latest()) + 2 * 86400;
      const resolverAddr = await ctx.resolver.getAddress();

      await ctx.escrow.connect(ctx.alice).createConditionalEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc,
        "auto", resolverAddr, resolverData(ctx.alice.address, deadline), deadline,
      );
      await fundLatest(ctx);

      await expect(
        ctx.escrow.connect(ctx.bob).releaseIfConditionMet(0),
      ).to.be.revertedWith("EncryptedEscrow: condition not met");

      await time.increase(2 * 86400 + 1);
      await ctx.escrow.connect(ctx.bob).releaseIfConditionMet(0);

      const e = await ctx.escrow.getEscrow(0);
      expect(e.status).to.equal(STATUS_RELEASED);
      const bobBalance = await ctx.vault.balanceOf(ctx.bob.address);
      await mock_expectPlaintext(ctx.bob.provider, bobBalance, usdc(1_040));
    });

    it("blocks the depositor from refunding a resolver-gated escrow", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(25), await ctx.escrow.getAddress());
      const deadline = (await time.latest()) + 2 * 86400;
      const resolverAddr = await ctx.resolver.getAddress();

      await ctx.escrow.connect(ctx.alice).createConditionalEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc,
        "no refund", resolverAddr, resolverData(ctx.alice.address, deadline), deadline,
      );
      await fundLatest(ctx);

      await time.increase(2 * 86400 + 1);
      await expect(
        ctx.escrow.connect(ctx.alice).claimExpiredEscrow(0),
      ).to.be.revertedWith("EncryptedEscrow: resolver-gated escrow");
    });

    it("emits EscrowCreated + EscrowResolverSet on create", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());
      const deadline = (await time.latest()) + 7 * 86400;
      const resolverAddr = await ctx.resolver.getAddress();

      const tx = ctx.escrow.connect(ctx.alice).createConditionalEscrow(
        ctx.bob.address, await ctx.vault.getAddress(), ...enc,
        "evented", resolverAddr, resolverData(ctx.alice.address, deadline), deadline,
      );
      await expect(tx).to.emit(ctx.escrow, "EscrowCreated");
      await expect(tx).to.emit(ctx.escrow, "EscrowResolverSet").withArgs(0, resolverAddr);
    });

    it("rejects a resolver that does not implement IConditionResolver", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.escrow.getAddress());
      const deadline = (await time.latest()) + 7 * 86400;

      await expect(
        ctx.escrow.connect(ctx.alice).createConditionalEscrow(
          ctx.bob.address, await ctx.vault.getAddress(), ...enc,
          "bad resolver", ctx.bob.address, resolverData(ctx.alice.address, deadline), deadline,
        ),
      ).to.be.reverted;
    });
  });
});

// The vault moves zero instead of reverting when the depositor is short, so an
// escrow is only live once the single "locked the requested amount" bit has
// been decrypted and published.
describe("EncryptedEscrow, funding gate", () => {
  const MAX = (1n << 64n) - 1n;
  const abi = hre.ethers.AbiCoder.defaultAbiCoder();

  // Eve holds nothing in the vault but has approved the escrow, so the only
  // reason her escrows can fail is a short balance.
  async function gateFixture() {
    const ctx = await deployFixture();
    const eve = (await hre.ethers.getSigners())[4];
    await ctx.vault.connect(eve).approvePlaintext(await ctx.escrow.getAddress(), MAX);
    const receipts = await deployProxy("PaymentReceipts", []);
    await receipts.setAuthorizedCaller(await ctx.escrow.getAddress(), true);
    await ctx.escrow.setPaymentReceipts(await receipts.getAddress());
    return { ...ctx, eve, receipts };
  }

  async function create(ctx: any, payer: any, amount: bigint, arbiter: string = hre.ethers.ZeroAddress) {
    const enc = await encUint64(ctx.client, payer, amount, await ctx.escrow.getAddress());
    await ctx.escrow.connect(payer).createEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...enc,
      "gate", arbiter, (await time.latest()) + 7 * 86400,
    );
    return (await ctx.escrow.nextEscrowId()) - 1n;
  }

  async function fundedBit(ctx: any, id: bigint, reader: any = ctx.owner) {
    await hre.cofhe.connectWithHardhatSigner(ctx.client, reader);
    const handle = await ctx.escrow.getFundingCheck(id);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
    return { value: Boolean(proof.decryptedValue), signature: proof.signature };
  }

  async function receivedHandle(ctx: any, who: any) {
    return ctx.receipts.connect(who).getMyTotalReceived();
  }

  it("a funded escrow starts PendingFunding and nothing can move it until confirmed", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(50), ctx.charlie.address);

    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_PENDING_FUNDING);
    // The money is already locked in the vault, but no path can touch it yet.
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(await ctx.escrow.getAddress()), usdc(50));
    await expect(ctx.escrow.connect(ctx.bob).markDelivered(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.connect(ctx.alice).approveRelease(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.connect(ctx.alice).disputeEscrow(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.releaseIfConditionMet(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.connect(ctx.charlie).arbiterDecide(id, true)).to.be.revertedWith("EncryptedEscrow: not disputed");
    await expect(ctx.escrow.connect(ctx.alice).claimDisputeTimeout(id)).to.be.revertedWith("EncryptedEscrow: not disputed");
    await time.increase(8 * 86400);
    await expect(ctx.escrow.connect(ctx.alice).claimExpiredEscrow(id)).to.be.revertedWith("EncryptedEscrow: not active");
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_PENDING_FUNDING);
  });

  it("anyone can read the funded bit, and a third party confirming activates the escrow", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(50));
    // A stranger with no grant on the escrow reads the one public bit.
    const bit = await fundedBit(ctx, id, ctx.eve);
    expect(bit.value).to.equal(true);

    await expect(ctx.escrow.connect(ctx.eve).confirmFunding(id, bit.value, bit.signature))
      .to.emit(ctx.escrow, "EscrowFunded").withArgs(id, ctx.alice.address, ctx.bob.address)
      .and.not.to.emit(ctx.escrow, "EscrowVoided");
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_ACTIVE);
  });

  it("funded path end to end: confirm, deliver, approve, release, receipts bumped once", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(50));
    // Beneficiary has no income recorded before release.
    expect(await receivedHandle(ctx, ctx.bob)).to.equal(0n);

    await confirmEscrow(ctx, id, ctx.charlie);
    await ctx.escrow.connect(ctx.bob).markDelivered(id);
    await ctx.escrow.connect(ctx.alice).approveRelease(id);

    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_RELEASED);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_050));
    await mock_expectPlaintext(ctx.bob.provider, await receivedHandle(ctx, ctx.bob), usdc(50));
  });

  it("zero-balance payer: the escrow ends Void, nothing is locked and nothing can release or refund", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.eve, usdc(50), ctx.charlie.address);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.escrow.getEncryptedAmount(id), 0n);

    const bit = await fundedBit(ctx, id);
    expect(bit.value).to.equal(false);
    await expect(ctx.escrow.connect(ctx.bob).confirmFunding(id, bit.value, bit.signature))
      .to.emit(ctx.escrow, "EscrowVoided").withArgs(id, ctx.eve.address)
      .and.not.to.emit(ctx.escrow, "EscrowFunded");
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_VOID);

    // Every door is shut.
    await expect(ctx.escrow.connect(ctx.bob).markDelivered(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.connect(ctx.eve).approveRelease(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.connect(ctx.bob).disputeEscrow(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.releaseIfConditionMet(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.connect(ctx.charlie).arbiterDecide(id, true)).to.be.revertedWith("EncryptedEscrow: not disputed");
    await expect(ctx.escrow.connect(ctx.eve).claimDisputeTimeout(id)).to.be.revertedWith("EncryptedEscrow: not disputed");
    await time.increase(8 * 86400);
    await expect(ctx.escrow.connect(ctx.eve).claimExpiredEscrow(id)).to.be.revertedWith("EncryptedEscrow: not active");
    await expect(ctx.escrow.confirmFunding(id, false, "0x")).to.be.revertedWith("EncryptedEscrow: not pending funding");

    // No payment, no receipt.
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_000));
    expect(await receivedHandle(ctx, ctx.bob)).to.equal(0n);
  });

  it("a zero-amount escrow from a funded payer is Void too", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, 0n);
    await confirmEscrow(ctx, id);
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_VOID);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
  });

  it("an escrow larger than the balance is Void and takes nothing from the payer", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(5_000));
    await confirmEscrow(ctx, id);
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_VOID);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(await ctx.escrow.getAddress()), 0n);
  });

  it("the published value decides, not the caller's argument", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.eve, usdc(50));
    const bit = await fundedBit(ctx, id);
    expect(bit.value).to.equal(false);
    // A lie with the real signature is rejected by the signature check.
    await expect(ctx.escrow.confirmFunding(id, true, bit.signature)).to.be.reverted;
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_PENDING_FUNDING);

    // If the verdict was already published straight to the Task Manager, a
    // caller cannot flip it by passing the opposite value with no signature.
    const tm = await hre.cofhe.mocks.getMockTaskManager();
    await tm.publishDecryptResult(await ctx.escrow.getFundingCheck(id), 0, bit.signature);
    await ctx.escrow.confirmFunding(id, true, "0x");
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_VOID);
  });

  it("confirmFunding cannot run twice or on an unknown escrow", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(10));
    const bit = await fundedBit(ctx, id);
    await ctx.escrow.confirmFunding(id, bit.value, bit.signature);
    await expect(ctx.escrow.confirmFunding(id, bit.value, bit.signature))
      .to.be.revertedWith("EncryptedEscrow: not pending funding");
    await expect(ctx.escrow.confirmFunding(99, true, "0x")).to.be.revertedWith("EncryptedEscrow: not pending funding");
  });

  it("conditional escrow: unfunded stays Void even when the condition is met; funded releases after confirm", async () => {
    const ctx = await loadFixture(gateFixture);
    const resolverAddr = await ctx.resolver.getAddress();
    const deadline = (await time.latest()) + 2 * 86400;
    const data = abi.encode(["address", "uint64"], [ctx.eve.address, deadline]);
    const encEve = await encUint64(ctx.client, ctx.eve, usdc(40), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.eve).createConditionalEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...encEve, "unfunded", resolverAddr, data, deadline,
    );
    const encAlice = await encUint64(ctx.client, ctx.alice, usdc(40), await ctx.escrow.getAddress());
    await ctx.escrow.connect(ctx.alice).createConditionalEscrow(
      ctx.bob.address, await ctx.vault.getAddress(), ...encAlice, "funded", resolverAddr,
      abi.encode(["address", "uint64"], [ctx.alice.address, deadline]), deadline,
    );
    expect((await ctx.escrow.getEscrow(0)).status).to.equal(STATUS_PENDING_FUNDING);
    expect((await ctx.escrow.getEscrow(1)).status).to.equal(STATUS_PENDING_FUNDING);

    await ctx.resolver.connect(ctx.eve).approve(await ctx.escrow.getAddress(), 0);
    await ctx.resolver.connect(ctx.alice).approve(await ctx.escrow.getAddress(), 1);
    // Condition met, but a pending escrow is not releasable.
    await expect(ctx.escrow.connect(ctx.bob).releaseIfConditionMet(1)).to.be.revertedWith("EncryptedEscrow: not active");

    await confirmEscrow(ctx, 0);
    await confirmEscrow(ctx, 1);
    expect((await ctx.escrow.getEscrow(0)).status).to.equal(STATUS_VOID);
    await expect(ctx.escrow.connect(ctx.bob).releaseIfConditionMet(0)).to.be.revertedWith("EncryptedEscrow: not active");
    await time.increase(2 * 86400 + 1);
    await expect(ctx.escrow.connect(ctx.eve).claimExpiredEscrow(0)).to.be.revertedWith("EncryptedEscrow: not active");

    await ctx.escrow.connect(ctx.bob).releaseIfConditionMet(1);
    expect((await ctx.escrow.getEscrow(1)).status).to.equal(STATUS_RELEASED);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_040));
  });

  it("cancelPendingEscrow: only the depositor, returns the locked funds, then nothing else can settle it", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(50));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(950));

    await expect(ctx.escrow.connect(ctx.bob).cancelPendingEscrow(id)).to.be.revertedWith("EncryptedEscrow: not depositor");
    await expect(ctx.escrow.connect(ctx.alice).cancelPendingEscrow(id))
      .to.emit(ctx.escrow, "EscrowVoided").withArgs(id, ctx.alice.address);
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_VOID);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(await ctx.escrow.getAddress()), 0n);

    const bit = await fundedBit(ctx, id);
    await expect(ctx.escrow.confirmFunding(id, bit.value, bit.signature))
      .to.be.revertedWith("EncryptedEscrow: not pending funding");
    await expect(ctx.escrow.connect(ctx.alice).cancelPendingEscrow(id))
      .to.be.revertedWith("EncryptedEscrow: not pending funding");
  });

  it("cancelPendingEscrow is closed once the escrow is Active", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(50));
    await confirmEscrow(ctx, id);
    await expect(ctx.escrow.connect(ctx.alice).cancelPendingEscrow(id))
      .to.be.revertedWith("EncryptedEscrow: not pending funding");
  });

  // A record written before this upgrade carries status Active and no funding
  // bit. The packed slot (flags + status) is rewritten to model it.
  it("legacy record: an Active escrow with no funding bit behaves exactly as before", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(30));
    const ESCROWS_SLOT = 4; // _escrows mapping (storage-layouts/EncryptedEscrow.json)
    const base = BigInt(hre.ethers.keccak256(abi.encode(["uint256", "uint256"], [id, ESCROWS_SLOT])));
    // depositorApproved, beneficiaryMarkedDelivered and status share base + 6.
    await hre.network.provider.send("hardhat_setStorageAt", [
      await ctx.escrow.getAddress(), hre.ethers.toBeHex(base + 6n, 32), hre.ethers.ZeroHash,
    ]);
    await hre.network.provider.send("hardhat_setStorageAt", [
      await ctx.escrow.getAddress(),
      hre.ethers.keccak256(abi.encode(["uint256", "uint256"], [id, 9])), // _fundedCheck mapping slot
      hre.ethers.ZeroHash,
    ]);
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_ACTIVE);
    expect(await ctx.escrow.getFundingCheck(id)).to.equal(0n);

    await expect(ctx.escrow.confirmFunding(id, true, "0x")).to.be.revertedWith("EncryptedEscrow: not pending funding");
    await ctx.escrow.connect(ctx.bob).markDelivered(id);
    await ctx.escrow.connect(ctx.alice).approveRelease(id);
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_RELEASED);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_030));
  });

  it("legacy record: an Active escrow still refunds after its deadline", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, usdc(30));
    const base = BigInt(hre.ethers.keccak256(abi.encode(["uint256", "uint256"], [id, 4])));
    await hre.network.provider.send("hardhat_setStorageAt", [
      await ctx.escrow.getAddress(), hre.ethers.toBeHex(base + 6n, 32), hre.ethers.ZeroHash,
    ]);
    await time.increase(8 * 86400);
    await ctx.escrow.connect(ctx.alice).claimExpiredEscrow(id);
    expect((await ctx.escrow.getEscrow(id)).status).to.equal(STATUS_REFUNDED);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
  });

  it("the first four status numbers are unchanged", async () => {
    // Pre-upgrade records store 0..3; the new members sit after them.
    expect([STATUS_ACTIVE, STATUS_DISPUTED, STATUS_RELEASED, STATUS_REFUNDED]).to.deep.equal([0, 1, 2, 3]);
    expect([STATUS_PENDING_FUNDING, STATUS_VOID]).to.deep.equal([4, 5]);
  });
});
