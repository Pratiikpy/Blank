import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ACP ids are wall-clock seconds minus 60; the mock revoker rejects an id
// ahead of the chain, which happens once snapshot reverts leave the chain
// clock behind real time.
async function syncChainClock() {
  const now = Math.floor(Date.now() / 1000);
  if ((await time.latest()) < now) await time.increaseTo(now);
}

// Exploit tests for the pre-mainnet audit fixes in FHERC20Vault, PaymentHub
// and PaymentReceipts. Each test fails on the pre-fix code.

const usdc = (n: number | string) => parseUnits(String(n), 6);
const MAX64 = (1n << 64n) - 1n;

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
  const paymentReceipts = await deployProxy("PaymentReceipts", []);
  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await testUSDC.getAddress(), "USD Coin", "USDC", 6);
  await paymentHub.setTokenRegistry(await registry.getAddress());
  await eventHub.batchWhitelist([await paymentHub.getAddress()]);
  await paymentReceipts.setAuthorizedCaller(await paymentHub.getAddress(), true);
  await paymentHub.setPaymentReceipts(await paymentReceipts.getAddress());

  for (const s of [alice, bob]) {
    await testUSDC.mint(s.address, usdc(10_000));
    await testUSDC.connect(s).approve(await vault.getAddress(), usdc(10_000));
    await vault.connect(s).shield(usdc(1_000));
    await vault.connect(s).approvePlaintext(await paymentHub.getAddress(), MAX64);
  }
  return { owner, alice, bob, charlie, client, testUSDC, eventHub, vault, paymentHub, paymentReceipts, registry };
}

type Ctx = Awaited<ReturnType<typeof fixture>>;

async function enc(ctx: Ctx, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  return await ctx.client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

async function decryptBool(ctx: Ctx, signer: any, handle: any) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  return await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
}

async function snapshotValues(ctx: Ctx) {
  const r = ctx.paymentReceipts;
  await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.charlie);
  await syncChainClock();
  await ctx.client.acp.createSelf({ issuer: ctx.charlie.address, name: "global" });
  await hre.network.provider.send("hardhat_mine", ["0x1"]);
  return [
    await ctx.client.decryptForView(await r.getGlobalVolumeHandle(), FheTypes.Uint64).execute(),
    await ctx.client.decryptForView(await r.getGlobalTxCountHandle(), FheTypes.Uint64).execute(),
  ];
}

async function finalize(ctx: Ctx, id: number) {
  const p = await decryptBool(ctx, ctx.charlie, await ctx.paymentHub.getFulfillCheck(id));
  return ctx.paymentHub.connect(ctx.charlie).finalizeRequest(id, Boolean(p.decryptedValue), p.signature);
}

describe("Audit A1: PaymentHub vault allowlist", () => {
  it("every entry point rejects an unregistered vault", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    const fake = await (await (await hre.ethers.getContractFactory("MockVaultStub")).deploy(
      await ctx.testUSDC.getAddress(),
    )).getAddress();

    const e1 = await enc(ctx, ctx.alice, usdc(1), hub);
    await expect(ctx.paymentHub.connect(ctx.alice).sendPayment(ctx.bob.address, fake, ...e1, ""))
      .to.be.revertedWith("PaymentHub: vault not allowed");
    await expect(ctx.paymentHub.connect(ctx.alice).createRequest(ctx.bob.address, fake, ...e1, ""))
      .to.be.revertedWith("PaymentHub: vault not allowed");

    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const b = await ctx.client.encryptInputs([Encryptable.uint64(1n)]).setConsumingContract(hub).execute();
    await expect(
      ctx.paymentHub.connect(ctx.alice).batchSend([ctx.bob.address], fake, b.slice(0, -1), b[b.length - 1], [""]),
    ).to.be.revertedWith("PaymentHub: vault not allowed");

    const nonce = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const expiry = (await time.latest()) + 3600;
    const sig = await ctx.charlie.signMessage(
      hre.ethers.getBytes(
        hre.ethers.keccak256(
          hre.ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "bytes32", "uint256", "uint256", "address"],
            [ctx.alice.address, nonce, expiry, (await hre.ethers.provider.getNetwork()).chainId, hub],
          ),
        ),
      ),
    );
    await expect(
      ctx.paymentHub.connect(ctx.alice).sendPaymentAsAgent(
        ctx.bob.address, fake, ...e1, "", ctx.charlie.address, nonce, expiry, sig,
      ),
    ).to.be.revertedWith("PaymentHub: vault not allowed");
  });

  it("fulfillRequest rejects a request whose vault was deactivated; cancel still works", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.bob, usdc(5), hub)), "",
    );
    await ctx.registry.deactivateToken(await ctx.vault.getAddress());
    await expect(
      ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, usdc(5), hub))),
    ).to.be.revertedWith("PaymentHub: vault not allowed");
    await ctx.paymentHub.connect(ctx.bob).cancelRequest(0);
  });

  it("fails closed with no registry set", async () => {
    const ctx = await loadFixture(fixture);
    const bare = await deployProxy("PaymentHub", [await ctx.eventHub.getAddress()]);
    const e1 = await enc(ctx, ctx.alice, usdc(1), await bare.getAddress());
    await expect(
      bare.connect(ctx.alice).sendPayment(ctx.bob.address, await ctx.vault.getAddress(), ...e1, ""),
    ).to.be.revertedWith("PaymentHub: vault not allowed");
  });
});

describe("Audit A8: PaymentHub requests cannot be marked Fulfilled unpaid", () => {
  const PENDING = 0, FULFILLED = 1, SETTLING = 3;

  it("exact amount: Settling, then Fulfilled after finalize", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.bob, usdc(40), hub)), "rent",
    );
    await expect(ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, usdc(40), hub))))
      .to.emit(ctx.paymentHub, "RequestSettling");
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(SETTLING);
    // Double pay is blocked while settling.
    await expect(
      ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, usdc(40), hub))),
    ).to.be.revertedWith("PaymentHub: not pending");

    await expect(finalize(ctx, 0)).to.emit(ctx.paymentHub, "RequestFulfilled");
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(FULFILLED);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_040));
  });

  it("wrong amount moves nothing and returns to Pending", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.bob, usdc(40), hub)), "",
    );
    // Pre-fix: 1 wei moved and the request was marked Fulfilled.
    await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, 1n, hub)));
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_000));
    await expect(finalize(ctx, 0)).to.emit(ctx.paymentHub, "RequestFulfillFailed");
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(PENDING);
    // A failed attempt records no receipt at all.
    expect(await ctx.paymentReceipts.connect(ctx.bob).getMyTotalReceived()).to.equal(0n);
  });

  // Round 2: every failed attempt used to add 1 to the global tx count.
  it("failed attempts do not bump receipts; only the settled one does", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.bob, usdc(40), hub)), "",
    );
    for (let i = 0; i < 5; i++) {
      await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, 1n, hub)));
      await finalize(ctx, 0);
    }
    await ctx.paymentReceipts.publishGlobalSnapshot();
    expect(await snapshotValues(ctx)).to.deep.equal([0n, 0n]);

    await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, usdc(40), hub)));
    expect(await ctx.paymentReceipts.connect(ctx.bob).getMyTotalReceived()).to.equal(0n);
    await finalize(ctx, 0);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.paymentReceipts.connect(ctx.bob).getMyTotalReceived(), usdc(40));
  });

  it("short balance moves nothing and returns to Pending", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.bob, usdc(5_000), hub)), "",
    );
    await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, usdc(5_000), hub)));
    await finalize(ctx, 0);
    expect((await ctx.paymentHub.getRequest(0)).status).to.equal(PENDING);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
  });

  it("finalize rejects a request that is not settling, and a forged result", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    await ctx.paymentHub.connect(ctx.bob).createRequest(
      ctx.alice.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.bob, usdc(40), hub)), "",
    );
    await expect(ctx.paymentHub.finalizeRequest(0, true, "0x")).to.be.revertedWith("PaymentHub: not settling");
    await ctx.paymentHub.connect(ctx.alice).fulfillRequest(0, ...(await enc(ctx, ctx.alice, 1n, hub)));
    const p = await decryptBool(ctx, ctx.charlie, await ctx.paymentHub.getFulfillCheck(0));
    expect(Boolean(p.decryptedValue)).to.equal(false);
    await expect(ctx.paymentHub.finalizeRequest(0, true, p.signature)).to.be.reverted;
  });
});

describe("Audit A6: setters reject codeless addresses", () => {
  it("PaymentHub and FHERC20Vault", async () => {
    const ctx = await loadFixture(fixture);
    const eoa = ctx.charlie.address;
    await expect(ctx.paymentHub.setEventHub(eoa)).to.be.revertedWith("PaymentHub: bad event hub");
    await expect(ctx.paymentHub.setPaymentReceipts(eoa)).to.be.revertedWith("PaymentHub: bad receipts");
    await expect(ctx.paymentHub.setTokenRegistry(eoa)).to.be.revertedWith("PaymentHub: bad registry");
    await expect(ctx.paymentHub.connect(ctx.alice).setTokenRegistry(await ctx.registry.getAddress())).to.be.reverted;
    await expect(ctx.vault.setEventHub(eoa)).to.be.revertedWith("FHERC20Vault: bad event hub");
    await ctx.paymentHub.setPaymentReceipts(hre.ethers.ZeroAddress);
  });
});

describe("Audit A4/A5/A7: FHERC20Vault", () => {
  it("A5: fee-on-transfer shield credits only what arrived", async () => {
    const ctx = await loadFixture(fixture);
    const Fee = await hre.ethers.getContractFactory("TestFeeToken");
    const fee = await Fee.deploy();
    const v = await deployProxy("FHERC20Vault", [await fee.getAddress(), "Fee", "vFEE", 6, await ctx.eventHub.getAddress()]);
    await fee.mint(ctx.alice.address, 1_000_000n);
    await fee.connect(ctx.alice).approve(await v.getAddress(), 1_000_000n);
    await v.connect(ctx.alice).shield(1_000_000n);
    // 1% fee: the vault holds 990_000, the credit must match.
    expect(await fee.balanceOf(await v.getAddress())).to.equal(990_000n);
    await mock_expectPlaintext(ctx.alice.provider, await v.balanceOf(ctx.alice.address), 990_000n);
  });

  it("A4: shield cannot push vault holdings past uint64 (no encrypted wrap)", async () => {
    const ctx = await loadFixture(fixture);
    const Tok = await hre.ethers.getContractFactory("MockERC20Decimals");
    const t = await Tok.deploy(6);
    const v = await deployProxy("FHERC20Vault", [await t.getAddress(), "Big", "vBIG", 6, await ctx.eventHub.getAddress()]);
    await t.mint(ctx.alice.address, MAX64 + 10n);
    await t.connect(ctx.alice).approve(await v.getAddress(), MAX64 + 10n);
    await v.connect(ctx.alice).shield(MAX64);
    await mock_expectPlaintext(ctx.alice.provider, await v.balanceOf(ctx.alice.address), MAX64);
    // Pre-fix this succeeded and wrapped the balance to 9.
    await expect(v.connect(ctx.alice).shield(10n)).to.be.revertedWith("FHERC20Vault: vault supply cap");
    await mock_expectPlaintext(ctx.alice.provider, await v.balanceOf(ctx.alice.address), MAX64);
  });

  it("A4: transfers keep supply consistent (no credit without debit)", async () => {
    const ctx = await loadFixture(fixture);
    const e1 = await enc(ctx, ctx.alice, usdc(300), await ctx.vault.getAddress());
    await ctx.vault.connect(ctx.alice).transfer(ctx.bob.address, ...e1);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(700));
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(1_300));
  });

  it("A7: user can read the reset pending handle after claimUnshield", async () => {
    const ctx = await loadFixture(fixture);
    const e1 = await enc(ctx, ctx.alice, usdc(20), await ctx.vault.getAddress());
    await ctx.vault.connect(ctx.alice).requestUnshield(...e1);
    const pending = await ctx.vault.pendingUnshield(ctx.alice.address);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const p = await ctx.client.decryptForTx(pending, FheTypes.Uint64).withoutACP().execute();
    await ctx.vault.connect(ctx.alice).claimUnshield(p.decryptedValue, p.signature);

    const reset = await ctx.vault.pendingUnshield(ctx.alice.address);
    // Pre-fix: only the vault was allowed on the new handle; this view decrypt failed.
    await syncChainClock();
    await ctx.client.acp.createSelf({ issuer: ctx.alice.address, name: "pending" });
    await hre.network.provider.send("hardhat_mine", ["0x1"]);
    expect(await ctx.client.decryptForView(reset, FheTypes.Uint64).execute()).to.equal(0n);
  });
});

describe("Audit A2/A3: PaymentReceipts", () => {
  async function issue(ctx: Ctx, payer: string, payee: string, amount: bigint) {
    const r = ctx.paymentReceipts;
    // The cofhe mock's createRandomTask returns a timestamp-derived hash with
    // no ACL grant, so FHE.allowThis on FHE.randomEuint64 only succeeds when
    // that hash happens to carry the trivial-encryption flag. Retry on a new
    // timestamp.
    let rc: any;
    for (let i = 0; i < 32 && !rc; i++) {
      const e1 = await enc(ctx, ctx.owner, amount, await r.getAddress());
      try {
        rc = await (await r.connect(ctx.owner).issueReceipt(payer, payee, ...e1, await ctx.vault.getAddress())).wait();
      } catch {
        await time.increase(1);
      }
    }
    return rc!.logs.map((l: any) => r.interface.parseLog(l)).find((l: any) => l?.name === "ReceiptIssued")!.args[0];
  }

  it("H10: comparisons require the caller to be a party to both receipts", async () => {
    const [owner, alice, bob, charlie] = await hre.ethers.getSigners();
    const client = await hre.cofhe.createClientWithBatteries(owner);
    const ctx = {
      owner, alice, bob, charlie, client,
      paymentReceipts: await deployProxy("PaymentReceipts", []),
      vault: { getAddress: async () => alice.address },
    } as unknown as Ctx;
    const mine = await issue(ctx, ctx.alice.address, ctx.bob.address, 5n);
    const theirs = await issue(ctx, ctx.owner.address, ctx.charlie.address, 77n);
    for (const fn of ["compareReceiptAmounts", "maxReceiptAmount", "minReceiptAmount"]) {
      await expect(ctx.paymentReceipts.connect(ctx.alice)[fn](mine, theirs))
        .to.be.revertedWith("PaymentReceipts: not a party");
      await expect(ctx.paymentReceipts.connect(ctx.alice)[fn](theirs, mine))
        .to.be.revertedWith("PaymentReceipts: not a party");
      await expect(ctx.paymentReceipts.connect(ctx.alice)[fn](mine, mine)).to.not.be.reverted;
    }
  });

  it("H9: live totals are not public; only the daily snapshot is", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    const r = ctx.paymentReceipts;
    await r.publishGlobalSnapshot();
    const snap1 = await r.getGlobalVolumeHandle();
    expect(await r.getSnapshotVolumeHandle()).to.equal(snap1);
    expect(await r.lastSnapshotAt()).to.equal(await time.latest());

    await ctx.paymentHub.connect(ctx.alice).sendPayment(
      ctx.bob.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.alice, usdc(33), hub)), "",
    );
    // Pre-fix the getter moved to a new public handle after every payment.
    expect(await r.getGlobalVolumeHandle()).to.equal(snap1);
    await expect(r.publishGlobalSnapshot()).to.be.revertedWith("PaymentReceipts: snapshot too soon");

    for (let i = 0; i < 4; i++) {
      await ctx.paymentHub.connect(ctx.alice).sendPayment(
        ctx.bob.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.alice, usdc(33), hub)), "",
      );
    }
    await time.increase(24 * 3600);
    await expect(r.publishGlobalSnapshot()).to.emit(r, "GlobalSnapshotPublished");
    const snap2 = await r.getGlobalVolumeHandle();
    expect(await snapshotValues(ctx)).to.deep.equal([usdc(165), 5n]);
    expect(snap2).to.not.equal(snap1);
  });

  // Round 2: a day with a single payment let the snapshot diff reveal it.
  it("the snapshot holds until MIN_SNAPSHOT_TXS new payments landed", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    const r = ctx.paymentReceipts;
    const send = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await ctx.paymentHub.connect(ctx.alice).sendPayment(
          ctx.bob.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.alice, usdc(11), hub)), "",
        );
      }
    };
    expect(await r.MIN_SNAPSHOT_TXS()).to.equal(5n);
    await send(1);
    await r.publishGlobalSnapshot();
    // Pre-fix this decrypted to the single payment's 11 USDC.
    expect(await snapshotValues(ctx)).to.deep.equal([0n, 0n]);
    await send(4);
    await time.increase(24 * 3600);
    await r.publishGlobalSnapshot();
    expect(await snapshotValues(ctx)).to.deep.equal([usdc(55), 5n]);
    await send(1);
    await time.increase(24 * 3600);
    await r.publishGlobalSnapshot();
    expect(await snapshotValues(ctx)).to.deep.equal([usdc(55), 5n]);
  });

  it("H9: the getter stays on the snapshot while payments land", async () => {
    const ctx = await loadFixture(fixture);
    const hub = await ctx.paymentHub.getAddress();
    const r = ctx.paymentReceipts;
    await ctx.paymentHub.connect(ctx.alice).sendPayment(
      ctx.bob.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.alice, usdc(7), hub)), "",
    );
    // No snapshot yet: nothing is public.
    expect(await r.getGlobalVolumeHandle()).to.equal(0n);
    await r.publishGlobalSnapshot();
    const snap = await r.getGlobalVolumeHandle();
    await ctx.paymentHub.connect(ctx.alice).sendPayment(
      ctx.bob.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.alice, usdc(9), hub)), "",
    );
    expect(await r.getGlobalVolumeHandle()).to.equal(snap);
  });
});

describe("PaymentReceipts: repair of the shifted legacy layout", () => {
  // Eth and Base Sepolia proxies hold the global stats one slot lower than
  // the code expects (see repairLegacyLayout). Reproduce that on a fresh
  // proxy by moving real handles down one slot, then repair.
  async function shiftedFixture() {
    const ctx = await fixture();
    const hub = await ctx.paymentHub.getAddress();
    for (let i = 0; i < 5; i++) {
      await ctx.paymentHub.connect(ctx.alice).sendPayment(
        ctx.bob.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.alice, usdc(11), hub)), "",
      );
    }
    const addr = await ctx.paymentReceipts.getAddress();
    const at = (s: number) => hre.ethers.provider.getStorage(addr, s);
    const set = (s: number, v: string) =>
      hre.network.provider.send("hardhat_setStorageAt", [addr, "0x" + s.toString(16), hre.ethers.zeroPadValue(v, 32)]);
    const vol = await at(9);
    const cnt = await at(10);
    await set(8, vol);
    await set(9, cnt);
    await set(10, "0x01");
    await set(11, "0x07"); // legacy proofCount
    await set(12, "0x00");
    return ctx;
  }

  it("reproduces the broken state: a snapshot reverts on the shifted layout", async () => {
    const ctx = await loadFixture(shiftedFixture);
    await expect(ctx.paymentReceipts.publishGlobalSnapshot()).to.be.reverted;
  });

  it("restores the real totals and the proof counter, once, owner only", async () => {
    const ctx = await loadFixture(shiftedFixture);
    const r = ctx.paymentReceipts;
    await expect(r.connect(ctx.alice).repairLegacyLayout()).to.be.revertedWithCustomError(r, "OwnableUnauthorizedAccount");
    await expect(r.repairLegacyLayout()).to.emit(r, "LegacyLayoutRepaired");
    expect(await r.legacyLayoutRepaired()).to.equal(true);
    expect(await r.proofCount()).to.equal(7n);
    await r.publishGlobalSnapshot();
    expect(await snapshotValues(ctx)).to.deep.equal([usdc(55), 5n]);
    await expect(r.repairLegacyLayout()).to.be.revertedWith("PaymentReceipts: already repaired");
  });

  it("refuses to touch a proxy whose layout is not shifted", async () => {
    const ctx = await loadFixture(fixture);
    await expect(ctx.paymentReceipts.repairLegacyLayout()).to.be.revertedWith("PaymentReceipts: layout not shifted");
  });
});
