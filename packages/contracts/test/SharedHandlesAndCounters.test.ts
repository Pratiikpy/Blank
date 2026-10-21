import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { mock_expectPlaintext, mock_getPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// Regression tests for the shared-handle and counter findings in
// FHERC20Vault, PaymentReceipts, PaymentHub, PrivacyRouter and BusinessHub.
// Each test fails on the pre-fix contracts.

const usdc = (n: number | string) => parseUnits(String(n), 6);
const MAX64 = (1n << 64n) - 1n;
const DAY = 24 * 3600;

async function deployProxy(name: string, initArgs: unknown[] = []) {
  const F = await hre.ethers.getContractFactory(name);
  const impl = await F.deploy();
  await impl.waitForDeployment();
  const data =
    initArgs.length > 0
      ? F.interface.encodeFunctionData("initialize", initArgs)
      : F.interface.encodeFunctionData("initialize");
  const P = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await P.deploy(await impl.getAddress(), data);
  await proxy.waitForDeployment();
  return F.attach(await proxy.getAddress()) as any;
}

async function fixture() {
  const [owner, alice, bob, charlie] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);
  const testUSDC = await (await hre.ethers.getContractFactory("TestUSDC")).deploy();
  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await testUSDC.getAddress(), "Blank USDC Vault", "bvUSDC", 6, await eventHub.getAddress(),
  ]);
  const paymentHub = await deployProxy("PaymentHub", [await eventHub.getAddress()]);
  const businessHub = await deployProxy("BusinessHub", [await eventHub.getAddress()]);
  const paymentReceipts = await deployProxy("PaymentReceipts", []);
  const registry = await deployProxy("TokenRegistry");
  const probe = await (await hre.ethers.getContractFactory("SharedHandleProbe")).deploy();
  await registry.registerToken(await vault.getAddress(), await testUSDC.getAddress(), "USD Coin", "USDC", 6);
  await paymentHub.setTokenRegistry(await registry.getAddress());
  await businessHub.setTokenRegistry(await registry.getAddress());
  await eventHub.batchWhitelist([await paymentHub.getAddress(), await businessHub.getAddress()]);
  await paymentReceipts.setAuthorizedCaller(await paymentHub.getAddress(), true);
  await paymentReceipts.setAuthorizedCaller(await businessHub.getAddress(), true);
  await paymentReceipts.setAuthorizedVault(await vault.getAddress(), true);
  await paymentHub.setPaymentReceipts(await paymentReceipts.getAddress());
  await businessHub.setPaymentReceipts(await paymentReceipts.getAddress());

  for (const s of [alice, bob]) {
    await testUSDC.mint(s.address, usdc(10_000));
    await testUSDC.connect(s).approve(await vault.getAddress(), usdc(10_000));
    await vault.connect(s).shield(usdc(1_000));
    await vault.connect(s).approvePlaintext(await paymentHub.getAddress(), MAX64);
    await vault.connect(s).approvePlaintext(await businessHub.getAddress(), MAX64);
  }
  return {
    owner, alice, bob, charlie, client, testUSDC, eventHub, vault, paymentHub, businessHub, paymentReceipts, registry, probe,
  };
}

type Ctx = Awaited<ReturnType<typeof fixture>>;

async function enc(ctx: Ctx, signer: any, amount: bigint, consuming: string, account?: string) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  let b = ctx.client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming);
  if (account) b = b.setAccount(account);
  return await b.execute();
}

async function decryptBool(ctx: Ctx, signer: any, handle: any) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  return await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
}

// Reads the plaintext straight from the mock store. A permit-based view
// decrypt expires once earlier suites have pushed the chain clock far ahead
// of the wall clock the permit was issued against.
async function snapshotValues(ctx: Ctx) {
  const r = ctx.paymentReceipts;
  const read = async (handle: bigint) => (handle === 0n ? 0n : BigInt(await mock_getPlaintext(ctx.charlie.provider, handle)));
  return [await read(await r.getGlobalVolumeHandle()), await read(await r.getGlobalTxCountHandle())];
}

async function finalize(ctx: Ctx, id: number) {
  const p = await decryptBool(ctx, ctx.charlie, await ctx.paymentHub.getFulfillCheck(id));
  return ctx.paymentHub.connect(ctx.charlie).finalizeRequest(id, Boolean(p.decryptedValue), p.signature);
}

async function proofVerdict(ctx: Ctx, proofId: bigint) {
  const p = await decryptBool(ctx, ctx.charlie, await ctx.paymentReceipts.getProofHandle(proofId));
  return Boolean(p.decryptedValue);
}

describe("F1: raw-handle vault entry points return shared handles", () => {
  async function funded() {
    const ctx = await fixture();
    const vaultAddr = await ctx.vault.getAddress();
    const probeAddr = await ctx.probe.getAddress();
    // Give the probe contract an encrypted balance to move.
    await ctx.vault.connect(ctx.alice).transfer(probeAddr, ...(await enc(ctx, ctx.alice, usdc(300), vaultAddr)));
    return { ...ctx, vaultAddr, probeAddr };
  }

  it("transfer: a contract caller consumes the result with receiveEuint64FromCall", async () => {
    const ctx = await loadFixture(funded);
    const e = await enc(ctx, ctx.owner, usdc(100), ctx.vaultAddr, ctx.probeAddr);
    // Pre-fix the vault returned a bare handle and this reverted with NotShared.
    await ctx.probe.callTransfer(ctx.vaultAddr, ctx.bob.address, ...e);
    await mock_expectPlaintext(ctx.owner.provider, await ctx.probe.last(), usdc(100));
    await mock_expectPlaintext(ctx.owner.provider, await ctx.vault.balanceOf(ctx.probeAddr), usdc(200));
    await mock_expectPlaintext(ctx.owner.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_100));
  });

  it("transfer: a short balance returns a shared zero", async () => {
    const ctx = await loadFixture(funded);
    const e = await enc(ctx, ctx.owner, usdc(5_000), ctx.vaultAddr, ctx.probeAddr);
    await ctx.probe.callTransfer(ctx.vaultAddr, ctx.bob.address, ...e);
    await mock_expectPlaintext(ctx.owner.provider, await ctx.probe.last(), 0n);
    await mock_expectPlaintext(ctx.owner.provider, await ctx.vault.balanceOf(ctx.probeAddr), usdc(300));
  });

  it("transferFrom: a contract spender consumes the result", async () => {
    const ctx = await loadFixture(funded);
    await ctx.vault.connect(ctx.alice).approvePlaintext(ctx.probeAddr, MAX64);
    const e = await enc(ctx, ctx.owner, usdc(50), ctx.vaultAddr, ctx.probeAddr);
    await ctx.probe.callTransferFrom(ctx.vaultAddr, ctx.alice.address, ctx.bob.address, ...e);
    await mock_expectPlaintext(ctx.owner.provider, await ctx.probe.last(), usdc(50));
    await mock_expectPlaintext(ctx.owner.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_050));
  });

  it("transferFrom: no allowance returns a shared zero", async () => {
    const ctx = await loadFixture(funded);
    const e = await enc(ctx, ctx.owner, usdc(50), ctx.vaultAddr, ctx.probeAddr);
    await ctx.probe.callTransferFrom(ctx.vaultAddr, ctx.alice.address, ctx.bob.address, ...e);
    await mock_expectPlaintext(ctx.owner.provider, await ctx.probe.last(), 0n);
  });

  it("requestUnshield: a contract caller consumes the pending handle", async () => {
    const ctx = await loadFixture(funded);
    const e = await enc(ctx, ctx.owner, usdc(20), ctx.vaultAddr, ctx.probeAddr);
    await ctx.probe.callRequestUnshield(ctx.vaultAddr, ...e);
    await mock_expectPlaintext(ctx.owner.provider, await ctx.probe.last(), usdc(20));
    await mock_expectPlaintext(ctx.owner.provider, await ctx.vault.pendingUnshield(ctx.probeAddr), usdc(20));
  });

  it("EOA callers are unchanged: results are ignored and the persistent allow still unseals", async () => {
    const ctx = await loadFixture(funded);
    await ctx.vault.connect(ctx.alice).transfer(ctx.bob.address, ...(await enc(ctx, ctx.alice, usdc(10), ctx.vaultAddr)));
    await ctx.vault.connect(ctx.alice).requestUnshield(...(await enc(ctx, ctx.alice, usdc(5), ctx.vaultAddr)));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.pendingUnshield(ctx.alice.address), usdc(5));
  });

  it("the encrypted-input selectors did not change", async () => {
    const ctx = await loadFixture(fixture);
    const id = (sig: string) => hre.ethers.id(sig).slice(0, 10);
    expect(ctx.vault.interface.getFunction("transfer")!.selector).to.equal(id("transfer(address,bytes32,bytes)"));
    expect(ctx.vault.interface.getFunction("transferFrom")!.selector).to.equal(
      id("transferFrom(address,address,bytes32,bytes)"),
    );
    expect(ctx.vault.interface.getFunction("requestUnshield")!.selector).to.equal(id("requestUnshield(bytes32,bytes)"));
  });
});

describe("F2: proveBalanceAbove reads a fresh share, not a persistent grant", () => {
  async function trusted() {
    const ctx = await fixture();
    await ctx.vault.setTrustedBalanceReader(await ctx.paymentReceipts.getAddress(), true);
    return { ...ctx, receiptsAddr: await ctx.paymentReceipts.getAddress(), vaultAddr: await ctx.vault.getAddress() };
  }

  async function prove(ctx: Awaited<ReturnType<typeof trusted>>, signer: any, threshold: bigint) {
    await ctx.paymentReceipts.connect(signer).proveBalanceAbove(ctx.vaultAddr, threshold);
    return await proofVerdict(ctx, (await ctx.paymentReceipts.proofCount()) - 1n);
  }

  it("proves true and false against the live balance", async () => {
    const ctx = await loadFixture(trusted);
    await ctx.vault.connect(ctx.alice).allowBalanceReader(ctx.receiptsAddr);
    expect(await prove(ctx, ctx.alice, usdc(500))).to.equal(true);
    expect(await prove(ctx, ctx.alice, usdc(2_000))).to.equal(false);
  });

  it("stays correct after the balance handle is replaced (the old grant went stale)", async () => {
    const ctx = await loadFixture(trusted);
    await ctx.vault.connect(ctx.alice).allowBalanceReader(ctx.receiptsAddr);
    expect(await prove(ctx, ctx.alice, usdc(500))).to.equal(true);

    // Every balance write replaces the handle. Pre-fix the reader held a
    // grant on the old handle only, so the next proof reverted.
    await ctx.vault.connect(ctx.alice).transfer(ctx.bob.address, ...(await enc(ctx, ctx.alice, usdc(900), ctx.vaultAddr)));
    expect(await prove(ctx, ctx.alice, usdc(500))).to.equal(false);
    expect(await prove(ctx, ctx.alice, usdc(100))).to.equal(true);

    await ctx.vault.connect(ctx.alice).shield(usdc(2_000));
    expect(await prove(ctx, ctx.alice, usdc(2_000))).to.equal(true);
  });

  it("a user who did not consent cannot be proven, even by a trusted reader", async () => {
    const ctx = await loadFixture(trusted);
    await expect(ctx.paymentReceipts.connect(ctx.bob).proveBalanceAbove(ctx.vaultAddr, 1n))
      .to.be.revertedWith("FHERC20Vault: reader not allowed");
  });

  it("consent can be revoked", async () => {
    const ctx = await loadFixture(trusted);
    await ctx.vault.connect(ctx.alice).allowBalanceReader(ctx.receiptsAddr);
    expect(await ctx.vault.isBalanceReader(ctx.alice.address, ctx.receiptsAddr)).to.equal(true);
    await expect(ctx.vault.connect(ctx.alice).revokeBalanceReader(ctx.receiptsAddr))
      .to.emit(ctx.vault, "BalanceReaderConsent").withArgs(ctx.alice.address, ctx.receiptsAddr, false);
    expect(await ctx.vault.isBalanceReader(ctx.alice.address, ctx.receiptsAddr)).to.equal(false);
    await expect(ctx.paymentReceipts.connect(ctx.alice).proveBalanceAbove(ctx.vaultAddr, 1n))
      .to.be.revertedWith("FHERC20Vault: reader not allowed");
  });

  it("users can only consent to readers the owner trusts", async () => {
    const ctx = await loadFixture(fixture);
    const receipts = await ctx.paymentReceipts.getAddress();
    await expect(ctx.vault.connect(ctx.alice).allowBalanceReader(receipts))
      .to.be.revertedWith("FHERC20Vault: reader not trusted");
    await expect(ctx.vault.connect(ctx.alice).allowBalanceReader(ctx.charlie.address))
      .to.be.revertedWith("FHERC20Vault: reader not trusted");
    await expect(ctx.vault.connect(ctx.alice).allowBalanceReader(hre.ethers.ZeroAddress))
      .to.be.revertedWith("FHERC20Vault: reader zero");
  });

  it("only the owner trusts readers, and only contracts", async () => {
    const ctx = await loadFixture(fixture);
    const receipts = await ctx.paymentReceipts.getAddress();
    await expect(ctx.vault.connect(ctx.alice).setTrustedBalanceReader(receipts, true))
      .to.be.revertedWithCustomError(ctx.vault, "OwnableUnauthorizedAccount");
    await expect(ctx.vault.setTrustedBalanceReader(ctx.charlie.address, true))
      .to.be.revertedWith("FHERC20Vault: bad reader");
    await expect(ctx.vault.setTrustedBalanceReader(receipts, true))
      .to.emit(ctx.vault, "TrustedBalanceReaderSet").withArgs(receipts, true);
    // Untrusting works for any address, and takes effect for consenting users.
    await ctx.vault.connect(ctx.alice).allowBalanceReader(receipts);
    await ctx.vault.setTrustedBalanceReader(receipts, false);
    expect(await ctx.vault.isBalanceReader(ctx.alice.address, receipts)).to.equal(false);
    await expect(ctx.paymentReceipts.connect(ctx.alice).proveBalanceAbove(await ctx.vault.getAddress(), 1n))
      .to.be.revertedWith("FHERC20Vault: reader not allowed");
  });

  it("shareBalanceWithReader cannot be called by a user or an untrusted contract", async () => {
    const ctx = await loadFixture(trusted);
    await ctx.vault.connect(ctx.alice).allowBalanceReader(ctx.receiptsAddr);
    await expect(ctx.vault.connect(ctx.alice).shareBalanceWithReader(ctx.alice.address))
      .to.be.revertedWith("FHERC20Vault: reader not allowed");
    await expect(ctx.vault.connect(ctx.bob).shareBalanceWithReader(ctx.alice.address))
      .to.be.revertedWith("FHERC20Vault: reader not allowed");
  });

  it("a vault that is not whitelisted in PaymentReceipts is still refused", async () => {
    const ctx = await loadFixture(trusted);
    await ctx.paymentReceipts.setAuthorizedVault(ctx.vaultAddr, false);
    await ctx.vault.connect(ctx.alice).allowBalanceReader(ctx.receiptsAddr);
    await expect(ctx.paymentReceipts.connect(ctx.alice).proveBalanceAbove(ctx.vaultAddr, 1n))
      .to.be.revertedWith("PaymentReceipts: vault not authorized");
  });
});

describe("F3: counters only count payments that moved something", () => {
  it("PaymentHub: short-balance sends do not inflate the global tx count", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    const vaultAddr = await ctx.vault.getAddress();
    // Alice holds 1000 and asks to send 5000: the vault moves 0 and does not revert.
    for (let i = 0; i < 5; i++) {
      await ctx.paymentHub.connect(ctx.alice).sendPayment(
        ctx.bob.address, vaultAddr, ...(await enc(ctx, ctx.alice, usdc(5_000), hub)), "",
      );
    }
    await ctx.paymentReceipts.publishGlobalSnapshot();
    // Pre-fix the count was 5 and the snapshot published it.
    expect(await snapshotValues(ctx)).to.deep.equal([0n, 0n]);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_000));
    await mock_expectPlaintext(ctx.bob.provider, await ctx.paymentReceipts.connect(ctx.bob).getMyTotalReceived(), 0n);
  });

  it("PaymentHub: batchSend counts only the legs that moved", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    const vaultAddr = await ctx.vault.getAddress();
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    // Three recipients per batch; the second amount is far above the balance.
    // Alice's 1000 covers 100 + 200 only because the oversized leg moves 0.
    const amounts = [usdc(100), usdc(5_000), usdc(200)];
    const b = await ctx.client.encryptInputs(amounts.map((a) => Encryptable.uint64(a))).setConsumingContract(hub).execute();
    await ctx.paymentHub.connect(ctx.alice).batchSend(
      [ctx.bob.address, ctx.bob.address, ctx.bob.address], vaultAddr, b.slice(0, -1), b[b.length - 1], ["", "", ""],
    );
    // Three more single sends of 10 reach the MIN_SNAPSHOT_TXS threshold of 5 moved payments.
    for (let i = 0; i < 3; i++) {
      await ctx.paymentHub.connect(ctx.alice).sendPayment(
        ctx.bob.address, vaultAddr, ...(await enc(ctx, ctx.alice, usdc(10), hub)), "",
      );
    }
    await ctx.paymentReceipts.publishGlobalSnapshot();
    // 2 moved batch legs + 3 sends = 5, not 6. Volume is 100 + 200 + 30.
    expect(await snapshotValues(ctx)).to.deep.equal([usdc(330), 5n]);
  });

  it("BusinessHub.runPayroll: short-balance payroll cannot inflate counts or income", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.businessHub.getAddress();
    const vaultAddr = await ctx.vault.getAddress();
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    for (let i = 0; i < 3; i++) {
      const b = await ctx.client
        .encryptInputs([Encryptable.uint64(usdc(5_000)), Encryptable.uint64(usdc(5_000))])
        .setConsumingContract(hub)
        .execute();
      await ctx.businessHub.connect(ctx.alice).runPayroll(
        [ctx.bob.address, ctx.charlie.address], vaultAddr, b.slice(0, -1), b[b.length - 1],
      );
    }
    await ctx.paymentReceipts.publishGlobalSnapshot();
    // Pre-fix: six bumps of 1 reached the snapshot.
    expect(await snapshotValues(ctx)).to.deep.equal([0n, 0n]);
    await mock_expectPlaintext(ctx.charlie.provider, await ctx.paymentReceipts.connect(ctx.charlie).getMyTotalReceived(), 0n);
  });

  it("BusinessHub.runPayroll: a funded payroll still records income and counts", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.businessHub.getAddress();
    const vaultAddr = await ctx.vault.getAddress();
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    for (let i = 0; i < 3; i++) {
      const b = await ctx.client
        .encryptInputs([Encryptable.uint64(usdc(10)), Encryptable.uint64(usdc(20))])
        .setConsumingContract(hub)
        .execute();
      await ctx.businessHub.connect(ctx.alice).runPayroll(
        [ctx.bob.address, ctx.charlie.address], vaultAddr, b.slice(0, -1), b[b.length - 1],
      );
    }
    await ctx.paymentReceipts.publishGlobalSnapshot();
    expect(await snapshotValues(ctx)).to.deep.equal([usdc(90), 6n]);
    await mock_expectPlaintext(ctx.charlie.provider, await ctx.paymentReceipts.connect(ctx.charlie).getMyTotalReceived(), usdc(60));
  });

  async function issue(ctx: Ctx, payer: string, payee: string, amount: bigint) {
    const r = ctx.paymentReceipts;
    // The cofhe mock's randomEuint64 handle only accepts FHE.allowThis when its
    // timestamp-derived hash happens to carry the trivial-encryption flag.
    // Retry on a new timestamp.
    for (let i = 0; i < 32; i++) {
      const e1 = await enc(ctx, ctx.owner, amount, await r.getAddress());
      try {
        await (await r.connect(ctx.owner).issueReceipt(payer, payee, ...e1, await ctx.vault.getAddress())).wait();
        return;
      } catch {
        await time.increase(1);
      }
    }
    throw new Error("issueReceipt kept failing");
  }

  it("PaymentReceipts.issueReceipt: a zero amount adds nothing to per-user or global counts", async () => {
    const ctx = await loadFixture(fixture);
    const r = ctx.paymentReceipts;
    await issue(ctx, ctx.alice.address, ctx.bob.address, 0n);
    await mock_expectPlaintext(ctx.alice.provider, await r.connect(ctx.alice).getMyTransactionCount(), 0n);
    await mock_expectPlaintext(ctx.bob.provider, await r.connect(ctx.bob).getMyTransactionCount(), 0n);
    await issue(ctx, ctx.alice.address, ctx.bob.address, usdc(7));
    await mock_expectPlaintext(ctx.alice.provider, await r.connect(ctx.alice).getMyTransactionCount(), 1n);
    await mock_expectPlaintext(ctx.bob.provider, await r.connect(ctx.bob).getMyTransactionCount(), 1n);

    // Four more zero receipts must not carry the global count to the snapshot threshold.
    for (let i = 0; i < 4; i++) await issue(ctx, ctx.alice.address, ctx.bob.address, 0n);
    await r.publishGlobalSnapshot();
    expect(await snapshotValues(ctx)).to.deep.equal([0n, 0n]);
  });
});

describe("F3: a request stuck in Settling can be recovered", () => {
  const PENDING = 0, FULFILLED = 1, CANCELLED = 2, SETTLING = 3;

  async function settling() {
    const ctx = await fixture();
    const hub = await ctx.paymentHub.getAddress();
    const vaultAddr = await ctx.vault.getAddress();
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, vaultAddr, ...(await enc(ctx, ctx.bob, usdc(40), hub)), "rent",
    );
    // A wrong amount moves nothing; the request waits in Settling for a decrypt
    // that, in this scenario, is never delivered.
    await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, 1n, hub)));
    return { ...ctx, hub, vaultAddr };
  }

  it("is not reopenable before the timeout, and only by a party", async () => {
    const ctx = await loadFixture(settling);
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(SETTLING);
    expect(await ctx.paymentHub.SETTLING_TIMEOUT()).to.equal(BigInt(DAY));
    await expect(ctx.paymentHub.connect(ctx.alice).reopenSettlingRequest(0))
      .to.be.revertedWith("PaymentHub: settling not expired");
    await time.increase(DAY + 1);
    await expect(ctx.paymentHub.connect(ctx.charlie).reopenSettlingRequest(0))
      .to.be.revertedWith("PaymentHub: not a party");
  });

  it("the creator reopens after the timeout and cancels", async () => {
    const ctx = await loadFixture(settling);
    await time.increase(DAY + 1);
    await expect(ctx.paymentHub.connect(ctx.bob).reopenSettlingRequest(0))
      .to.emit(ctx.paymentHub, "RequestSettlingReopened").withArgs(0, ctx.bob.address, anyValue);
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(PENDING);
    await ctx.paymentHub.connect(ctx.bob).cancelRequest(0);
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(CANCELLED);
  });

  it("the payer reopens after the timeout and retries to Fulfilled", async () => {
    const ctx = await loadFixture(settling);
    await time.increase(DAY + 1);
    await ctx.paymentHub.connect(ctx.alice).reopenSettlingRequest(0);
    // The abandoned attempt can no longer be finalized.
    await expect(ctx.paymentHub.finalizeRequest(0, false, "0x")).to.be.revertedWith("PaymentHub: not settling");

    await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, usdc(40), ctx.hub)));
    // The retry restarts the clock.
    await expect(ctx.paymentHub.connect(ctx.alice).reopenSettlingRequest(0))
      .to.be.revertedWith("PaymentHub: settling not expired");
    await expect(finalize(ctx, 0)).to.emit(ctx.paymentHub, "RequestFulfilled");
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(FULFILLED);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_040));
  });

  it("a retry after an undelivered successful attempt cannot pay twice", async () => {
    const ctx = await fixture();
    const hub = await ctx.paymentHub.getAddress();
    const vaultAddr = await ctx.vault.getAddress();
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, vaultAddr, ...(await enc(ctx, ctx.bob, usdc(40), hub)), "rent",
    );
    // First attempt pays in full, but its decryption is never delivered.
    await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, usdc(40), hub)));
    await time.increase(DAY + 1);
    await ctx.paymentHub.connect(ctx.alice).reopenSettlingRequest(0);

    // The payer retries the same request.
    await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, usdc(40), hub)));
    await expect(finalize(ctx, 0)).to.emit(ctx.paymentHub, "RequestFulfilled");
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(FULFILLED);

    // Bob received 40 once, Alice paid 40 once.
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_040));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(960));
  });

  it("rejects requests that are not Settling", async () => {
    const ctx = await loadFixture(settling);
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, ctx.vaultAddr, ...(await enc(ctx, ctx.bob, usdc(1), ctx.hub)), "",
    );
    await time.increase(DAY + 1);
    await expect(ctx.paymentHub.connect(ctx.bob).reopenSettlingRequest(1))
      .to.be.revertedWith("PaymentHub: not settling");
  });
});

describe("F4: setters reject codeless addresses", () => {
  it("BusinessHub, PrivacyRouter and PaymentReceipts", async () => {
    const ctx = await loadFixture(fixture);
    const eoa = ctx.charlie.address;
    await expect(ctx.businessHub.setEventHub(eoa)).to.be.revertedWith("BusinessHub: bad event hub");
    await expect(ctx.businessHub.setPaymentReceipts(eoa)).to.be.revertedWith("BusinessHub: bad receipts");
    await ctx.businessHub.setPaymentReceipts(hre.ethers.ZeroAddress);
    await ctx.businessHub.setPaymentReceipts(await ctx.paymentReceipts.getAddress());
    await ctx.businessHub.setEventHub(await ctx.eventHub.getAddress());

    const router = await deployProxy("PrivacyRouter", [ctx.alice.address, await ctx.eventHub.getAddress()]);
    await expect(router.setEventHub(eoa)).to.be.revertedWith("PrivacyRouter: bad event hub");
    await router.setEventHub(await ctx.eventHub.getAddress());

    await expect(ctx.paymentReceipts.setAuthorizedVault(eoa, true)).to.be.revertedWith("PaymentReceipts: bad vault");
    // De-authorizing never needs code.
    await ctx.paymentReceipts.setAuthorizedVault(eoa, false);
  });
});
