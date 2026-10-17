import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";
import layout from "../storage-layouts/BusinessHub.json";

// Pre-mainnet audit regressions for BusinessHub. Each test fails on the
// pre-fix contract. "Legacy" records (created before an upgrade) are
// simulated by clearing the new side-mapping slots with hardhat_setStorageAt.

const usdc = (n: number | string) => parseUnits(String(n), 6);
const DAY = 24 * 3600;
const coder = hre.ethers.AbiCoder.defaultAbiCoder();

function slotOf(label: string): bigint {
  const s = (layout as any).storage.find((x: any) => x.label === label);
  if (!s) throw new Error(`no slot for ${label}`);
  return BigInt(s.slot);
}
function mapSlot(label: string, key: bigint | string, keyType = "uint256"): string {
  return hre.ethers.keccak256(coder.encode([keyType, "uint256"], [key, slotOf(label)]));
}
async function setSlot(addr: string, slot: string | bigint, value: bigint) {
  const s = typeof slot === "bigint" ? hre.ethers.toBeHex(slot) : slot;
  await hre.network.provider.send("hardhat_setStorageAt", [addr, s, hre.ethers.toBeHex(value, 32)]);
}

async function deployProxy(name: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(name);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const initData = initArgs.length
    ? Factory.interface.encodeFunctionData("initialize", initArgs)
    : Factory.interface.encodeFunctionData("initialize");
  const Proxy = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as any;
}

async function fixture() {
  const [owner, alice, bob, charlie] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const token = await TestUSDC.deploy();
  await token.waitForDeployment();
  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await token.getAddress(), "Blank USDC Vault", "bvUSDC", 6, await eventHub.getAddress(),
  ]);
  const hub = await deployProxy("BusinessHub", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await hub.getAddress()]);
  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await token.getAddress(), "Test USDC", "USDC", 6);
  await hub.setTokenRegistry(await registry.getAddress());

  for (const u of [alice, bob, charlie]) {
    await token.mint(u.address, usdc(10_000));
    await token.connect(u).approve(await vault.getAddress(), usdc(10_000));
  }
  const Stub = await hre.ethers.getContractFactory("MockVaultStub");
  const fakeVault = await Stub.deploy(await token.getAddress());
  await fakeVault.waitForDeployment();
  return { owner, alice, bob, charlie, client, token, vault, hub, registry, fakeVault };
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

async function enc(ctx: Ctx, signer: any, amount: bigint) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  return ctx.client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(await ctx.hub.getAddress()).execute();
}
async function decryptBool(ctx: Ctx, handle: string) {
  const p = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
  return { value: Boolean(p.decryptedValue), signature: p.signature };
}
async function fund(ctx: Ctx, signer: any, amount: bigint) {
  await ctx.vault.connect(signer).shield(amount);
  await ctx.vault.connect(signer).approvePlaintext(await ctx.hub.getAddress(), (1n << 64n) - 1n);
}
async function invoice(ctx: Ctx, amount: bigint) {
  await ctx.hub.connect(ctx.alice).createInvoice(
    ctx.bob.address, await ctx.vault.getAddress(), ...(await enc(ctx, ctx.alice, amount)), "job", (await time.latest()) + 30 * DAY,
  );
  return (await ctx.hub.nextInvoiceId()) - 1n;
}
async function escrow(ctx: Ctx, amount: bigint, arbiter = hre.ethers.ZeroAddress) {
  await ctx.token.connect(ctx.alice).approve(await ctx.hub.getAddress(), amount);
  await ctx.hub.connect(ctx.alice).createEscrow(
    ctx.bob.address, await ctx.vault.getAddress(), amount, "work", arbiter, (await time.latest()) + 7 * DAY,
  );
  return (await ctx.hub.nextEscrowId()) - 1n;
}

describe("BusinessHub audit: retired plaintext pay paths (C2, H8)", () => {
  it("payInvoiceWithSwap and payInvoiceWithOracleQuote revert", async () => {
    const ctx = await loadFixture(fixture);
    const id = await invoice(ctx, usdc(100));
    const e = await enc(ctx, ctx.bob, usdc(100));
    const t = await ctx.token.getAddress();
    await expect(ctx.hub.connect(ctx.bob).payInvoiceWithSwap(id, t, 1, 1, 3000, t, ...e))
      .to.be.revertedWith("BusinessHub: retired");
    await expect(
      ctx.hub.connect(ctx.bob).payInvoiceWithOracleQuote(id, t, 1, 1, 1, 0, hre.ethers.ZeroHash, "0x", ...e),
    ).to.be.revertedWith("BusinessHub: retired");
    expect((await ctx.hub.getInvoice(id)).status).to.equal(0);
  });
});

describe("BusinessHub audit: vault allowlist (C3, H3)", () => {
  it("fails closed when no registry is set", async () => {
    const ctx = await loadFixture(fixture);
    const bare = await deployProxy("BusinessHub", [hre.ethers.ZeroAddress]);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const e = await ctx.client.encryptInputs([Encryptable.uint64(1n)]).setConsumingContract(await bare.getAddress()).execute();
    await expect(
      bare.connect(ctx.alice).createInvoice(ctx.bob.address, await ctx.vault.getAddress(), ...e, "x", 0),
    ).to.be.revertedWith("BusinessHub: vault not allowed");
  });

  it("setTokenRegistry is owner-only and rejects non-contracts", async () => {
    const ctx = await loadFixture(fixture);
    await expect(ctx.hub.connect(ctx.alice).setTokenRegistry(await ctx.registry.getAddress()))
      .to.be.revertedWithCustomError(ctx.hub, "OwnableUnauthorizedAccount");
    await expect(ctx.hub.setTokenRegistry(ctx.alice.address)).to.be.revertedWith("BusinessHub: bad registry");
    await expect(ctx.hub.setTokenRegistry(await ctx.registry.getAddress()))
      .to.emit(ctx.hub, "TokenRegistrySet").withArgs(await ctx.registry.getAddress());
  });

  it("createEscrow, createInvoice and runPayroll reject an unregistered vault", async () => {
    const ctx = await loadFixture(fixture);
    const fake = await ctx.fakeVault.getAddress();
    await ctx.token.connect(ctx.alice).approve(await ctx.hub.getAddress(), usdc(1));
    await expect(
      ctx.hub.connect(ctx.alice).createEscrow(ctx.bob.address, fake, usdc(1), "x", hre.ethers.ZeroAddress, (await time.latest()) + 2 * DAY),
    ).to.be.revertedWith("BusinessHub: vault not allowed");
    await expect(
      ctx.hub.connect(ctx.alice).createInvoice(ctx.bob.address, fake, ...(await enc(ctx, ctx.alice, 1n)), "x", 0),
    ).to.be.revertedWith("BusinessHub: vault not allowed");
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const r = await ctx.client.encryptInputs([Encryptable.uint64(1n)]).setConsumingContract(await ctx.hub.getAddress()).execute();
    await expect(
      ctx.hub.connect(ctx.alice).runPayroll([ctx.bob.address], fake, r.slice(0, -1), r[r.length - 1]),
    ).to.be.revertedWith("BusinessHub: vault not allowed");
  });

  it("escrow stores the registry token; a legacy escrow without one resolves through the registry", async () => {
    const ctx = await loadFixture(fixture);
    const id = await escrow(ctx, usdc(50));
    expect(await ctx.hub.escrowToken(id)).to.equal(await ctx.token.getAddress());

    // Simulate a pre-upgrade escrow: no stored token.
    await setSlot(await ctx.hub.getAddress(), mapSlot("escrowToken", id), 0n);
    await ctx.registry.deactivateToken(await ctx.vault.getAddress());
    await ctx.hub.connect(ctx.alice).approveRelease(id);
    await expect(ctx.hub.connect(ctx.bob).markDelivered(id)).to.be.revertedWith("BusinessHub: vault not allowed");

    await ctx.registry.reactivateToken(await ctx.vault.getAddress());
    const before = await ctx.token.balanceOf(ctx.bob.address);
    await ctx.hub.connect(ctx.bob).markDelivered(id);
    expect((await ctx.token.balanceOf(ctx.bob.address)) - before).to.equal(usdc(50));
    expect(await ctx.hub.escrowLiabilities(await ctx.token.getAddress())).to.equal(0n);
  });
});

describe("BusinessHub audit: moved amount, not requested amount (C5, C2)", () => {
  it("payInvoice with a short balance moves 0 and cannot be marked Paid", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.bob, usdc(10));
    const id = await invoice(ctx, usdc(100));
    await ctx.hub.connect(ctx.bob).payInvoice(id, ...(await enc(ctx, ctx.bob, usdc(100))));

    const v = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));
    expect(v.value).to.equal(false); // old code compared the request: true
    await ctx.hub.connect(ctx.bob).payInvoiceFinalize(id, v.value, v.signature);
    expect((await ctx.hub.getInvoice(id)).status).to.equal(4); // Disputed, not Paid
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(10));
  });

  it("payInvoiceEscrow with a short balance holds 0 and refunds instead of paying", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.bob, usdc(10));
    const id = await invoice(ctx, usdc(100));
    await ctx.hub.connect(ctx.bob).payInvoiceEscrow(id, ...(await enc(ctx, ctx.bob, usdc(100))));
    const v = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));
    expect(v.value).to.equal(false);
    await ctx.hub.connect(ctx.bob).releaseInvoiceEscrow(id, v.value, v.signature);
    expect((await ctx.hub.getInvoice(id)).status).to.equal(2); // Cancelled
  });
});

describe("BusinessHub audit: payment mode per invoice (C4) and client check (H6)", () => {
  it("an escrowed payment cannot be finalized through payInvoiceFinalize", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.bob, usdc(500));
    const id = await invoice(ctx, usdc(100));
    await ctx.hub.connect(ctx.bob).payInvoiceEscrow(id, ...(await enc(ctx, ctx.bob, usdc(100))));
    expect(await ctx.hub.invoicePaymentMode(id)).to.equal(2);
    const v = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));
    await expect(ctx.hub.connect(ctx.bob).payInvoiceFinalize(id, v.value, v.signature))
      .to.be.revertedWith("BusinessHub: escrow payment, use releaseInvoiceEscrow");
  });

  it("a direct payment cannot be released through releaseInvoiceEscrow", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.bob, usdc(500));
    const id = await invoice(ctx, usdc(100));
    await ctx.hub.connect(ctx.bob).payInvoice(id, ...(await enc(ctx, ctx.bob, usdc(100))));
    expect(await ctx.hub.invoicePaymentMode(id)).to.equal(1);
    const v = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));
    await expect(ctx.hub.connect(ctx.bob).releaseInvoiceEscrow(id, v.value, v.signature))
      .to.be.revertedWith("BusinessHub: not an escrow payment");
  });

  it("payInvoiceEscrow rejects anyone but the named client", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.charlie, usdc(500));
    const id = await invoice(ctx, usdc(100));
    await expect(ctx.hub.connect(ctx.charlie).payInvoiceEscrow(id, ...(await enc(ctx, ctx.charlie, usdc(100)))))
      .to.be.revertedWith("BusinessHub: not the client");
    expect(await ctx.hub.invoicePaymentStartedBy(id)).to.equal(hre.ethers.ZeroAddress);
  });

  it("a legacy direct payment can only be finalized by the vendor", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.bob, usdc(500));
    const id = await invoice(ctx, usdc(100));
    await ctx.hub.connect(ctx.bob).payInvoice(id, ...(await enc(ctx, ctx.bob, usdc(100))));
    await setSlot(await ctx.hub.getAddress(), mapSlot("invoicePaymentMode", id), 0n);

    const v = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));
    await expect(ctx.hub.connect(ctx.bob).payInvoiceFinalize(id, v.value, v.signature))
      .to.be.revertedWith("BusinessHub: legacy payment, vendor must finalize");
    await ctx.hub.connect(ctx.alice).payInvoiceFinalize(id, v.value, v.signature);
    expect((await ctx.hub.getInvoice(id)).status).to.equal(1);
  });

  it("a legacy escrowed payment must be revalidated on the held amount before release", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.bob, usdc(500));
    const id = await invoice(ctx, usdc(100));
    await ctx.hub.connect(ctx.bob).payInvoiceEscrow(id, ...(await enc(ctx, ctx.bob, usdc(100))));
    await setSlot(await ctx.hub.getAddress(), mapSlot("invoicePaymentMode", id), 0n);

    const old = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));
    await expect(ctx.hub.connect(ctx.bob).releaseInvoiceEscrow(id, old.value, old.signature))
      .to.be.revertedWith("BusinessHub: not an escrow payment");
    await expect(ctx.hub.connect(ctx.alice).payInvoiceFinalize(id, old.value, old.signature))
      .to.be.revertedWith("BusinessHub: escrow payment, use releaseInvoiceEscrow");

    await expect(ctx.hub.connect(ctx.charlie).revalidateLegacyInvoiceEscrow(id))
      .to.emit(ctx.hub, "InvoiceEscrowRevalidated");
    const v = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));
    expect(v.value).to.equal(true);
    await ctx.hub.connect(ctx.bob).releaseInvoiceEscrow(id, v.value, v.signature);
    expect((await ctx.hub.getInvoice(id)).status).to.equal(1);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(100));
  });
});

describe("BusinessHub audit: escrowed invoice release timeout (M4)", () => {
  it("vendor can release a funded escrow after 7 days if the client stays silent", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.bob, usdc(500));
    const id = await invoice(ctx, usdc(100));
    await ctx.hub.connect(ctx.bob).payInvoiceEscrow(id, ...(await enc(ctx, ctx.bob, usdc(100))));
    const v = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));

    await expect(ctx.hub.connect(ctx.alice).releaseInvoiceEscrow(id, v.value, v.signature))
      .to.be.revertedWith("BusinessHub: only client can finalize");
    await time.increase(7 * DAY);
    await ctx.hub.connect(ctx.alice).releaseInvoiceEscrow(id, v.value, v.signature);
    expect((await ctx.hub.getInvoice(id)).status).to.equal(1);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(100));
  });
});

describe("BusinessHub audit: disputed invoice refund (M3)", () => {
  it("a refund that moves nothing leaves the invoice Disputed; a real refund returns what was paid", async () => {
    const ctx = await loadFixture(fixture);
    await fund(ctx, ctx.bob, usdc(500));
    const id = await invoice(ctx, usdc(100));
    await ctx.hub.connect(ctx.bob).payInvoice(id, ...(await enc(ctx, ctx.bob, usdc(80))));
    const v = await decryptBool(ctx, await ctx.hub.getInvoiceValidationHandle(id));
    await ctx.hub.connect(ctx.bob).payInvoiceFinalize(id, v.value, v.signature);
    expect((await ctx.hub.getInvoice(id)).status).to.equal(4);

    // Vendor has granted no allowance, so the vault moves 0.
    await ctx.hub.connect(ctx.alice).refundDisputedInvoice(id);
    let r = await decryptBool(ctx, await ctx.hub.getInvoiceRefundCheckHandle(id));
    expect(r.value).to.equal(false);
    await expect(ctx.hub.connect(ctx.charlie).finalizeDisputedRefund(id, r.value, r.signature))
      .to.emit(ctx.hub, "InvoiceRefundFailed");
    expect((await ctx.hub.getInvoice(id)).status).to.equal(4); // old code: Cancelled with nothing refunded

    await ctx.vault.connect(ctx.alice).approvePlaintext(await ctx.hub.getAddress(), (1n << 64n) - 1n);
    await ctx.hub.connect(ctx.alice).refundDisputedInvoice(id);
    r = await decryptBool(ctx, await ctx.hub.getInvoiceRefundCheckHandle(id));
    expect(r.value).to.equal(true);
    await ctx.hub.connect(ctx.charlie).finalizeDisputedRefund(id, r.value, r.signature);
    expect((await ctx.hub.getInvoice(id)).status).to.equal(2);
    // Refund is the 80 paid, not the 100 invoiced.
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(500));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), 0n);
  });

  it("finalizeDisputedRefund requires a pending refund", async () => {
    const ctx = await loadFixture(fixture);
    const id = await invoice(ctx, usdc(1));
    await expect(ctx.hub.finalizeDisputedRefund(id, true, "0x")).to.be.revertedWith("BusinessHub: not disputed");
  });
});

describe("BusinessHub audit: escrow liabilities (H7)", () => {
  it("owner cannot withdraw escrowed tokens, only free balance", async () => {
    const ctx = await loadFixture(fixture);
    const t = await ctx.token.getAddress();
    await escrow(ctx, usdc(50));
    await ctx.token.mint(await ctx.hub.getAddress(), usdc(5));
    expect(await ctx.hub.escrowLiabilities(t)).to.equal(usdc(50));

    await expect(ctx.hub.withdrawAccumulated(t, ctx.owner.address, usdc(55)))
      .to.be.revertedWith("BusinessHub: amount exceeds free balance");
    await ctx.hub.withdrawAccumulated(t, ctx.owner.address, usdc(5));
    expect(await ctx.token.balanceOf(await ctx.hub.getAddress())).to.equal(usdc(50));
    await expect(ctx.hub.connect(ctx.alice).withdrawAccumulated(t, ctx.alice.address, 1n))
      .to.be.revertedWithCustomError(ctx.hub, "OwnableUnauthorizedAccount");
    await expect(ctx.hub.withdrawAccumulated(hre.ethers.ZeroAddress, ctx.owner.address, 1n))
      .to.be.revertedWith("BusinessHub: zero token");
    await expect(ctx.hub.withdrawAccumulated(t, hre.ethers.ZeroAddress, 1n))
      .to.be.revertedWith("BusinessHub: zero recipient");
  });

  it("legacy escrows must be accounted before any withdrawal", async () => {
    const ctx = await loadFixture(fixture);
    const hubAddr = await ctx.hub.getAddress();
    const t = await ctx.token.getAddress();
    const id = await escrow(ctx, usdc(50));
    // Simulate pre-upgrade state: uncounted, no liability, cursor at 0.
    await setSlot(hubAddr, mapSlot("_escrowLiabilityCounted", id), 0n);
    await setSlot(hubAddr, mapSlot("escrowLiabilities", t, "address"), 0n);
    await setSlot(hubAddr, slotOf("escrowAccountingCursor"), 0n);

    await expect(ctx.hub.withdrawAccumulated(t, ctx.owner.address, usdc(50)))
      .to.be.revertedWith("BusinessHub: account legacy escrows first");
    await ctx.hub.connect(ctx.charlie).accountLegacyEscrows(10);
    expect(await ctx.hub.escrowAccountingCursor()).to.equal(1n);
    expect(await ctx.hub.escrowLiabilities(t)).to.equal(usdc(50));
    await expect(ctx.hub.withdrawAccumulated(t, ctx.owner.address, 1n))
      .to.be.revertedWith("BusinessHub: amount exceeds free balance");

    await ctx.hub.connect(ctx.alice).approveRelease(id);
    await ctx.hub.connect(ctx.bob).markDelivered(id);
    expect(await ctx.hub.escrowLiabilities(t)).to.equal(0n);
  });
});

describe("BusinessHub audit: escrow disputes (M2)", () => {
  it("arbiter must be a third party", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.token.connect(ctx.alice).approve(await ctx.hub.getAddress(), usdc(10));
    for (const arb of [ctx.alice.address, ctx.bob.address]) {
      await expect(
        ctx.hub.connect(ctx.alice).createEscrow(ctx.bob.address, await ctx.vault.getAddress(), usdc(10), "x", arb, (await time.latest()) + 2 * DAY),
      ).to.be.revertedWith("BusinessHub: arbiter must be a third party");
    }
  });

  it("no-arbiter escrows cannot be disputed (would lock funds forever)", async () => {
    const ctx = await loadFixture(fixture);
    const id = await escrow(ctx, usdc(10));
    await expect(ctx.hub.connect(ctx.bob).disputeEscrow(id)).to.be.revertedWith("BusinessHub: no arbiter configured");
    await time.increase(8 * DAY);
    await ctx.hub.claimExpiredEscrow(id);
    expect((await ctx.hub.getEscrow(id)).status).to.equal(3);
  });

  it("an undecided dispute returns funds to the depositor after 30 days", async () => {
    const ctx = await loadFixture(fixture);
    const id = await escrow(ctx, usdc(20), ctx.charlie.address);
    await ctx.hub.connect(ctx.bob).disputeEscrow(id);
    await expect(ctx.hub.claimDisputeTimeout(id)).to.be.revertedWith("BusinessHub: dispute not timed out");

    await time.increase(30 * DAY);
    const before = await ctx.token.balanceOf(ctx.alice.address);
    await expect(ctx.hub.connect(ctx.bob).claimDisputeTimeout(id)).to.emit(ctx.hub, "EscrowDisputeTimedOut");
    expect((await ctx.token.balanceOf(ctx.alice.address)) - before).to.equal(usdc(20));
    await expect(ctx.hub.connect(ctx.charlie).arbiterDecide(id, true)).to.be.revertedWith("BusinessHub: not disputed");
  });

  it("the arbiter can still decide within the window", async () => {
    const ctx = await loadFixture(fixture);
    const id = await escrow(ctx, usdc(20), ctx.charlie.address);
    await ctx.hub.connect(ctx.alice).disputeEscrow(id);
    const before = await ctx.token.balanceOf(ctx.bob.address);
    await ctx.hub.connect(ctx.charlie).arbiterDecide(id, true);
    expect((await ctx.token.balanceOf(ctx.bob.address)) - before).to.equal(usdc(20));
    expect(await ctx.hub.escrowLiabilities(await ctx.token.getAddress())).to.equal(0n);
  });
});
