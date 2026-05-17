import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
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
  const paymentReceipts = await deployProxy("PaymentReceipts", []);

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
    testUSDC, eventHub, vault, paymentHub, businessHub, groupManager, paymentReceipts,
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

  // transferVerified — the contract-side counterpart to transfer().
  // Lets a contract holding a pre-verified euint64 handle (typically
  // received via transferFromVerified earlier) move it onward without
  // having to re-encrypt. Required for the Private Invoice Escrow path
  // where BusinessHub holds funds then releases or refunds.
  it("transferVerified — holder contract releases held balance to a recipient", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));

    const TestHolder = await hre.ethers.getContractFactory("TestHolder");
    const holder = await TestHolder.deploy(await ctx.vault.getAddress());
    await holder.waitForDeployment();
    const holderAddr = await holder.getAddress();

    // Alice approves the holder on the vault so transferFromVerified
    // succeeds when the holder pulls.
    const encApprove = await encUint64(ctx, ctx.alice, usdc(40));
    await ctx.vault.connect(ctx.alice).approve(holderAddr, encApprove);

    // Alice calls holder.pull(...) — msg.sender inside pull is alice, so
    // FHE.asEuint64 verifies the encrypted input under alice's signature.
    const encPull = await encUint64(ctx, ctx.alice, usdc(40));
    await holder.connect(ctx.alice).pull(ctx.alice.address, encPull);

    // Holder forwards the held balance to Bob via the NEW transferVerified.
    await holder.forward(ctx.bob.address);

    const aliceBal = await ctx.vault.balanceOf(ctx.alice.address);
    const holderBal = await ctx.vault.balanceOf(holderAddr);
    const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBal, usdc(60));
    await mock_expectPlaintext(ctx.alice.provider, holderBal, 0n);
    await mock_expectPlaintext(ctx.bob.provider, bobBal, usdc(40));
  });

  it("transferVerified — rejects zero address and self", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(50));

    const TestHolder = await hre.ethers.getContractFactory("TestHolder");
    const holder = await TestHolder.deploy(await ctx.vault.getAddress());
    await holder.waitForDeployment();
    const holderAddr = await holder.getAddress();

    // Pull a small balance into the holder so it has something held + a
    // valid `_held` handle for forward(). The vault's require checks fire
    // BEFORE reading the held amount, so we just need the holder's
    // FHE.allowTransient to succeed.
    const encApprove = await encUint64(ctx, ctx.alice, usdc(10));
    await ctx.vault.connect(ctx.alice).approve(holderAddr, encApprove);
    const encPull = await encUint64(ctx, ctx.alice, usdc(10));
    await holder.connect(ctx.alice).pull(ctx.alice.address, encPull);

    await expect(holder.forward(hre.ethers.ZeroAddress)).to.be.revertedWith(
      "FHERC20Vault: transfer to zero address",
    );
    await expect(holder.forward(holderAddr)).to.be.revertedWith(
      "FHERC20Vault: transfer to self",
    );
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
    // #213: only the client (bob) — not the vendor (alice) — may finalize.
    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.businessHub
      .connect(ctx.bob)
      .payInvoiceFinalize(0, Boolean(proof.decryptedValue), proof.signature);

    const invoice = await ctx.businessHub.getInvoice(0);
    expect(invoice.status).to.equal(1); // Paid
  });

  // ── Private invoice escrow (PR-C) ───────────────────────────────
  // payInvoiceEscrow → releaseInvoiceEscrow.
  // Funds sit in BusinessHub until release reveals the encrypted-amount
  // match. Match → funds to vendor. Mismatch → automatic refund to client.
  // No vendor cooperation required — trustless settlement.
  it("payInvoiceEscrow + releaseInvoiceEscrow — happy path releases to vendor on match", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    const encInvoiceAmt = await encUint64(ctx, ctx.alice, usdc(75));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encInvoiceAmt,
      "Escrow consulting",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Bob funds the escrow with the matching amount.
    const encPay = await encUint64(ctx, ctx.bob, usdc(75));
    await ctx.businessHub.connect(ctx.bob).payInvoiceEscrow(0, encPay);

    // Status moved to PaymentPending; funds now held by BusinessHub.
    expect((await ctx.businessHub.getInvoice(0)).status).to.equal(3); // PaymentPending
    const hubAddr = await ctx.businessHub.getAddress();
    const hubBal = await ctx.vault.balanceOf(hubAddr);
    await mock_expectPlaintext(ctx.alice.provider, hubBal, usdc(75));

    // Decrypt the validation flag off-chain, finalize.
    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    expect(Boolean(proof.decryptedValue)).to.equal(true);
    await ctx.businessHub.connect(ctx.bob)
      .releaseInvoiceEscrow(0, Boolean(proof.decryptedValue), proof.signature);

    // Status Paid; funds at vendor; hub drained.
    expect((await ctx.businessHub.getInvoice(0)).status).to.equal(1); // Paid
    const aliceBal = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBal, usdc(75));
    const hubBalAfter = await ctx.vault.balanceOf(hubAddr);
    await mock_expectPlaintext(ctx.alice.provider, hubBalAfter, 0n);
  });

  it("releaseInvoiceEscrow refunds client on mismatch — no vendor cooperation needed", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    const encInvoiceAmt = await encUint64(ctx, ctx.alice, usdc(100));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encInvoiceAmt,
      "Wrong amount test",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Bob underpays — funds go into escrow.
    const encUnder = await encUint64(ctx, ctx.bob, usdc(80));
    await ctx.businessHub.connect(ctx.bob).payInvoiceEscrow(0, encUnder);

    // Decrypt + finalize. Mismatch → automatic refund.
    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    expect(Boolean(proof.decryptedValue)).to.equal(false);
    await ctx.businessHub.connect(ctx.bob)
      .releaseInvoiceEscrow(0, Boolean(proof.decryptedValue), proof.signature);

    // Status Cancelled; client whole; vendor got nothing; hub drained.
    // (Alice's balance handle is omitted — she was never initialized in
    // the vault, so cofhe-mock has nothing to read for her. The conserve-
    // -of-funds invariant is proven by Bob-restored + hub-drained: if
    // the contract released to the vendor instead, hub would still be
    // drained but Bob wouldn't have his 500 back.)
    expect((await ctx.businessHub.getInvoice(0)).status).to.equal(2); // Cancelled
    const bobAfter = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.bob.provider, bobAfter, usdc(500));
    const hubBal = await ctx.vault.balanceOf(await ctx.businessHub.getAddress());
    await mock_expectPlaintext(ctx.alice.provider, hubBal, 0n);
  });

  // Wiring-mistake guards. The first two unit tests above prove the
  // happy + mismatch flows; these prove that the surface AROUND those
  // flows is correct: auth checks fire, status transitions are linear,
  // events fire with the right ids. Each one is the kind of bug a
  // contract-level review or a frontend wiring change could introduce.
  it("payInvoiceEscrow rejects a second payer once invoicePaymentStartedBy is set", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());
    // Charlie isn't funded by the fixture (only alice + bob are). Fund + shield.
    await ctx.testUSDC.mint(ctx.charlie.address, usdc(1_000));
    await ctx.testUSDC.connect(ctx.charlie).approve(await ctx.vault.getAddress(), usdc(1_000));
    await shield(ctx, ctx.charlie, usdc(500));
    await approveHub(ctx, ctx.charlie, await ctx.businessHub.getAddress());

    const encAmt = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encAmt,
      "Race-test",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    const encBob = await encUint64(ctx, ctx.bob, usdc(50));
    await ctx.businessHub.connect(ctx.bob).payInvoiceEscrow(0, encBob);

    // Charlie tries to pay the same invoice. Must be rejected — once
    // Bob's call succeeds, `inv.status` flips to PaymentPending and the
    // `not pending` guard fires first. (`already paying` is the second
    // guard, kept as defense-in-depth for future state-machine changes
    // that might bring an invoice back to Pending.)
    const encCharlie = await encUint64(ctx, ctx.charlie, usdc(50));
    await expect(
      ctx.businessHub.connect(ctx.charlie).payInvoiceEscrow(0, encCharlie),
    ).to.be.revertedWith("BusinessHub: not pending");
  });

  it("releaseInvoiceEscrow rejects calls from non-client", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    const encAmt = await encUint64(ctx, ctx.alice, usdc(40));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encAmt,
      "Auth-test",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );
    const encPay = await encUint64(ctx, ctx.bob, usdc(40));
    await ctx.businessHub.connect(ctx.bob).payInvoiceEscrow(0, encPay);

    // Off-chain decryption signed under Bob's identity — but submitted
    // by Charlie, who is neither the named client nor the payment-starter.
    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await expect(
      ctx.businessHub.connect(ctx.charlie)
        .releaseInvoiceEscrow(0, Boolean(proof.decryptedValue), proof.signature),
    ).to.be.revertedWith("BusinessHub: only client can finalize");
  });

  it("releaseInvoiceEscrow rejects re-release after Paid — terminal state", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    const encAmt = await encUint64(ctx, ctx.alice, usdc(60));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encAmt,
      "Replay-test",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );
    const encPay = await encUint64(ctx, ctx.bob, usdc(60));
    await ctx.businessHub.connect(ctx.bob).payInvoiceEscrow(0, encPay);

    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.businessHub.connect(ctx.bob)
      .releaseInvoiceEscrow(0, Boolean(proof.decryptedValue), proof.signature);

    // Status is now Paid (terminal). A second release MUST revert — the
    // status guard is the protection against double-spend if a relayer
    // accidentally retries.
    await expect(
      ctx.businessHub.connect(ctx.bob)
        .releaseInvoiceEscrow(0, Boolean(proof.decryptedValue), proof.signature),
    ).to.be.revertedWith("BusinessHub: not payment pending");
  });

  it("releaseInvoiceEscrow rejects when invoice was never funded", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    const encAmt = await encUint64(ctx, ctx.alice, usdc(20));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encAmt,
      "Never-funded",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Bob skips payInvoiceEscrow entirely. Trying to release a Pending
    // invoice must revert — the validation handle was never written and
    // there are no funds to route.
    await expect(
      ctx.businessHub.connect(ctx.bob).releaseInvoiceEscrow(
        0,
        true,
        "0x" + "00".repeat(65),
      ),
    ).to.be.revertedWith("BusinessHub: not payment pending");
  });

  it("payInvoiceEscrow + releaseInvoiceEscrow emit InvoicePaymentInitiated and InvoicePaid", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    const encAmt = await encUint64(ctx, ctx.alice, usdc(33));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encAmt,
      "Event-test",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // payInvoiceEscrow → InvoicePaymentInitiated(0, …)
    const encPay = await encUint64(ctx, ctx.bob, usdc(33));
    await expect(ctx.businessHub.connect(ctx.bob).payInvoiceEscrow(0, encPay))
      .to.emit(ctx.businessHub, "InvoicePaymentInitiated")
      .withArgs(0n, anyValue);

    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();

    // releaseInvoiceEscrow on match → InvoicePaid(0, …)
    await expect(
      ctx.businessHub.connect(ctx.bob)
        .releaseInvoiceEscrow(0, Boolean(proof.decryptedValue), proof.signature),
    )
      .to.emit(ctx.businessHub, "InvoicePaid")
      .withArgs(0n, anyValue);
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

  // Refund-on-mismatch path. payInvoice transfers funds before the
  // encrypted-amount match is verified; if finalize reveals a mismatch
  // the invoice goes to Disputed but the funds are already with the
  // vendor. refundDisputedInvoice lets the vendor return the encrypted
  // amount on-chain, transitioning Disputed → Cancelled atomically.
  it("refundDisputedInvoice — vendor returns wrong-amount payment, status Cancelled", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    // Alice invoices Bob for 100; Bob underpays 80; finalize marks Disputed.
    const encInvoiceAmt = await encUint64(ctx, ctx.alice, usdc(100));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encInvoiceAmt,
      "Consulting",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );
    const encUnder = await encUint64(ctx, ctx.bob, usdc(80));
    await ctx.businessHub.connect(ctx.bob).payInvoice(0, encUnder);

    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.businessHub.connect(ctx.bob)
      .payInvoiceFinalize(0, Boolean(proof.decryptedValue), proof.signature);

    expect((await ctx.businessHub.getInvoice(0)).status).to.equal(4); // Disputed

    // Non-vendor cannot refund.
    const encRefund = await encUint64(ctx, ctx.bob, usdc(80));
    await expect(
      ctx.businessHub.connect(ctx.bob).refundDisputedInvoice(0, encRefund),
    ).to.be.revertedWith("BusinessHub: not the vendor");

    // Vendor (Alice) approves BusinessHub then refunds.
    await approveHub(ctx, ctx.alice, await ctx.businessHub.getAddress());
    const encVendorRefund = await encUint64(ctx, ctx.alice, usdc(80));
    await ctx.businessHub.connect(ctx.alice).refundDisputedInvoice(0, encVendorRefund);

    expect((await ctx.businessHub.getInvoice(0)).status).to.equal(2); // Cancelled

    // Cannot double-refund a cancelled invoice.
    const encDouble = await encUint64(ctx, ctx.alice, usdc(80));
    await expect(
      ctx.businessHub.connect(ctx.alice).refundDisputedInvoice(0, encDouble),
    ).to.be.revertedWith("BusinessHub: not disputed");
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

  // #92: payroll recipients must be able to prove income. Before the fix,
  // runPayroll bypassed issueReceipt entirely and `_totalReceived` never
  // bumped for payroll-only employees — so proveIncomeAbove was useless.
  it("runPayroll bumps _totalReceived so employees can proveIncomeAbove", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(1_000));
    await approveHub(ctx, ctx.alice, await ctx.businessHub.getAddress());

    // Wire PaymentReceipts ↔ BusinessHub (what setup-receipts.ts does on prod)
    await ctx.paymentReceipts.setAuthorizedCaller(await ctx.businessHub.getAddress(), true);
    await ctx.businessHub.setPaymentReceipts(await ctx.paymentReceipts.getAddress());

    // Alice runs a payroll to bob (100) + charlie (50)
    const encBob = await encUint64(ctx, ctx.alice, usdc(100));
    const encCharlie = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.businessHub.connect(ctx.alice).runPayroll(
      [ctx.bob.address, ctx.charlie.address],
      await ctx.vault.getAddress(),
      [encBob, encCharlie],
    );

    // Bob now proves income >= 0 (trivially true) — the key is that the
    // proof.result ebool is non-zero (i.e. _totalReceived[bob] was actually
    // initialized + bumped by runPayroll). Before the fix this would still
    // succeed syntactically but would compare against a never-initialized
    // handle and always be false regardless of how much bob received.
    const tx = await ctx.paymentReceipts.connect(ctx.bob).proveIncomeAbove(0);
    const receipt = await tx.wait();
    const event = receipt!.logs.find((l: any) => l.fragment?.name === "ProofCreated");
    expect(event).to.not.be.undefined;
    const proofId = event!.args[0];

    // Anyone publishes bob's verdict.
    const handle = await ctx.paymentReceipts.getProofHandle(proofId);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.paymentReceipts
      .connect(ctx.bob)
      .publishProof(proofId, Boolean(proof.decryptedValue), proof.signature);

    const verdict = await ctx.paymentReceipts.getProof(proofId);
    expect(verdict.prover).to.equal(ctx.bob.address);
    expect(verdict.kind).to.equal("income");
    expect(verdict.isReady).to.equal(true);
    expect(verdict.isTrue).to.equal(true);

    // Sanity: bob's encrypted total received decrypts to exactly the
    // payroll amount (100 USDC) — confirms bumpUserReceived wired through.
    const totalReceivedHandle = await ctx.paymentReceipts.connect(ctx.bob).getMyTotalReceived();
    await mock_expectPlaintext(ctx.bob.provider, totalReceivedHandle, usdc(100));
  });

  // #213 — Only the named client can call payInvoiceFinalize. Previously
  // anyone with the decryption signature could finalize, which let a random
  // third-party flip the invoice status. The defense-in-depth check here
  // ensures only `inv.client` (which under #214 is also the payment-starter)
  // can finalize.
  it("#213 only client can call payInvoiceFinalize", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    // Alice creates invoice for Bob (100 USDC)
    const encInvoiceAmt = await encUint64(ctx, ctx.alice, usdc(100));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encInvoiceAmt,
      "Consulting",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Bob (the client) pays exactly 100 USDC — invoice now PaymentPending
    const encPayment = await encUint64(ctx, ctx.bob, usdc(100));
    await ctx.businessHub.connect(ctx.bob).payInvoice(0, encPayment);

    // Charlie (random third-party) fetches the validation handle + decryption
    // proof. With the old code this would have been enough to finalize.
    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.charlie);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();

    // Charlie tries to finalize — must revert with the #213 message
    await expect(
      ctx.businessHub
        .connect(ctx.charlie)
        .payInvoiceFinalize(0, Boolean(proof.decryptedValue), proof.signature),
    ).to.be.revertedWith("BusinessHub: only client can finalize");

    // Bob (the client + payment-starter) can still finalize successfully
    await ctx.businessHub
      .connect(ctx.bob)
      .payInvoiceFinalize(0, Boolean(proof.decryptedValue), proof.signature);
    const invoice = await ctx.businessHub.getInvoice(0);
    expect(invoice.status).to.equal(1); // Paid
  });

  // #212 — markDelivered must trigger release if depositor already approved.
  // Previously approveRelease only released when beneficiaryMarkedDelivered
  // was already true, and markDelivered never re-checked the condition.
  // Bug: approve-then-deliver got funds stuck. Fix: markDelivered now mirrors
  // the release check.
  it("#212 markDelivered triggers release when depositor already approved", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    // Alice (depositor) needs plaintext USDC approval to BusinessHub
    // (createEscrow pulls from the underlying ERC20, not the encrypted vault).
    const escrowAmount = usdc(50);
    await ctx.testUSDC
      .connect(ctx.alice)
      .approve(await ctx.businessHub.getAddress(), escrowAmount);

    // Alice creates an escrow with Bob as beneficiary, 1-week deadline, no arbiter
    await ctx.businessHub.connect(ctx.alice).createEscrow(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      escrowAmount,
      "Custom artwork",
      hre.ethers.ZeroAddress,
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Alice approves release FIRST (before Bob marks delivered).
    // Original bug: this single-sided approve never re-fires later.
    await ctx.businessHub.connect(ctx.alice).approveRelease(0);
    let escrow = await ctx.businessHub.getEscrow(0);
    expect(escrow.status).to.equal(0); // Active — not yet released

    // Bob's USDC balance pre-release
    const bobBefore = await ctx.testUSDC.balanceOf(ctx.bob.address);

    // Bob marks delivered SECOND. With #212, this should now auto-release.
    await ctx.businessHub.connect(ctx.bob).markDelivered(0);

    escrow = await ctx.businessHub.getEscrow(0);
    expect(escrow.status).to.equal(1); // Released

    // Funds reached Bob (plaintext USDC)
    const bobAfter = await ctx.testUSDC.balanceOf(ctx.bob.address);
    expect(bobAfter - bobBefore).to.equal(escrowAmount);
  });

  // #214 — Only the address that started paying an invoice can continue
  // paying it. Same caller can retry (idempotent). A different client cannot
  // race in even if the contract somehow allowed it. Note: payInvoice already
  // restricts callers to inv.client, so for the named-client invoice the new
  // check is defensive; the test verifies the dedup semantics directly.
  it("#214 invoicePaymentStartedBy locks first payer; same caller may retry", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.bob, usdc(500));
    await approveHub(ctx, ctx.bob, await ctx.businessHub.getAddress());

    // Alice creates invoice for Bob
    const encInvoiceAmt = await encUint64(ctx, ctx.alice, usdc(100));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encInvoiceAmt,
      "Consulting",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Charlie (NOT the named client) tries to pay — already-existing client
    // gate rejects with "not the client". Confirms multi-payer race at the
    // named-client level is impossible.
    const encCharlie = await encUint64(ctx, ctx.charlie, usdc(100));
    await expect(
      ctx.businessHub.connect(ctx.charlie).payInvoice(0, encCharlie),
    ).to.be.revertedWith("BusinessHub: not the client");

    // Bob (the named client) pays — succeeds, invoice → PaymentPending,
    // invoicePaymentStartedBy[0] = bob.
    const encPayment = await encUint64(ctx, ctx.bob, usdc(100));
    await ctx.businessHub.connect(ctx.bob).payInvoice(0, encPayment);
    expect(await ctx.businessHub.invoicePaymentStartedBy(0)).to.equal(ctx.bob.address);

    // Bob may NOT retry payInvoice once status = PaymentPending — the
    // status-check rejects first. (The dedup matters for re-entry windows
    // a future status reset could open.)
    await expect(
      ctx.businessHub.connect(ctx.bob).payInvoice(0, encPayment),
    ).to.be.revertedWith("BusinessHub: not pending");

    // Bob can finalize — he's both the client AND the payment-starter
    const handle = await ctx.businessHub.getInvoiceValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.businessHub
      .connect(ctx.bob)
      .payInvoiceFinalize(0, Boolean(proof.decryptedValue), proof.signature);
    const invoice = await ctx.businessHub.getInvoice(0);
    expect(invoice.status).to.equal(1); // Paid
  });

  // ── #225 Phase 3.5: on-chain CID anchoring ──────────────────────
  // Mappings are zero by default; only the legitimate party can set them;
  // status guards lock evidence once the invoice/escrow finalizes.

  it("#225 setInvoicePdfCidHash anchors a hash, vendor only, while invoice open", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    // Alice creates an invoice for Bob.
    const encAmt = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.businessHub.connect(ctx.alice).createInvoice(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      encAmt,
      "Design work",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    // Default value is zero.
    expect(await ctx.businessHub.invoicePdfCidHash(0)).to.equal(
      hre.ethers.ZeroHash,
    );

    // Vendor (Alice) anchors a hash — succeeds.
    const fakeHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Qm-fake-cid"));
    await expect(
      ctx.businessHub.connect(ctx.alice).setInvoicePdfCidHash(0, fakeHash),
    )
      .to.emit(ctx.businessHub, "InvoicePdfCidSet")
      .withArgs(0, fakeHash, anyValue);
    expect(await ctx.businessHub.invoicePdfCidHash(0)).to.equal(fakeHash);

    // Bob (client, not vendor) is rejected.
    await expect(
      ctx.businessHub.connect(ctx.bob).setInvoicePdfCidHash(0, fakeHash),
    ).to.be.revertedWith("BusinessHub: not the vendor");

    // Once the invoice is cancelled, even the vendor cannot rewrite —
    // settlement evidence is frozen.
    await ctx.businessHub.connect(ctx.alice).cancelInvoice(0);
    const otherHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Qm-other-cid"));
    await expect(
      ctx.businessHub.connect(ctx.alice).setInvoicePdfCidHash(0, otherHash),
    ).to.be.revertedWith("BusinessHub: invoice no longer open");
    // The previously-anchored hash sticks.
    expect(await ctx.businessHub.invoicePdfCidHash(0)).to.equal(fakeHash);
  });

  it("#225 setEscrowAttachmentCidHash — depositor and beneficiary may write while Active", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    // Alice creates an escrow with Bob as beneficiary.
    const escrowAmount = usdc(40);
    await ctx.testUSDC
      .connect(ctx.alice)
      .approve(await ctx.businessHub.getAddress(), escrowAmount);
    await ctx.businessHub.connect(ctx.alice).createEscrow(
      ctx.bob.address,
      await ctx.vault.getAddress(),
      escrowAmount,
      "Build deliverable",
      hre.ethers.ZeroAddress,
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );

    expect(await ctx.businessHub.escrowAttachmentCidHash(0)).to.equal(
      hre.ethers.ZeroHash,
    );

    const aliceHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Qm-brief"));
    const bobHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Qm-deliverable"));

    // Depositor (Alice) anchors a brief.
    await ctx.businessHub.connect(ctx.alice).setEscrowAttachmentCidHash(0, aliceHash);
    expect(await ctx.businessHub.escrowAttachmentCidHash(0)).to.equal(aliceHash);

    // Beneficiary (Bob) overwrites with the deliverable.
    await ctx.businessHub.connect(ctx.bob).setEscrowAttachmentCidHash(0, bobHash);
    expect(await ctx.businessHub.escrowAttachmentCidHash(0)).to.equal(bobHash);

    // Charlie is neither party — rejected.
    await expect(
      ctx.businessHub.connect(ctx.charlie).setEscrowAttachmentCidHash(0, aliceHash),
    ).to.be.revertedWith("BusinessHub: not a party");

    // After release the hash is frozen — both parties approve to release.
    await ctx.businessHub.connect(ctx.bob).markDelivered(0);
    await ctx.businessHub.connect(ctx.alice).approveRelease(0);
    const escrow = await ctx.businessHub.getEscrow(0);
    expect(escrow.status).to.equal(1); // Released

    await expect(
      ctx.businessHub.connect(ctx.alice).setEscrowAttachmentCidHash(0, aliceHash),
    ).to.be.revertedWith("BusinessHub: escrow no longer active");
    // Last write before release sticks.
    expect(await ctx.businessHub.escrowAttachmentCidHash(0)).to.equal(bobHash);
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

  // Flow-blocker #87: settleDebt used to subtract the REQUESTED amount from debts,
  // not the ACTUAL transferred amount. The vault's FHE.select(canTransfer, amount, 0)
  // pattern is all-or-nothing — if balance is insufficient, the vault transfers 0
  // (never partial). Pre-fix, the debt mapping still decremented by `requested`,
  // so the debtor's encrypted debt underflowed to 2^64-1 and the creditor stayed
  // short forever. The fix: debts use `actual` (the return value of
  // transferFromVerified), and the contract emits DebtSettledEncrypted so the
  // frontend can decrypt and warn the user about the failed settlement.
  it("settleDebt with insufficient balance transfers 0 and leaves debts unchanged (no silent underflow)", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    // Alice has only 50 USDC shielded in the vault
    await shield(ctx, ctx.alice, usdc(50));
    await approveHub(ctx, ctx.alice, await ctx.groupManager.getAddress());

    // Create a 2-person group with alice + bob
    await ctx.groupManager.connect(ctx.alice).createGroup("Roommates", [ctx.bob.address]);

    // Bob pays a 100-USDC expense, alice owes 100. After addExpense:
    //   _debts[alice] = +100 (she owes 100)
    //   _debts[bob]   = -100 via underflow (he's owed 100)
    const encAliceShare = await encUint64(ctx, ctx.bob, usdc(100));
    const encTotalPaid = await encUint64(ctx, ctx.bob, usdc(100));
    await ctx.groupManager
      .connect(ctx.bob)
      .addExpense(
        0,
        [ctx.alice.address],
        [encAliceShare],
        encTotalPaid,
        "Rent",
      );

    // Sanity: alice's encrypted debt should be exactly 100
    const aliceDebtBefore = await ctx.groupManager.connect(ctx.alice).getMyDebt(0);
    await mock_expectPlaintext(ctx.alice.provider, aliceDebtBefore, usdc(100));

    // Alice tries to settle the full 100 — but only has 50 in the vault. The
    // vault's transferFromVerified checks gte(balance, amount) with amount=100
    // → false → actualAmount = 0. Nothing moves.
    // Pre-fix: vault transfers 0, debt mapping subtracts 100 → alice's debt
    //          underflows to 2^64-1 and silently breaks the accounting (debtor
    //          thinks paid, creditor still short).
    // Post-fix: vault transfers 0, debt subtracts 0 → alice still owes 100.
    const encSettleAmount = await encUint64(ctx, ctx.alice, usdc(100));
    const tx = await ctx.groupManager
      .connect(ctx.alice)
      .settleDebt(
        0,
        ctx.bob.address,
        await ctx.vault.getAddress(),
        encSettleAmount,
      );
    const receipt = await tx.wait();

    // Assert DebtSettledEncrypted event was emitted (for the frontend to decrypt)
    const encryptedEvent = receipt!.logs.find(
      (l: any) => l.fragment?.name === "DebtSettledEncrypted",
    );
    expect(encryptedEvent, "DebtSettledEncrypted event should be emitted").to.not.be.undefined;

    // Vault untouched: alice kept her 50, bob got nothing (vault clamp rejected the full 100)
    const aliceVaultBal = await ctx.vault.balanceOf(ctx.alice.address);
    const bobVaultBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceVaultBal, usdc(50));
    await mock_expectPlaintext(ctx.bob.provider, bobVaultBal, 0n);

    // Alice's group debt is still 100 (pre-fix this would have been 0, silently
    // losing the 100 USDC of accounting that the vault didn't honor).
    const aliceDebtAfter = await ctx.groupManager.connect(ctx.alice).getMyDebt(0);
    await mock_expectPlaintext(ctx.alice.provider, aliceDebtAfter, usdc(100));

    // The encrypted-actual payload in the event decrypts to exactly 0 — this is
    // what the frontend compares against the requested (100) to warn the user:
    // "tried to settle 100, actually settled 0, still owe 100".
    const encryptedActualHandle = (encryptedEvent as any).args.encryptedActual;
    await mock_expectPlaintext(ctx.alice.provider, encryptedActualHandle, 0n);
  });

  // Sanity: happy-path — sufficient balance settles the full requested amount
  // and decrements the debt correctly. Ensures the new logic doesn't regress
  // the normal flow.
  it("settleDebt with sufficient balance transfers the full amount and decrements debt correctly", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    // Alice has plenty — 200 USDC
    await shield(ctx, ctx.alice, usdc(200));
    await approveHub(ctx, ctx.alice, await ctx.groupManager.getAddress());

    await ctx.groupManager.connect(ctx.alice).createGroup("Roommates", [ctx.bob.address]);

    const encAliceShare = await encUint64(ctx, ctx.bob, usdc(100));
    const encTotalPaid = await encUint64(ctx, ctx.bob, usdc(100));
    await ctx.groupManager
      .connect(ctx.bob)
      .addExpense(0, [ctx.alice.address], [encAliceShare], encTotalPaid, "Rent");

    // Alice settles the full 100
    const encSettle = await encUint64(ctx, ctx.alice, usdc(100));
    const tx = await ctx.groupManager
      .connect(ctx.alice)
      .settleDebt(0, ctx.bob.address, await ctx.vault.getAddress(), encSettle);
    const receipt = await tx.wait();

    // Vault moved 100
    const aliceVaultBal = await ctx.vault.balanceOf(ctx.alice.address);
    const bobVaultBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceVaultBal, usdc(100));
    await mock_expectPlaintext(ctx.bob.provider, bobVaultBal, usdc(100));

    // Alice's debt is zero
    const aliceDebt = await ctx.groupManager.connect(ctx.alice).getMyDebt(0);
    await mock_expectPlaintext(ctx.alice.provider, aliceDebt, 0n);

    // Encrypted-actual event == 100 (full settlement)
    const ev = receipt!.logs.find((l: any) => l.fragment?.name === "DebtSettledEncrypted");
    const handle = (ev as any).args.encryptedActual;
    await mock_expectPlaintext(ctx.alice.provider, handle, usdc(100));
  });

  // #187 mutex: prevent same-block double-settle on the same (group, payer, payee)
  // edge. Approach: pre-seed `lastSettleBlock[0][alice][bob] = currentBlock + 1`
  // via hardhat_setStorageAt (simulates "first settle already happened in THIS
  // block"), then attempt a fresh settle — require() must revert. This is
  // simpler and more deterministic than disabling automine (which destabilizes
  // the mock CoFHE coprocessor's async state).
  //
  // We also verify the happy path untouched: a normal settle in an unseeded
  // edge succeeds, confirming we didn't break the normal flow.
  it("settleDebt blocks a second same-block settle on the same debt edge (#187)", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    await shield(ctx, ctx.alice, usdc(200));
    await approveHub(ctx, ctx.alice, await ctx.groupManager.getAddress());

    // Group with alice + bob; bob pays, alice owes.
    await ctx.groupManager.connect(ctx.alice).createGroup("Roommates", [ctx.bob.address]);
    const encShare = await encUint64(ctx, ctx.bob, usdc(50));
    const encTotal = await encUint64(ctx, ctx.bob, usdc(50));
    await ctx.groupManager
      .connect(ctx.bob)
      .addExpense(0, [ctx.alice.address], [encShare], encTotal, "Utilities");

    // Compute the storage slot for lastSettleBlock[0][alice][bob].
    // Storage layout (slot 13 per storage-layouts/GroupManager.json):
    //   mapping(uint256 => mapping(address => mapping(address => uint256)))
    // For nested mappings, slot(mapping[k]) = keccak256(abi.encode(k, outerSlot)).
    const groupManagerAddress = await ctx.groupManager.getAddress();
    const LAST_SETTLE_BLOCK_SLOT = 13n;
    const abi = hre.ethers.AbiCoder.defaultAbiCoder();
    const innerKey0 = hre.ethers.keccak256(
      abi.encode(["uint256", "uint256"], [0n, LAST_SETTLE_BLOCK_SLOT]),
    );
    const midKey = hre.ethers.keccak256(
      abi.encode(["address", "uint256"], [ctx.alice.address, innerKey0]),
    );
    const finalSlot = hre.ethers.keccak256(
      abi.encode(["address", "uint256"], [ctx.bob.address, midKey]),
    );

    // Seed the slot to a value >= the block number the next tx will run in.
    // Any same-block-or-later settle will then trip
    // `require(lastSettleBlock[...] < block.number)`. We set it to
    // currentBlock + 100 to be bulletproof against small drift.
    const currentBlockNum = await hre.ethers.provider.getBlockNumber();
    const seedValue = BigInt(currentBlockNum + 100);
    const paddedValue = hre.ethers.toBeHex(seedValue, 32);
    await hre.network.provider.send("hardhat_setStorageAt", [
      groupManagerAddress,
      finalSlot,
      paddedValue,
    ]);

    // Sanity: read the slot back via the public getter — confirms our slot
    // calculation is correct. If this is wrong, the test's premise is broken.
    const actualStored = await ctx.groupManager.lastSettleBlock(0, ctx.alice.address, ctx.bob.address);
    expect(actualStored).to.equal(seedValue);

    // Attempt the settle — same edge, seeded slot > block.number → MUST revert.
    const encSettle = await encUint64(ctx, ctx.alice, usdc(20));
    await expect(
      ctx.groupManager
        .connect(ctx.alice)
        .settleDebt(0, ctx.bob.address, await ctx.vault.getAddress(), encSettle),
    ).to.be.revertedWith("GroupManager: already settling this debt this block");

    // Sanity: a DIFFERENT edge (alice → charlie) is NOT affected by the
    // seeded (alice, bob) slot. Add charlie to the group first so he's
    // a valid counterparty, then confirm the settle runs to completion.
    await ctx.groupManager.connect(ctx.alice).addMember(0, ctx.charlie.address);
    const encSettle2 = await encUint64(ctx, ctx.alice, usdc(5));
    await expect(
      ctx.groupManager
        .connect(ctx.alice)
        .settleDebt(0, ctx.charlie.address, await ctx.vault.getAddress(), encSettle2),
    ).to.not.be.reverted;
  });
});

// ══════════════════════════════════════════════════════════════════
//  InheritanceManager — finalizeClaim mutex (#185)
// ══════════════════════════════════════════════════════════════════

describe("InheritanceManager finalizeClaim mutex (#185)", () => {
  // Helper — deploy an InheritanceManager proxy (not in the base fixture
  // because most other test blocks don't need it). Uses the top-of-file
  // `deployProxy` helper via closure.
  async function deployInheritanceFixture() {
    const base = await deployBlankFixture();
    const inheritanceManager = await deployProxy("InheritanceManager", [
      await base.eventHub.getAddress(),
    ]);
    await base.eventHub.batchWhitelist([await inheritanceManager.getAddress()]);
    return { ...base, inheritanceManager };
  }

  it("second finalizeClaim reverts with 'claim already finalized'", async () => {
    const ctx = await deployInheritanceFixture();
    const principal = ctx.alice;
    const heir = ctx.bob;

    // Fund the principal so there's SOMETHING to inherit (also gives the heir
    // a realistic post-finalize vault state to inspect).
    await shield(ctx, principal, usdc(100));

    const MIN_INACTIVITY = 30 * 24 * 3600; // 30 days — matches contract constant

    // Principal configures the plan and lists the vault.
    await ctx.inheritanceManager.connect(principal).setHeir(heir.address, MIN_INACTIVITY);
    await ctx.inheritanceManager
      .connect(principal)
      .setVaults([await ctx.vault.getAddress()]);

    // Principal approves InheritanceManager to drain the vault on finalize.
    await approveHub(ctx, principal, await ctx.inheritanceManager.getAddress());

    // Fast-forward past the inactivity period so the heir can start the claim.
    await hre.network.provider.send("evm_increaseTime", [MIN_INACTIVITY + 1]);
    await hre.network.provider.send("evm_mine", []);

    await ctx.inheritanceManager.connect(heir).startClaim(principal.address);

    // Fast-forward past the 7-day challenge period.
    const CHALLENGE = 7 * 24 * 3600;
    await hre.network.provider.send("evm_increaseTime", [CHALLENGE + 1]);
    await hre.network.provider.send("evm_mine", []);

    // First finalize call — succeeds. Drains vault by requesting MAX (the
    // vault's FHE.select clamps at available balance).
    const MAX = (1n << 64n) - 1n;
    const encMax1 = await encUint64(ctx, heir, MAX);
    await ctx.inheritanceManager.connect(heir).finalizeClaim(principal.address, [encMax1]);

    // #185 assertion — claim flag flipped.
    expect(await ctx.inheritanceManager.claimFinalized(principal.address)).to.equal(true);

    // Second finalize call — MUST revert with the mutex message, not the
    // generic "no plan" (which would also fire because plan.active was
    // flipped false). The require(!claimFinalized[...], ...) runs FIRST.
    const encMax2 = await encUint64(ctx, heir, MAX);
    await expect(
      ctx.inheritanceManager.connect(heir).finalizeClaim(principal.address, [encMax2]),
    ).to.be.revertedWith("InheritanceManager: claim already finalized");
  });

  // CRITICAL: regression pin for the principal-locked-out-forever bug
  // found in the /goal-session contract audit. claimFinalized was a
  // forever-mutex per principal; once any heir succeeded, the
  // principal could NEVER have a working inheritance plan again — a
  // re-setHeir + re-startClaim + finalizeClaim path would revert at
  // require(!claimFinalized[principal]) even with a brand-new heir.
  //
  // Fix: setHeir clears claimFinalized[msg.sender]. This test
  // exercises the FULL second-plan lifecycle to prove the new heir
  // can finalize.
  it("principal can re-create a plan after a prior heir finalized (mutex reset on setHeir)", async () => {
    const ctx = await deployInheritanceFixture();
    const principal = ctx.alice;
    const heir1 = ctx.bob;
    const heir2 = ctx.charlie;
    const MIN_INACTIVITY = 30 * 24 * 3600;
    const CHALLENGE = 7 * 24 * 3600;
    const MAX = (1n << 64n) - 1n;

    // ─── First plan: heir1 (Bob) drains. ───────────────────────────
    await shield(ctx, principal, usdc(100));
    await ctx.inheritanceManager.connect(principal).setHeir(heir1.address, MIN_INACTIVITY);
    await ctx.inheritanceManager.connect(principal).setVaults([await ctx.vault.getAddress()]);
    await approveHub(ctx, principal, await ctx.inheritanceManager.getAddress());
    await hre.network.provider.send("evm_increaseTime", [MIN_INACTIVITY + 1]);
    await hre.network.provider.send("evm_mine", []);
    await ctx.inheritanceManager.connect(heir1).startClaim(principal.address);
    await hre.network.provider.send("evm_increaseTime", [CHALLENGE + 1]);
    await hre.network.provider.send("evm_mine", []);
    const enc1 = await encUint64(ctx, heir1, MAX);
    await ctx.inheritanceManager.connect(heir1).finalizeClaim(principal.address, [enc1]);
    expect(await ctx.inheritanceManager.claimFinalized(principal.address)).to.equal(true);

    // ─── Principal receives fresh funds + creates a new plan with heir2. ──
    // Pre-fix bug: claimFinalized[principal] stayed true, blocking
    // any future heir from finalizing.
    await shield(ctx, principal, usdc(50));
    await ctx.inheritanceManager.connect(principal).setHeir(heir2.address, MIN_INACTIVITY);
    // setHeir MUST clear the mutex.
    expect(await ctx.inheritanceManager.claimFinalized(principal.address)).to.equal(false);

    // ─── Second plan: heir2 (Charlie) drains. Should succeed. ──────
    await ctx.inheritanceManager.connect(principal).setVaults([await ctx.vault.getAddress()]);
    await approveHub(ctx, principal, await ctx.inheritanceManager.getAddress());
    await hre.network.provider.send("evm_increaseTime", [MIN_INACTIVITY + 1]);
    await hre.network.provider.send("evm_mine", []);
    await ctx.inheritanceManager.connect(heir2).startClaim(principal.address);
    await hre.network.provider.send("evm_increaseTime", [CHALLENGE + 1]);
    await hre.network.provider.send("evm_mine", []);
    const enc2 = await encUint64(ctx, heir2, MAX);
    // CRITICAL: pre-fix this would revert with "claim already finalized".
    await expect(
      ctx.inheritanceManager.connect(heir2).finalizeClaim(principal.address, [enc2]),
    ).to.not.be.reverted;

    // Heir2's claim succeeds; the mutex flips again for the new plan.
    expect(await ctx.inheritanceManager.claimFinalized(principal.address)).to.equal(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  PaymentHub — agent-attested payments (ECDSA provenance)
// ══════════════════════════════════════════════════════════════════

describe("PaymentHub agent attestations", () => {
  it("accepts a payment with a valid agent signature and emits AgentPaymentSubmission", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.paymentHub.getAddress());

    // The agent wallet — separate from any user. In production this is
    // the server-side wallet that runs Claude derivations.
    const agent = hre.ethers.Wallet.createRandom();

    const nonce = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const expiry = Math.floor(Date.now() / 1000) + 600;

    // Reproduce the on-chain digest off-chain and sign with the agent key.
    // Contract uses abi.encode (32-byte padded) — match it via AbiCoder.
    const digest = await ctx.paymentHub.agentDigest(ctx.alice.address, nonce, expiry);
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const innerHash = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes32", "uint256", "uint256", "address"],
        [ctx.alice.address, nonce, expiry, chainId, await ctx.paymentHub.getAddress()],
      ),
    );
    const sig = await agent.signMessage(hre.ethers.getBytes(innerHash));

    const enc = await encUint64(ctx, ctx.alice, usdc(15));
    await expect(
      ctx.paymentHub.connect(ctx.alice).sendPaymentAsAgent(
        ctx.bob.address,
        await ctx.vault.getAddress(),
        enc,
        "AI-derived payroll line",
        agent.address,
        nonce,
        expiry,
        sig,
      ),
    )
      .to.emit(ctx.paymentHub, "AgentPaymentSubmission")
      .withArgs(ctx.alice.address, agent.address, nonce, expiry, anyValue);

    const aliceBal = await ctx.vault.balanceOf(ctx.alice.address);
    const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceBal, usdc(85));
    await mock_expectPlaintext(ctx.bob.provider, bobBal, usdc(15));

    expect(await ctx.paymentHub.isAgentNonceUsed(nonce)).to.equal(true);
    // digest stays useful for off-chain verification — it's just the wrapped hash
    expect(digest.length).to.equal(66);
  });

  it("rejects a forged agent signature (wrong signer)", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.paymentHub.getAddress());

    // Real agent + an attacker who tries to claim attribution for the real agent
    const realAgent = hre.ethers.Wallet.createRandom();
    const attacker = hre.ethers.Wallet.createRandom();

    const nonce = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const expiry = Math.floor(Date.now() / 1000) + 600;

    // Attacker signs the digest, but claims agent = realAgent.address — should revert
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const innerHash = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes32", "uint256", "uint256", "address"],
        [ctx.alice.address, nonce, expiry, chainId, await ctx.paymentHub.getAddress()],
      ),
    );
    const sig = await attacker.signMessage(hre.ethers.getBytes(innerHash));

    const enc = await encUint64(ctx, ctx.alice, usdc(5));
    await expect(
      ctx.paymentHub.connect(ctx.alice).sendPaymentAsAgent(
        ctx.bob.address,
        await ctx.vault.getAddress(),
        enc,
        "",
        realAgent.address, // claiming this — but signature was by attacker
        nonce,
        expiry,
        sig,
      ),
    ).to.be.revertedWith("PaymentHub: invalid agent signature");
  });
});

// ══════════════════════════════════════════════════════════════════
//  GiftMoney — expiry enforcement on claim (#241)
// ══════════════════════════════════════════════════════════════════

describe("GiftMoney expiry enforcement (#241)", () => {
  async function deployGiftFixture() {
    const base = await deployBlankFixture();
    const giftMoney = await deployProxy("GiftMoney", [await base.eventHub.getAddress()]);
    await base.eventHub.batchWhitelist([await giftMoney.getAddress()]);
    return { ...base, giftMoney };
  }

  it("claimGift reverts once block.timestamp passes envelope expiry", async () => {
    const ctx = await deployGiftFixture();

    // Alice funds + approves GiftMoney to move encrypted shares into Bob's vault.
    await shield(ctx, ctx.alice, usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.giftMoney.getAddress());

    // Short-lived envelope — expires 60s from now.
    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    const expiry = now + 60;
    const encShare = await encUint64(ctx, ctx.alice, usdc(10));

    await ctx.giftMoney
      .connect(ctx.alice)
      .createEnvelope(
        await ctx.vault.getAddress(),
        [ctx.bob.address],
        [encShare],
        "Happy new year",
        expiry,
      );

    // Advance time past expiry (120s > 60s deadline).
    await hre.network.provider.send("evm_increaseTime", [120]);
    await hre.network.provider.send("evm_mine", []);

    // Bob's claim must revert with the new #241 guard.
    await expect(ctx.giftMoney.connect(ctx.bob).claimGift(0)).to.be.revertedWith(
      "GiftMoney: envelope expired",
    );

    // Sanity: opened state untouched — pre-fix this would have flipped true.
    expect(await ctx.giftMoney.hasOpened(0, ctx.bob.address)).to.equal(false);
  });

  it("claimGift succeeds when envelope has no expiry (legacy + perpetual gifts)", async () => {
    const ctx = await deployGiftFixture();

    await shield(ctx, ctx.alice, usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.giftMoney.getAddress());

    const encShare = await encUint64(ctx, ctx.alice, usdc(10));
    await ctx.giftMoney
      .connect(ctx.alice)
      .createEnvelope(
        await ctx.vault.getAddress(),
        [ctx.bob.address],
        [encShare],
        "Forever gift",
        0, // 0 = no expiry
      );

    // Even after a big time jump the claim should still work.
    await hre.network.provider.send("evm_increaseTime", [365 * 24 * 3600]);
    await hre.network.provider.send("evm_mine", []);

    await expect(ctx.giftMoney.connect(ctx.bob).claimGift(0)).to.not.be.reverted;
    expect(await ctx.giftMoney.hasOpened(0, ctx.bob.address)).to.equal(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  P2PExchange — strict offer expiry on fill (#242)
// ══════════════════════════════════════════════════════════════════

describe("P2PExchange expiry enforcement (#242)", () => {
  async function deployP2PFixture() {
    const base = await deployBlankFixture();
    const p2pExchange = await deployProxy("P2PExchange", [await base.eventHub.getAddress()]);
    await base.eventHub.batchWhitelist([await p2pExchange.getAddress()]);

    // Second vault so we have a distinct tokenGive ↔ tokenWant pair.
    const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
    const testUSDC2 = await TestUSDC.deploy();
    await testUSDC2.waitForDeployment();
    const vault2 = await deployProxy("FHERC20Vault", [
      await testUSDC2.getAddress(),
      "Blank USDC2 Vault",
      "bvUSDC2",
      USDC_DECIMALS,
      await base.eventHub.getAddress(),
    ]);
    await testUSDC2.mint(base.alice.address, usdc(10_000));
    await testUSDC2.mint(base.bob.address, usdc(10_000));
    await testUSDC2.connect(base.alice).approve(await vault2.getAddress(), usdc(10_000));
    await testUSDC2.connect(base.bob).approve(await vault2.getAddress(), usdc(10_000));

    return { ...base, p2pExchange, vault2 };
  }

  it("fillOffer reverts once block.timestamp passes offer expiry", async () => {
    const ctx = await deployP2PFixture();

    // Maker: alice gives vault (USDC), wants vault2 (USDC2). Taker: bob.
    await shield(ctx, ctx.alice, usdc(100));
    await ctx.vault2.connect(ctx.bob).shield(usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.p2pExchange.getAddress());
    await ctx.vault2.connect(ctx.bob).approvePlaintext(
      await ctx.p2pExchange.getAddress(),
      (1n << 64n) - 1n,
    );

    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    const expiry = now + 60;

    await ctx.p2pExchange
      .connect(ctx.alice)
      .createOffer(
        await ctx.vault.getAddress(),  // tokenGive
        await ctx.vault2.getAddress(), // tokenWant
        usdc(50),                      // amountGive
        usdc(50),                      // amountWant
        expiry,
      );

    // Advance time past expiry (120s > 60s deadline).
    await hre.network.provider.send("evm_increaseTime", [120]);
    await hre.network.provider.send("evm_mine", []);

    const encTakerPayment = await encUint64(ctx, ctx.bob, usdc(50));
    const encMakerPayment = await encUint64(ctx, ctx.bob, usdc(50));
    await expect(
      ctx.p2pExchange
        .connect(ctx.bob)
        .fillOffer(0, encTakerPayment, encMakerPayment),
    ).to.be.revertedWith("P2PExchange: offer expired");
  });
});

// ══════════════════════════════════════════════════════════════════
//  PaymentHub — strict agent attestation expiry (#245)
// ══════════════════════════════════════════════════════════════════

describe("PaymentHub agent attestation expiry enforcement (#245)", () => {
  it("sendPaymentAsAgent reverts when attestation expiry is in the past", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(100));
    await approveHub(ctx, ctx.alice, await ctx.paymentHub.getAddress());

    const agent = hre.ethers.Wallet.createRandom();
    const nonce = hre.ethers.hexlify(hre.ethers.randomBytes(32));

    // Expiry = 1 second BEFORE the upcoming block's timestamp. The strict `<`
    // check (post-#245) rejects this — the attestation is already expired.
    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    const expiry = now - 1;

    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const innerHash = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes32", "uint256", "uint256", "address"],
        [ctx.alice.address, nonce, expiry, chainId, await ctx.paymentHub.getAddress()],
      ),
    );
    const sig = await agent.signMessage(hre.ethers.getBytes(innerHash));

    const enc = await encUint64(ctx, ctx.alice, usdc(10));
    await expect(
      ctx.paymentHub.connect(ctx.alice).sendPaymentAsAgent(
        ctx.bob.address,
        await ctx.vault.getAddress(),
        enc,
        "expired attestation",
        agent.address,
        nonce,
        expiry,
        sig,
      ),
    ).to.be.revertedWith("PaymentHub: agent attestation expired");

    // Nonce MUST still be unused — if the require trips, we never mark it.
    expect(await ctx.paymentHub.isAgentNonceUsed(nonce)).to.equal(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  PaymentReceipts — qualification proofs (salary / balance ≥ X)
// ══════════════════════════════════════════════════════════════════

describe("PaymentReceipts qualification proofs", () => {
  it("proveIncomeAbove(0) round-trips to a verified-true public proof", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    // Alice has zero income recorded, so 'income >= 0' is trivially true.
    const tx = await ctx.paymentReceipts.connect(ctx.alice).proveIncomeAbove(0);
    const receipt = await tx.wait();
    const event = receipt!.logs.find((l: any) => l.fragment?.name === "ProofCreated");
    expect(event).to.not.be.undefined;
    const proofId = event!.args[0];

    // Anyone fetches the TN proof and publishes it.
    const handle = await ctx.paymentReceipts.getProofHandle(proofId);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.paymentReceipts
      .connect(ctx.bob)
      .publishProof(proofId, Boolean(proof.decryptedValue), proof.signature);

    const result = await ctx.paymentReceipts.getProof(proofId);
    expect(result.prover).to.equal(ctx.alice.address);
    expect(result.threshold).to.equal(0n);
    expect(result.kind).to.equal("income");
    expect(result.isReady).to.equal(true);
    expect(result.isTrue).to.equal(true);
  });

  it("exposes global volume + tx count handles for public decryption", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    // Both getters must return non-zero handles even on a fresh contract —
    // _globalVolume is initialized in initialize(), _globalTxCount is
    // lazily initialized by _ensureGlobalStatsInit on first issueReceipt
    // (zero handle is fine here pre-issuance — landing-page UI handles 0).
    const volHandle = await ctx.paymentReceipts.getGlobalVolumeHandle();
    expect(volHandle).to.not.equal(0n);

    // Even an unrelated signer who has nothing to do with PaymentReceipts
    // can decrypt the global volume handle, because the contract calls
    // FHE.allowGlobal in initialize. Charlie just needs any self-permit
    // (decryptForView requires one for the SDK plumbing).
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.charlie);
    await ctx.client.permits.createSelf({
      issuer: ctx.charlie.address,
      name: "Public global decrypt",
    });
    const volPublic = await ctx.client.decryptForView(volHandle, FheTypes.Uint64).execute();
    expect(volPublic).to.equal(0n); // fresh deploy — nothing transacted yet
  });

  it("proveIncomeAbove(huge) round-trips to a verified-false public proof", async () => {
    const ctx = await loadFixture(deployBlankFixture);

    // Threshold larger than alice's (zero) income — proof must be false.
    const HUGE = 1_000_000n; // any positive number > 0
    const tx = await ctx.paymentReceipts.connect(ctx.alice).proveIncomeAbove(HUGE);
    const receipt = await tx.wait();
    const event = receipt!.logs.find((l: any) => l.fragment?.name === "ProofCreated");
    const proofId = event!.args[0];

    const handle = await ctx.paymentReceipts.getProofHandle(proofId);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.paymentReceipts
      .connect(ctx.bob)
      .publishProof(proofId, Boolean(proof.decryptedValue), proof.signature);

    const result = await ctx.paymentReceipts.getProof(proofId);
    expect(result.isReady).to.equal(true);
    expect(result.isTrue).to.equal(false);
    expect(result.threshold).to.equal(HUGE);
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

// ══════════════════════════════════════════════════════════════════
//  PaymentHub — per-recipient receipts wiring (#207)
//
//  Before #207, only payroll (BusinessHub) and direct receipt issuance bumped
//  a recipient's _totalReceived counter. Anyone who only ever received via
//  PaymentHub.sendPayment / batchSend / fulfillRequest / sendPaymentAsAgent
//  could not call proveIncomeAbove because their counter was never
//  initialized + bumped. This block proves the wiring lands now.
// ══════════════════════════════════════════════════════════════════

describe("PaymentHub per-recipient receipts (#207)", () => {
  it("sendPayment bumps recipient's _totalReceived for proveIncomeAbove", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    await shield(ctx, ctx.alice, usdc(500));
    await approveHub(ctx, ctx.alice, await ctx.paymentHub.getAddress());

    // Wire PaymentHub ↔ PaymentReceipts (what setup-receipts.ts does on prod)
    await ctx.paymentReceipts.setAuthorizedCaller(await ctx.paymentHub.getAddress(), true);
    await ctx.paymentHub.setPaymentReceipts(await ctx.paymentReceipts.getAddress());

    // Alice sends 75 USDC to Bob.
    const enc = await encUint64(ctx, ctx.alice, usdc(75));
    await ctx.paymentHub
      .connect(ctx.alice)
      .sendPayment(ctx.bob.address, await ctx.vault.getAddress(), enc, "consulting fee");

    // Bob's encrypted total received should decrypt to exactly 75 USDC.
    // Pre-#207 this would either revert (uninitialized handle) or decrypt to 0.
    const totalReceivedHandle = await ctx.paymentReceipts
      .connect(ctx.bob)
      .getMyTotalReceived();
    await mock_expectPlaintext(ctx.bob.provider, totalReceivedHandle, usdc(75));

    // End-to-end: Bob proves income >= 50 (true). Validates that the bumped
    // counter actually flows through proveIncomeAbove → publishProof.
    const tx = await ctx.paymentReceipts.connect(ctx.bob).proveIncomeAbove(usdc(50));
    const receipt = await tx.wait();
    const event = receipt!.logs.find((l: any) => l.fragment?.name === "ProofCreated");
    const proofId = event!.args[0];

    const handle = await ctx.paymentReceipts.getProofHandle(proofId);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.bob);
    const proof = await ctx.client
      .decryptForTx(handle, FheTypes.Bool)
      .withoutPermit()
      .execute();
    await ctx.paymentReceipts
      .connect(ctx.bob)
      .publishProof(proofId, Boolean(proof.decryptedValue), proof.signature);

    const verdict = await ctx.paymentReceipts.getProof(proofId);
    expect(verdict.prover).to.equal(ctx.bob.address);
    expect(verdict.isReady).to.equal(true);
    expect(verdict.isTrue).to.equal(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  GiftMoney — per-recipient receipts + global volume wiring (#204)
//
//  Mirror of #92 (BusinessHub.runPayroll wiring), applied to gifts. Each
//  envelope share must bump the recipient's _totalReceived AND the global
//  encrypted volume aggregate for the landing-page counter.
// ══════════════════════════════════════════════════════════════════

describe("GiftMoney receipts wiring (#204)", () => {
  async function deployGiftWithReceiptsFixture() {
    const base = await deployBlankFixture();
    const giftMoney = await deployProxy("GiftMoney", [await base.eventHub.getAddress()]);
    await base.eventHub.batchWhitelist([await giftMoney.getAddress()]);
    // Wire GiftMoney ↔ PaymentReceipts (mirrors setup-receipts.ts).
    await base.paymentReceipts.setAuthorizedCaller(await giftMoney.getAddress(), true);
    await giftMoney.setPaymentReceipts(await base.paymentReceipts.getAddress());
    return { ...base, giftMoney };
  }

  it("createEnvelope bumps each recipient's _totalReceived AND the global volume", async () => {
    const ctx = await deployGiftWithReceiptsFixture();
    const [, , , , dave, erin] = await hre.ethers.getSigners();

    await shield(ctx, ctx.alice, usdc(500));
    await approveHub(ctx, ctx.alice, await ctx.giftMoney.getAddress());

    // 3-recipient gift with distinct encrypted shares: bob 30, charlie 50, dave 20.
    const encBob = await encUint64(ctx, ctx.alice, usdc(30));
    const encCharlie = await encUint64(ctx, ctx.alice, usdc(50));
    const encDave = await encUint64(ctx, ctx.alice, usdc(20));

    await ctx.giftMoney.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(),
      [ctx.bob.address, ctx.charlie.address, dave.address],
      [encBob, encCharlie, encDave],
      "team bonus",
      0,
    );

    // Each recipient's encrypted _totalReceived should match their share.
    const bobTotal = await ctx.paymentReceipts.connect(ctx.bob).getMyTotalReceived();
    await mock_expectPlaintext(ctx.bob.provider, bobTotal, usdc(30));

    const charlieTotal = await ctx.paymentReceipts.connect(ctx.charlie).getMyTotalReceived();
    await mock_expectPlaintext(ctx.charlie.provider, charlieTotal, usdc(50));

    const daveTotal = await ctx.paymentReceipts.connect(dave).getMyTotalReceived();
    await mock_expectPlaintext(dave.provider, daveTotal, usdc(20));

    // Global volume should decrypt to the sum (100 USDC). Use erin as a
    // disinterested third party — proves the FHE.allowGlobal path works.
    const volHandle = await ctx.paymentReceipts.getGlobalVolumeHandle();
    await hre.cofhe.connectWithHardhatSigner(ctx.client, erin);
    await ctx.client.permits.createSelf({
      issuer: erin.address,
      name: "Public global decrypt — gift volume",
    });
    const volPublic = await ctx.client
      .decryptForView(volHandle, FheTypes.Uint64)
      .execute();
    expect(volPublic).to.equal(usdc(100));
  });
});

// ══════════════════════════════════════════════════════════════════
//  StealthPayments — refund decrements global volume (#199)
//
//  sendStealth bumps the global encrypted volume; refund decrements the
//  same so refunded value doesn't permanently over-count the landing
//  counter. PaymentReceipts.decrementGlobalVolume clamps at zero via
//  FHE.select so an over-refund (impossible in practice but the type
//  permits it) can't underflow the encrypted counter to 2^64-1.
// ══════════════════════════════════════════════════════════════════

describe("StealthPayments refund decrement (#199)", () => {
  async function deployStealthWithReceiptsFixture() {
    const base = await deployBlankFixture();
    const stealthPayments = await deployProxy("StealthPayments", [
      await base.eventHub.getAddress(),
    ]);
    await base.eventHub.batchWhitelist([await stealthPayments.getAddress()]);
    // Wire StealthPayments ↔ PaymentReceipts (mirrors setup-receipts.ts).
    await base.paymentReceipts.setAuthorizedCaller(
      await stealthPayments.getAddress(),
      true,
    );
    await stealthPayments.setPaymentReceipts(await base.paymentReceipts.getAddress());
    return { ...base, stealthPayments };
  }

  it("refund decrements _globalVolume back to its pre-send value", async () => {
    const ctx = await deployStealthWithReceiptsFixture();

    // Approve StealthPayments to pull the underlying USDC into escrow.
    await ctx.testUSDC
      .connect(ctx.alice)
      .approve(await ctx.stealthPayments.getAddress(), usdc(10_000));

    // Snapshot the global volume BEFORE the stealth send via Charlie (a
    // disinterested party with FHE.allowGlobal access). Set an absolute
    // expiration ~1 year past the current block timestamp so it survives the
    // 31-day evm_increaseTime jump below — default expiration (now + 7 days
    // wall-clock) would expire mid-test once block.timestamp jumps ahead.
    const nowTs = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    const FAR_FUTURE_TS = nowTs + 365 * 24 * 3600;
    const volHandleBefore = await ctx.paymentReceipts.getGlobalVolumeHandle();
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.charlie);
    await ctx.client.permits.createSelf({
      issuer: ctx.charlie.address,
      name: "Public global decrypt — stealth refund",
      expiration: FAR_FUTURE_TS,
    });
    const volBefore = await ctx.client
      .decryptForView(volHandleBefore, FheTypes.Uint64)
      .execute();

    // Encrypt the recipient address (bob) and prepare a claim code bound to bob.
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const [encBob] = await ctx.client
      .encryptInputs([Encryptable.address(ctx.bob.address)])
      .execute();
    const claimCode = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const claimCodeHash = hre.ethers.keccak256(
      hre.ethers.solidityPacked(["bytes32", "address"], [claimCode, ctx.bob.address]),
    );

    // Send a 40 USDC stealth payment. _globalVolume should now be volBefore + 40.
    const STEALTH_AMOUNT = usdc(40);
    await ctx.stealthPayments
      .connect(ctx.alice)
      .sendStealth(
        STEALTH_AMOUNT,
        encBob,
        claimCodeHash,
        await ctx.vault.getAddress(),
        "for groceries",
      );

    const volHandleMid = await ctx.paymentReceipts.getGlobalVolumeHandle();
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.charlie);
    const volMid = await ctx.client
      .decryptForView(volHandleMid, FheTypes.Uint64)
      .execute();
    expect(volMid).to.equal(volBefore + STEALTH_AMOUNT);

    // Fast-forward 31 days past the 30-day refund window.
    await hre.network.provider.send("evm_increaseTime", [31 * 24 * 3600]);
    await hre.network.provider.send("evm_mine", []);

    // Refund — must succeed AND decrement the global volume back to volBefore.
    // Sanity: contract returns the underlying tokens; the encrypted
    // _globalVolume handle stays valid for FHE ops (we read + decrypt below).
    const aliceBalBeforeRefund = await ctx.testUSDC.balanceOf(ctx.alice.address);
    await expect(ctx.stealthPayments.connect(ctx.alice).refund(0)).to.not.be.reverted;
    const aliceBalAfterRefund = await ctx.testUSDC.balanceOf(ctx.alice.address);
    expect(aliceBalAfterRefund - aliceBalBeforeRefund).to.equal(STEALTH_AMOUNT);

    // The handle reference may have been replaced inside the contract — fetch
    // the new one and decrypt. Proves the handle is still valid for FHE ops
    // (FHE.allowGlobal preserved through the FHE.select clamp) AND that the
    // value matches volBefore exactly. Re-create the permit AFTER the
    // 31-day time jump — the original would have expired (default permit TTL).
    const volHandleAfter = await ctx.paymentReceipts.getGlobalVolumeHandle();
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.charlie);
    await ctx.client.permits.createSelf({
      issuer: ctx.charlie.address,
      name: "Public global decrypt — stealth refund (post-jump)",
      expiration: FAR_FUTURE_TS,
    });
    const volAfter = await ctx.client
      .decryptForView(volHandleAfter, FheTypes.Uint64)
      .execute();
    expect(volAfter).to.equal(volBefore);
  });
});

// ══════════════════════════════════════════════════════════════════
//  §2.7 + §15.3.1: PaymentReceiptsSet event coverage on pre-Wave-4
//  hubs. Mirrors the same 3-test pattern the 4 Wave 4 contracts got.
//  Hubs covered here: PaymentHub, BusinessHub. GiftMoney +
//  StealthPayments use describe-block-local fixtures elsewhere; add
//  there in a follow-up if the pattern needs to extend.
// ══════════════════════════════════════════════════════════════════

describe("PaymentReceiptsSet event (PaymentHub + BusinessHub)", () => {
  it("PaymentHub: emits PaymentReceiptsSet on first set", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    const fake = "0x000000000000000000000000000000000000bEEF";

    // Deploy fresh PaymentHub so paymentReceipts starts at zero.
    const PaymentHub = await hre.ethers.getContractFactory("PaymentHub");
    const ph = await PaymentHub.deploy();
    await ph.waitForDeployment();
    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const proxy = await ProxyFactory.deploy(
      await ph.getAddress(),
      PaymentHub.interface.encodeFunctionData("initialize", [await ctx.eventHub.getAddress()]),
    );
    await proxy.waitForDeployment();
    const fresh = PaymentHub.attach(await proxy.getAddress()) as any;

    await expect(fresh.connect(ctx.owner).setPaymentReceipts(fake))
      .to.emit(fresh, "PaymentReceiptsSet")
      .withArgs(hre.ethers.ZeroAddress, fake);

    expect(await fresh.paymentReceipts()).to.equal(fake);
  });

  it("PaymentHub: emits PaymentReceiptsSet with prior address on subsequent set", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    const first = "0x000000000000000000000000000000000000dEaD";
    const second = "0x000000000000000000000000000000000000bEEF";

    // Reset from the fixture default (which is the deployed PaymentReceipts).
    await ctx.paymentHub.connect(ctx.owner).setPaymentReceipts(first);

    await expect(ctx.paymentHub.connect(ctx.owner).setPaymentReceipts(second))
      .to.emit(ctx.paymentHub, "PaymentReceiptsSet")
      .withArgs(first, second);
  });

  it("PaymentHub: only owner can call setPaymentReceipts", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    const fake = "0x000000000000000000000000000000000000bEEF";

    await expect(
      ctx.paymentHub.connect(ctx.alice).setPaymentReceipts(fake),
    ).to.be.reverted;
  });

  it("BusinessHub: emits PaymentReceiptsSet with prior address on subsequent set", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    const first = "0x000000000000000000000000000000000000dEaD";
    const second = "0x000000000000000000000000000000000000bEEF";

    await ctx.businessHub.connect(ctx.owner).setPaymentReceipts(first);

    await expect(ctx.businessHub.connect(ctx.owner).setPaymentReceipts(second))
      .to.emit(ctx.businessHub, "PaymentReceiptsSet")
      .withArgs(first, second);
  });

  it("BusinessHub: only owner can call setPaymentReceipts", async () => {
    const ctx = await loadFixture(deployBlankFixture);
    const fake = "0x000000000000000000000000000000000000bEEF";

    await expect(
      ctx.businessHub.connect(ctx.alice).setPaymentReceipts(fake),
    ).to.be.reverted;
  });
});

// ══════════════════════════════════════════════════════════════════
//  PaymentReceiptsSet event coverage on GiftMoney + StealthPayments.
//  These hubs use describe-block-local fixtures elsewhere (#241, #199),
//  but the event-assertion flow doesn't need the receipt-bump wiring;
//  a fresh proxy is enough.
// ══════════════════════════════════════════════════════════════════

describe("PaymentReceiptsSet event (GiftMoney + StealthPayments)", () => {
  async function deployFreshHub(name: "GiftMoney" | "StealthPayments") {
    const [owner, alice] = await hre.ethers.getSigners();
    const eventHub = await deployProxy("EventHub");
    const hub = await deployProxy(name, [await eventHub.getAddress()]);
    return { owner, alice, hub };
  }

  it("GiftMoney: emits PaymentReceiptsSet with previous=zero on first set", async () => {
    const { owner, hub } = await deployFreshHub("GiftMoney");
    const fake = "0x000000000000000000000000000000000000bEEF";

    await expect(hub.connect(owner).setPaymentReceipts(fake))
      .to.emit(hub, "PaymentReceiptsSet")
      .withArgs(hre.ethers.ZeroAddress, fake);

    expect(await hub.paymentReceipts()).to.equal(fake);
  });

  it("GiftMoney: emits PaymentReceiptsSet with prior address on subsequent set", async () => {
    const { owner, hub } = await deployFreshHub("GiftMoney");
    const first = "0x000000000000000000000000000000000000dEaD";
    const second = "0x000000000000000000000000000000000000bEEF";

    await hub.connect(owner).setPaymentReceipts(first);
    await expect(hub.connect(owner).setPaymentReceipts(second))
      .to.emit(hub, "PaymentReceiptsSet")
      .withArgs(first, second);
  });

  it("GiftMoney: only owner can call setPaymentReceipts", async () => {
    const { alice, hub } = await deployFreshHub("GiftMoney");
    const fake = "0x000000000000000000000000000000000000bEEF";

    await expect(
      hub.connect(alice).setPaymentReceipts(fake),
    ).to.be.reverted;
  });

  it("StealthPayments: emits PaymentReceiptsSet with previous=zero on first set", async () => {
    const { owner, hub } = await deployFreshHub("StealthPayments");
    const fake = "0x000000000000000000000000000000000000bEEF";

    await expect(hub.connect(owner).setPaymentReceipts(fake))
      .to.emit(hub, "PaymentReceiptsSet")
      .withArgs(hre.ethers.ZeroAddress, fake);

    expect(await hub.paymentReceipts()).to.equal(fake);
  });

  it("StealthPayments: only owner can call setPaymentReceipts", async () => {
    const { alice, hub } = await deployFreshHub("StealthPayments");
    const fake = "0x000000000000000000000000000000000000bEEF";

    await expect(
      hub.connect(alice).setPaymentReceipts(fake),
    ).to.be.reverted;
  });
});
