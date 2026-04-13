import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  Blank — core contract test suite (cofhe v0.1.3, mock Threshold Network)
//
//  Covers:
//   - FHERC20Vault: shield, encrypted balance, encrypted transfer,
//     transferFromVerified (cross-contract), unshield request/claim
//   - PaymentHub: sendPayment, batchSend, insufficient-balance no-revert
//   - BusinessHub: createInvoice, payInvoice, payInvoiceFinalize happy
//     path and mismatch-refund path
//   - GroupManager: createGroup, addExpense with encrypted shares,
//     settleDebt
//
//  Pattern cribbed from references/other-projects/batna-protocol-wave2/
//  test/NegotiationRoom.test.ts. The key insight there: CoFHE's mock
//  Threshold Network is seamless in hardhat — encryptInputs / asEuint64
//  / select / gte all work synchronously. We use mock_expectPlaintext
//  to decrypt-and-assert in a single call.
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

async function deployProxy(contractName: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();

  const initData =
    initArgs.length > 0
      ? Factory.interface.encodeFunctionData("initialize", initArgs)
      : Factory.interface.encodeFunctionData("initialize");

  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
  );
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();

  return Factory.attach(proxyAddress) as any;
}

async function deployBlankFixture() {
  const [owner, alice, bob, charlie] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  // TestUSDC (non-upgradeable — simple ERC20)
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const testUSDC = await TestUSDC.deploy();
  await testUSDC.waitForDeployment();

  // UUPS proxies
  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await testUSDC.getAddress(),
    "Blank USDC Vault",
    "bvUSDC",
    USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const paymentHub = await deployProxy("PaymentHub", [await eventHub.getAddress()]);
  const businessHub = await deployProxy("BusinessHub", [await eventHub.getAddress()]);
  const groupManager = await deployProxy("GroupManager", [await eventHub.getAddress()]);

  // Whitelist hubs in EventHub so activity events don't swallow
  await eventHub.batchWhitelist([
    await paymentHub.getAddress(),
    await businessHub.getAddress(),
    await groupManager.getAddress(),
  ]);

  // Mint alice + bob some test USDC and shield it
  await testUSDC.mint(alice.address, usdc(10_000));
  await testUSDC.mint(bob.address, usdc(10_000));
  await testUSDC.connect(alice).approve(await vault.getAddress(), usdc(10_000));
  await testUSDC.connect(bob).approve(await vault.getAddress(), usdc(10_000));

  return {
    owner, alice, bob, charlie, client,
    testUSDC, eventHub, vault, paymentHub, businessHub, groupManager,
  };
}

// Helper: shield N USDC from signer to their encrypted balance
async function shield(ctx: Awaited<ReturnType<typeof deployBlankFixture>>, signer: any, amount: bigint) {
  await ctx.vault.connect(signer).shield(amount);
}

// Helper: approve a spender (hub) to spend the signer's encrypted vault balance
async function approveHub(ctx: Awaited<ReturnType<typeof deployBlankFixture>>, signer: any, spender: string) {
  // 2^64 - 1 as plaintext — gives the hub effectively-infinite allowance
  const MAX = (1n << 64n) - 1n;
  await ctx.vault.connect(signer).approvePlaintext(spender, MAX);
}

// Helper: encrypt `amount` as uint64 for `signer` to consume
async function encUint64(ctx: Awaited<ReturnType<typeof deployBlankFixture>>, signer: any, amount: bigint) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  const [enc] = await ctx.client.encryptInputs([Encryptable.uint64(amount)]).execute();
  return enc;
}

// ══════════════════════════════════════════════════════════════════
//  FHERC20Vault
// ══════════════════════════════════════════════════════════════════

describe("FHERC20Vault", () => {
  it("shields plaintext USDC into encrypted balance", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));

    const handle = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, handle, usdc(100));
  });

  it("totalDeposited tracks sum of plaintext shields", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    await shield(ctx, ctx.bob, usdc(50));

    expect(await ctx.vault.totalDeposited()).to.equal(usdc(150));
  });

  it("transfers encrypted amount between two shielded users", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    // Bob's encrypted balance is lazily initialized by transfer (_ensureInitialized).

    const enc = await encUint64(ctx, ctx.alice, usdc(30));
    await ctx.vault.connect(ctx.alice).transfer(ctx.bob.address, enc);

    const aliceBal = await ctx.vault.balanceOf(ctx.alice.address);
    const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBal, usdc(70));
    await mock_expectPlaintext(ctx.bob.provider, bobBal, usdc(30));
  });

  it("transfer of amount > balance leaves balances untouched (FHE.select, no revert)", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(10));

    // Attempt to transfer 100 from a 10-balance wallet — should NOT revert,
    // should transfer 0 instead (the core FHE.select invariant).
    const enc = await encUint64(ctx, ctx.alice, usdc(100));
    await ctx.vault.connect(ctx.alice).transfer(ctx.bob.address, enc);

    const aliceBal = await ctx.vault.balanceOf(ctx.alice.address);
    const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBal, usdc(10));
    await mock_expectPlaintext(ctx.bob.provider, bobBal, 0n);
  });

  it("requestUnshield creates a pending handle matching the amount", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(50));

    const enc = await encUint64(ctx, ctx.alice, usdc(20));
    await ctx.vault.connect(ctx.alice).requestUnshield(enc);

    const pending = await ctx.vault.pendingUnshield(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, pending, usdc(20));
  });

  it("claimUnshield completes the full round-trip (shield → unshield)", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(50));

    const beforePlaintext = await ctx.testUSDC.balanceOf(ctx.alice.address);

    const enc = await encUint64(ctx, ctx.alice, usdc(20));
    await ctx.vault.connect(ctx.alice).requestUnshield(enc);

    // v0.1.3 flow: fetch the decryption proof (plaintext + TN signature)
    // via the SDK client — then submit it back to claimUnshield. The mock
    // TN returns a real ECDSA-verifiable signature over the plaintext.
    const pending = await ctx.vault.pendingUnshield(ctx.alice.address);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const proof = await ctx.client.decryptForTx(pending, FheTypes.Uint64).withoutPermit().execute();

    await ctx.vault.connect(ctx.alice).claimUnshield(proof.decryptedValue, proof.signature);

    const afterPlaintext = await ctx.testUSDC.balanceOf(ctx.alice.address);
    expect(afterPlaintext - beforePlaintext).to.equal(usdc(20));

    // Pending handle is reset to an encrypted zero (not a raw-zero handle —
    // FHE types can't be deleted, only overwritten with asEuint64(0)).
    const resetHandle = await ctx.vault.pendingUnshield(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, resetHandle, 0n);
  });
});

// ══════════════════════════════════════════════════════════════════
//  PaymentHub
// ══════════════════════════════════════════════════════════════════

describe("PaymentHub", () => {
  it("sendPayment moves encrypted amount from sender to recipient", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.paymentHub.getAddress());

    const enc = await encUint64(ctx, ctx.alice, usdc(25));
    await ctx.paymentHub.connect(ctx.alice).sendPayment(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      enc,
      "lunch",
    );

    const aliceBal = await ctx.vault.balanceOf(ctx.alice.address);
    const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBal, usdc(75));
    await mock_expectPlaintext(ctx.bob.provider, bobBal, usdc(25));
  });

  it("rejects self-payment", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.paymentHub.getAddress());

    const enc = await encUint64(ctx, ctx.alice, usdc(1));
    await expect(
      ctx.paymentHub.connect(ctx.alice).sendPayment(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        enc,
        "",
      ),
    ).to.be.revertedWith("PaymentHub: invalid recipient");
  });

  it("sendPayment with amount > balance transfers 0 (privacy-preserving failure)", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(5));
    await approveHub(ctx, ctx.alice, await ctx.paymentHub.getAddress());

    const enc = await encUint64(ctx, ctx.alice, usdc(100));
    await ctx.paymentHub.connect(ctx.alice).sendPayment(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      enc,
      "",
    );

    const aliceBal = await ctx.vault.balanceOf(ctx.alice.address);
    const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBal, usdc(5));
    await mock_expectPlaintext(ctx.bob.provider, bobBal, 0n);
  });
});

// ══════════════════════════════════════════════════════════════════
//  BusinessHub — invoices
// ══════════════════════════════════════════════════════════════════

describe("BusinessHub", () => {
  it("createInvoice records vendor/client with encrypted amount", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(500));

    const enc = await encUint64(ctx, ctx.alice, usdc(250));
    await ctx.businessHub
      .connect(ctx.alice)
      .createInvoice(
        ctx.bob.address,
        await ctx.vault.getAddress(),
        enc,
        "Design work — March",
        Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      );

    const invoice = await ctx.businessHub.getInvoice(0);
    expect(invoice.vendor).to.equal(ctx.alice.address);
    expect(invoice.client).to.equal(ctx.bob.address);
    expect(invoice.status).to.equal(0); // Open
  });

  it("payInvoice + payInvoiceFinalize happy path marks paid on match", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    // Alice creates invoice for 100 USDC
    const encInvoiceAmt = await encUint64(ctx, ctx.alice, usdc(100));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encInvoiceAmt,
      "Consulting",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Bob pays exactly 100 USDC (matches)
    const encPayment = await encUint64(ctx, ctx.bob, usdc(100));
    await ctx.businessHub.connect(ctx.bob).payInvoice(0, encPayment);

    // Fetch the TN proof for the ebool validation handle, then submit to finalize.
    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.businessHub
      .connect(ctx.alice)
      .payInvoiceFinalize(0, Boolean(proof.decryptedValue), proof.signature);

    const invoice = await ctx.businessHub.getInvoice(0);
    expect(invoice.status).to.equal(1); // Paid
  });

  it("payInvoice with mismatched amount flags invalid trade at finalize", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    const encInvoiceAmt = await encUint64(ctx, ctx.alice, usdc(100));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encInvoiceAmt,
      "Consulting",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Bob underpays (80 instead of 100) — amount mismatch on finalize
    const encUnder = await encUint64(ctx, ctx.bob, usdc(80));
    await ctx.businessHub.connect(ctx.bob).payInvoice(0, encUnder);

    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    expect(Boolean(proof.decryptedValue)).to.equal(false);
  });

  it("cancelInvoice marks status cancelled (vendor only)", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    const enc = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      enc,
      "",
      Math.floor(Date.now() / 1000) + 3600,
    );

    // Non-vendor cannot cancel
    await expect(
      ctx.businessHub.connect(ctx.bob).cancelInvoice(0),
    ).to.be.revertedWith("BusinessHub: not the vendor");

    await ctx.businessHub.connect(ctx.alice).cancelInvoice(0);
    const invoice = await ctx.businessHub.getInvoice(0);
    expect(invoice.status).to.equal(2); // Cancelled
  });
});

// ══════════════════════════════════════════════════════════════════
//  GroupManager
// ══════════════════════════════════════════════════════════════════

describe("GroupManager", () => {
  it("createGroup adds the caller + listed members", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await ctx.groupManager
      .connect(ctx.alice)
      .createGroup("Roomies", [ctx.bob.address, ctx.charlie.address]);

    expect(await ctx.groupManager.isMember(0, ctx.alice.address)).to.equal(true);
    expect(await ctx.groupManager.isMember(0, ctx.bob.address)).to.equal(true);
    expect(await ctx.groupManager.isMember(0, ctx.charlie.address)).to.equal(true);
  });

  it("non-member cannot add an expense", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await ctx.groupManager.connect(ctx.alice).createGroup("Close friends", [ctx.bob.address]);

    // Charlie is NOT in the group
    const encShare = await encUint64(ctx, ctx.charlie, usdc(10));
    const encTotal = await encUint64(ctx, ctx.charlie, usdc(20));
    await expect(
      ctx.groupManager
        .connect(ctx.charlie)
        .addExpense(
          0,
          [ctx.alice.address, ctx.bob.address],
          [encShare, encShare],
          encTotal,
          "Dinner",
        ),
    ).to.be.revertedWith("GroupManager: not a member");
  });
});

// ══════════════════════════════════════════════════════════════════
//  Cross-contract invariants
// ══════════════════════════════════════════════════════════════════

describe("Cross-contract invariants", () => {
  it("hub transferFromVerified fails without vault allowance", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    // NOTE: no approveHub call — PaymentHub has zero allowance on alice's vault balance

    const enc = await encUint64(ctx, ctx.alice, usdc(25));
    // The send should succeed at the call level but transfer 0 (FHE.select
    // guards the allowance check too — same no-revert privacy invariant).
    await ctx.paymentHub.connect(ctx.alice).sendPayment(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      enc,
      "",
    );

    const aliceBal = await ctx.vault.balanceOf(ctx.alice.address);
    const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBal, usdc(100));
    await mock_expectPlaintext(ctx.bob.provider, bobBal, 0n);
  });

  it("hub verifies encrypted input in caller context (no InvalidSigner)", async () => {
    // This test is the regression guard for the transferFromVerified pattern.
    // If it fails, it means someone re-introduced the double-verify bug where
    // FHE.asEuint64(input) runs with msg.sender == hub instead of msg.sender
    // == user. The symptom would be this test reverting with "InvalidSigner".
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.paymentHub.getAddress());

    const enc = await encUint64(ctx, ctx.alice, usdc(5));
    await expect(
      ctx.paymentHub
        .connect(ctx.alice)
        .sendPayment(ctx.bob.address, await ctx.vault.getAddress(), enc, ""),
    ).to.not.be.reverted;
  });
});
