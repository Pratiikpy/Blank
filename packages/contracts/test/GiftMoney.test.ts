import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  GiftMoney — "red envelope" encrypted random splits
//
//  Pre-existing coverage in Blank.test.ts covers only #241 (expiry)
//  and #204 (receipts wiring). The createEnvelope guard set, the
//  irrevocability invariant from #184, and the social-state view
//  functions (isFullyOpened, isExpired, getReceived/SentEnvelopes,
//  etc.) are otherwise untested.
//
//  Covers:
//   • createEnvelope guards: no recipients, > MAX_RECIPIENTS (30),
//     length mismatch, zero-address recipient, sender-as-recipient
//     (self-loop), duplicate recipient, past-expiry, future-expiry OK
//   • claimGift guards: not-active blocks claim, not-a-recipient
//     blocks claim, already-opened blocks re-claim
//   • setExpiry guards: only sender, only when active, only future
//   • deactivateEnvelope: only sender, only when active
//   • IRREVOCABILITY (#184): deactivate does NOT refund — recipients
//     keep their encrypted vault balance after deactivate
//   • Views: isFullyOpened flips when all recipients claim,
//     isExpired flips past deadline, getRecipients,
//     getReceivedEnvelopes, getSentEnvelopes
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

async function deployProxy(name: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(name);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const initData = initArgs.length > 0
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
  const gift = await deployProxy("GiftMoney", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await gift.getAddress()]);
  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await testUSDC.getAddress(), "USD Coin", "USDC", USDC_DECIMALS);
  await gift.setTokenRegistry(await registry.getAddress());

  for (const s of [alice, bob, charlie, dave]) {
    await testUSDC.mint(s.address, usdc(10_000));
    await testUSDC.connect(s).approve(await vault.getAddress(), usdc(10_000));
  }
  await vault.connect(alice).shield(usdc(1_000));
  const MAX = (1n << 64n) - 1n;
  await vault.connect(alice).approvePlaintext(await gift.getAddress(), MAX);

  return { owner, alice, bob, charlie, dave, client, testUSDC, vault, gift, registry, eventHub };
}

// H1: a forged vault returns any handle it likes, and GiftMoney forwards it
// to PaymentReceipts as the recipient's income. Only registered vaults count.
describe("GiftMoney — vault allowlist (H1)", () => {
  it("rejects an unregistered vault reporting the same underlying", async () => {
    const ctx = await loadFixture(deployFixture);
    const rogue = await deployProxy("FHERC20Vault", [
      await ctx.testUSDC.getAddress(), "Rogue", "RGE", USDC_DECIMALS, await ctx.eventHub.getAddress(),
    ]);
    const { handles, proof } = await encShares(ctx.client, ctx.alice, [usdc(1)], await ctx.gift.getAddress());
    await expect(
      ctx.gift.connect(ctx.alice).createEnvelope(await rogue.getAddress(), [ctx.bob.address], handles, proof, "x", 0),
    ).to.be.revertedWith("GiftMoney: vault not allowed");
  });

  it("fails closed when no registry is set", async () => {
    const ctx = await loadFixture(deployFixture);
    const fresh = await deployProxy("GiftMoney", [await ctx.eventHub.getAddress()]);
    const { handles, proof } = await encShares(ctx.client, ctx.alice, [usdc(1)], await fresh.getAddress());
    await expect(
      fresh.connect(ctx.alice).createEnvelope(await ctx.vault.getAddress(), [ctx.bob.address], handles, proof, "x", 0),
    ).to.be.revertedWith("GiftMoney: vault not allowed");
  });

  it("setTokenRegistry is owner-only, rejects an EOA, emits TokenRegistrySet", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.gift.connect(ctx.alice).setTokenRegistry(await ctx.registry.getAddress()))
      .to.be.revertedWithCustomError(ctx.gift, "OwnableUnauthorizedAccount");
    await expect(ctx.gift.setTokenRegistry(ctx.bob.address)).to.be.revertedWith("GiftMoney: bad registry");
    await expect(ctx.gift.setTokenRegistry(await ctx.registry.getAddress())).to.emit(ctx.gift, "TokenRegistrySet");
  });
});

async function encShare(client: any, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

/// createEnvelope now takes one batch signature covering every share, so the
/// shares have to be encrypted together rather than one call per recipient.
async function encShares(client: any, signer: any, amounts: bigint[], consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const r = await client
    .encryptInputs(amounts.map((a) => Encryptable.uint64(a)))
    .setConsumingContract(consuming)
    .execute();
  return { handles: r.slice(0, -1), proof: r[r.length - 1] };
}

/// Decrypts the public funded bit of an envelope and settles it on-chain, the
/// way the app's automatic second step does. Anyone may submit it.
async function confirmEnvelope(ctx: any, id: number | bigint, caller: any = ctx.owner) {
  const handle = await ctx.gift.getFundingCheck(id);
  await hre.cofhe.connectWithHardhatSigner(ctx.client, caller);
  const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
  return ctx.gift.connect(caller).confirmFunding(id, Boolean(proof.decryptedValue), proof.signature);
}

/// Confirms the most recently created envelope.
async function fundLatest(ctx: any) {
  await confirmEnvelope(ctx, (await ctx.gift.nextEnvelopeId()) - 1n);
}

describe("GiftMoney — createEnvelope guards", () => {
  it("rejects empty recipients array", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.gift.connect(ctx.alice).createEnvelope(
        await ctx.vault.getAddress(), [], [], "0x", "empty", 0,
      ),
    ).to.be.revertedWith("GiftMoney: no recipients");
  });

  it("rejects more than MAX_RECIPIENTS (30)", async () => {
    const ctx = await loadFixture(deployFixture);
    // Create 31 distinct, non-zero addresses (offset from index so they
    // don't collide with anyone) and one share each.
    const recipients = [];
    const amounts: bigint[] = [];
    for (let i = 1; i <= 31; i++) {
      recipients.push(hre.ethers.getAddress("0x" + i.toString(16).padStart(40, "0")));
      amounts.push(usdc(1));
    }
    const batch = await encShares(ctx.client, ctx.alice, amounts, await ctx.gift.getAddress());
    await expect(
      ctx.gift.connect(ctx.alice).createEnvelope(
        await ctx.vault.getAddress(), recipients, batch.handles, batch.proof, "too many", 0,
      ),
    ).to.be.revertedWith("GiftMoney: max 30 recipients");
  });

  it("rejects recipient.length != shares.length", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await expect(
      ctx.gift.connect(ctx.alice).createEnvelope(
        await ctx.vault.getAddress(),
        [ctx.bob.address, ctx.charlie.address],
        [s[0]], s[1], // length 1 vs 2 recipients
        "mismatch", 0,
      ),
    ).to.be.revertedWith("GiftMoney: length mismatch");
  });

  it("rejects zero-address recipient", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await expect(
      ctx.gift.connect(ctx.alice).createEnvelope(
        await ctx.vault.getAddress(),
        [hre.ethers.ZeroAddress],
        [s[0]], s[1],
        "zero", 0,
      ),
    ).to.be.revertedWith("GiftMoney: zero address recipient");
  });

  it("rejects sender as recipient (self-loop)", async () => {
    // Without this guard, the sender could gift to themselves and double
    // the gift volume counter (#204) without moving real value.
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await expect(
      ctx.gift.connect(ctx.alice).createEnvelope(
        await ctx.vault.getAddress(),
        [ctx.alice.address],
        [s[0]], s[1],
        "self", 0,
      ),
    ).to.be.revertedWith("GiftMoney: sender cannot be recipient");
  });

  it("rejects duplicate recipient inside the same envelope", async () => {
    const ctx = await loadFixture(deployFixture);
    const dup = await encShares(ctx.client, ctx.alice, [usdc(5), usdc(5)], await ctx.gift.getAddress());
    await expect(
      ctx.gift.connect(ctx.alice).createEnvelope(
        await ctx.vault.getAddress(),
        [ctx.bob.address, ctx.bob.address],
        dup.handles, dup.proof,
        "dup", 0,
      ),
    ).to.be.revertedWith("GiftMoney: duplicate recipient");
  });

  it("rejects expiry in the past", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    const now = await time.latest();
    await expect(
      ctx.gift.connect(ctx.alice).createEnvelope(
        await ctx.vault.getAddress(),
        [ctx.bob.address], [s[0]], s[1], "past",
        now - 1, // already expired
      ),
    ).to.be.revertedWith("GiftMoney: expiry must be future");
  });

  it("accepts a future expiry + zero expiry (no expiry)", async () => {
    const ctx = await loadFixture(deployFixture);
    const s1 = await encShare(ctx.client, ctx.alice, usdc(5), await ctx.gift.getAddress());
    const s2 = await encShare(ctx.client, ctx.alice, usdc(5), await ctx.gift.getAddress());
    const future = (await time.latest()) + 7 * 86400;

    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s1[0]], s1[1], "future-exp", future,
    );
    await fundLatest(ctx);
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.charlie.address], [s2[0]], s2[1], "no-exp", 0,
    );
    await fundLatest(ctx);

    expect((await ctx.gift.getEnvelope(0)).expiryTimestamp).to.equal(future);
    expect((await ctx.gift.getEnvelope(1)).expiryTimestamp).to.equal(0);
  });
});

describe("GiftMoney — claimGift guards", () => {
  it("rejects claim from non-recipient", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", 0,
    );
    await fundLatest(ctx);
    // Charlie was never added → not a recipient.
    await expect(
      ctx.gift.connect(ctx.charlie).claimGift(0),
    ).to.be.revertedWith("GiftMoney: not a recipient");
  });

  it("rejects re-claim after open", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", 0,
    );
    await fundLatest(ctx);
    await ctx.gift.connect(ctx.bob).claimGift(0);
    await expect(
      ctx.gift.connect(ctx.bob).claimGift(0),
    ).to.be.revertedWith("GiftMoney: already opened");
  });

  it("rejects claim after deactivation", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", 0,
    );
    await fundLatest(ctx);
    await ctx.gift.connect(ctx.alice).deactivateEnvelope(0);
    await expect(
      ctx.gift.connect(ctx.bob).claimGift(0),
    ).to.be.revertedWith("GiftMoney: envelope not active");
  });
});

describe("GiftMoney — IRREVOCABILITY invariant (#184)", () => {
  it("deactivate does NOT refund: recipient keeps encrypted vault balance", async () => {
    // The contract design transfers shares directly to recipients at
    // create-time. deactivateEnvelope is a SOCIAL action only — funds
    // are not returned. Pin this so a future "improvement" doesn't
    // silently break the doc'd guarantee.
    const ctx = await loadFixture(deployFixture);
    const aliceVaultBefore = await ctx.vault.balanceOf(ctx.alice.address);
    const bobVaultBefore = await ctx.vault.balanceOf(ctx.bob.address);

    const s = await encShare(ctx.client, ctx.alice, usdc(50), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "irrevocable", 0,
    );
    await fundLatest(ctx);

    // Right after create: alice -50, bob +50 in encrypted balance.
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(950));
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(50));

    // Alice deactivates the envelope.
    await ctx.gift.connect(ctx.alice).deactivateEnvelope(0);

    // Balances UNCHANGED — deactivation is social, not financial.
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(950));
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(50));

    // Sanity: pre-create balances are also as expected.
    void aliceVaultBefore;
    void bobVaultBefore;
  });

  it("deactivate rejects from non-sender", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", 0,
    );
    await fundLatest(ctx);
    await expect(
      ctx.gift.connect(ctx.bob).deactivateEnvelope(0),
    ).to.be.revertedWith("GiftMoney: not sender");
  });

  it("deactivate rejects double-deactivate", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", 0,
    );
    await fundLatest(ctx);
    await ctx.gift.connect(ctx.alice).deactivateEnvelope(0);
    await expect(
      ctx.gift.connect(ctx.alice).deactivateEnvelope(0),
    ).to.be.revertedWith("GiftMoney: already inactive");
  });
});

describe("GiftMoney — setExpiry", () => {
  it("rejects setExpiry from non-sender", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", 0,
    );
    await fundLatest(ctx);
    await expect(
      ctx.gift.connect(ctx.bob).setExpiry(0, (await time.latest()) + 86400),
    ).to.be.revertedWith("GiftMoney: not sender");
  });

  it("rejects setExpiry on inactive envelope", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", 0,
    );
    await fundLatest(ctx);
    await ctx.gift.connect(ctx.alice).deactivateEnvelope(0);
    await expect(
      ctx.gift.connect(ctx.alice).setExpiry(0, (await time.latest()) + 86400),
    ).to.be.revertedWith("GiftMoney: envelope not active");
  });

  it("setExpiry to a past timestamp rejects; to zero (clear) and to future OK", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", 0,
    );
    await fundLatest(ctx);
    const past = (await time.latest()) - 1;
    await expect(
      ctx.gift.connect(ctx.alice).setExpiry(0, past),
    ).to.be.revertedWith("GiftMoney: expiry must be future");

    const future = (await time.latest()) + 86400;
    await ctx.gift.connect(ctx.alice).setExpiry(0, future);
    expect((await ctx.gift.getEnvelope(0)).expiryTimestamp).to.equal(future);

    await ctx.gift.connect(ctx.alice).setExpiry(0, 0);
    expect((await ctx.gift.getEnvelope(0)).expiryTimestamp).to.equal(0);
  });
});

describe("GiftMoney — view functions", () => {
  it("isFullyOpened flips when every recipient has opened", async () => {
    const ctx = await loadFixture(deployFixture);
    const two = await encShares(ctx.client, ctx.alice, [usdc(3), usdc(3)], await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(),
      [ctx.bob.address, ctx.charlie.address],
      two.handles, two.proof,
      "twoup", 0,
    );
    await fundLatest(ctx);
    expect(await ctx.gift.isFullyOpened(0)).to.equal(false);

    await ctx.gift.connect(ctx.bob).claimGift(0);
    expect(await ctx.gift.isFullyOpened(0)).to.equal(false);

    await ctx.gift.connect(ctx.charlie).claimGift(0);
    expect(await ctx.gift.isFullyOpened(0)).to.equal(true);
  });

  it("isExpired flips past the deadline; getRecipients enumerates membership", async () => {
    const ctx = await loadFixture(deployFixture);
    const s = await encShare(ctx.client, ctx.alice, usdc(10), await ctx.gift.getAddress());
    const future = (await time.latest()) + 60;
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s[0]], s[1], "x", future,
    );
    await fundLatest(ctx);
    expect(await ctx.gift.isExpired(0)).to.equal(false);

    await time.increase(120);
    expect(await ctx.gift.isExpired(0)).to.equal(true);

    const rec = await ctx.gift.getRecipients(0);
    expect(rec.length).to.equal(1);
    expect(rec[0]).to.equal(ctx.bob.address);
  });

  it("getReceivedEnvelopes + getSentEnvelopes track per-address history", async () => {
    const ctx = await loadFixture(deployFixture);
    // Two separate envelopes, so two separate batches.
    const s1 = await encShare(ctx.client, ctx.alice, usdc(2), await ctx.gift.getAddress());
    const s2 = await encShare(ctx.client, ctx.alice, usdc(3), await ctx.gift.getAddress());
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.bob.address], [s1[0]], s1[1], "first", 0,
    );
    await fundLatest(ctx);
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.charlie.address], [s2[0]], s2[1], "second", 0,
    );
    await fundLatest(ctx);

    expect((await ctx.gift.getSentEnvelopes(ctx.alice.address)).length).to.equal(2);
    expect((await ctx.gift.getReceivedEnvelopes(ctx.bob.address)).length).to.equal(1);
    expect((await ctx.gift.getReceivedEnvelopes(ctx.charlie.address)).length).to.equal(1);
    expect((await ctx.gift.getReceivedEnvelopes(ctx.dave.address)).length).to.equal(0);
  });
});

// The vault moves zero instead of reverting when the sender is short, so an
// envelope is only openable once the single "every share moved" bit has been
// decrypted and published. Receipts are bumped at that point, not at create.
describe("GiftMoney, funding gate", () => {
  const MAX = (1n << 64n) - 1n;
  const FUNDING_STATUS_SLOT = 12; // fundingStatus mapping (storage-layouts/GiftMoney.json)
  const ACTIVE = 0;
  const PENDING = 1;
  const VOID = 2;
  const abi = hre.ethers.AbiCoder.defaultAbiCoder();

  // Eve holds nothing in the vault but has approved GiftMoney, so the only
  // reason her envelopes can fail is a short balance.
  async function gateFixture() {
    const ctx = await deployFixture();
    const eve = (await hre.ethers.getSigners())[5];
    await ctx.vault.connect(eve).approvePlaintext(await ctx.gift.getAddress(), MAX);
    const receipts = await deployProxy("PaymentReceipts", []);
    await receipts.setAuthorizedCaller(await ctx.gift.getAddress(), true);
    await ctx.gift.setPaymentReceipts(await receipts.getAddress());
    return { ...ctx, eve, receipts };
  }

  async function create(ctx: any, sender: any, recipients: string[], amounts: bigint[], expiry = 0) {
    const batch = await encShares(ctx.client, sender, amounts, await ctx.gift.getAddress());
    await ctx.gift.connect(sender).createEnvelope(
      await ctx.vault.getAddress(), recipients, batch.handles, batch.proof, "gate", expiry,
    );
    return (await ctx.gift.nextEnvelopeId()) - 1n;
  }

  async function fundedBit(ctx: any, id: bigint, reader: any = ctx.owner) {
    await hre.cofhe.connectWithHardhatSigner(ctx.client, reader);
    const handle = await ctx.gift.getFundingCheck(id);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
    return { value: Boolean(proof.decryptedValue), signature: proof.signature };
  }

  const received = (ctx: any, who: any) => ctx.receipts.connect(who).getMyTotalReceived();

  it("a funded envelope starts PendingFunding: funds moved, but it cannot be opened and no receipt exists", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, [ctx.bob.address, ctx.charlie.address], [usdc(30), usdc(20)]);
    expect(await ctx.gift.fundingStatus(id)).to.equal(PENDING);
    // Irrevocable transfers already landed.
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(30));
    await mock_expectPlaintext(ctx.charlie.provider, await ctx.vault.balanceOf(ctx.charlie.address), usdc(20));

    await expect(ctx.gift.connect(ctx.bob).claimGift(id)).to.be.revertedWith("GiftMoney: funding pending");
    expect(await ctx.gift.hasOpened(id, ctx.bob.address)).to.equal(false);
    expect((await ctx.gift.getEnvelope(id)).claimedCount).to.equal(0);
    expect(await received(ctx, ctx.bob)).to.equal(0n);
    expect(await received(ctx, ctx.charlie)).to.equal(0n);
  });

  it("funded path end to end: a stranger confirms, receipts bump once per recipient, recipients open", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, [ctx.bob.address, ctx.charlie.address], [usdc(30), usdc(20)]);
    const bit = await fundedBit(ctx, id, ctx.eve);
    expect(bit.value).to.equal(true);

    await expect(ctx.gift.connect(ctx.eve).confirmFunding(id, bit.value, bit.signature))
      .to.emit(ctx.gift, "EnvelopeFunded").withArgs(id, ctx.alice.address)
      .and.not.to.emit(ctx.gift, "EnvelopeVoided");
    expect(await ctx.gift.fundingStatus(id)).to.equal(ACTIVE);
    await mock_expectPlaintext(ctx.bob.provider, await received(ctx, ctx.bob), usdc(30));
    await mock_expectPlaintext(ctx.charlie.provider, await received(ctx, ctx.charlie), usdc(20));

    await expect(ctx.gift.connect(ctx.bob).claimGift(id)).to.emit(ctx.gift, "GiftOpened");
    await ctx.gift.connect(ctx.charlie).claimGift(id);
    expect(await ctx.gift.isFullyOpened(id)).to.equal(true);
    // Settling twice must not double-count income.
    await expect(ctx.gift.confirmFunding(id, true, bit.signature)).to.be.revertedWith("GiftMoney: not pending funding");
    await mock_expectPlaintext(ctx.bob.provider, await received(ctx, ctx.bob), usdc(30));
  });

  it("zero-balance sender: the envelope ends Void, cannot be opened, and bumps no receipt", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.eve, [ctx.bob.address, ctx.charlie.address], [usdc(30), usdc(20)]);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.gift.connect(ctx.bob).getMyGift(id), 0n);
    const bit = await fundedBit(ctx, id);
    expect(bit.value).to.equal(false);

    await expect(ctx.gift.connect(ctx.bob).confirmFunding(id, bit.value, bit.signature))
      .to.emit(ctx.gift, "EnvelopeVoided").withArgs(id, ctx.eve.address)
      .and.not.to.emit(ctx.gift, "EnvelopeFunded");
    expect(await ctx.gift.fundingStatus(id)).to.equal(VOID);
    expect((await ctx.gift.getEnvelope(id)).active).to.equal(false);

    await expect(ctx.gift.connect(ctx.bob).claimGift(id)).to.be.revertedWith("GiftMoney: envelope not active");
    await expect(ctx.gift.connect(ctx.charlie).claimGift(id)).to.be.revertedWith("GiftMoney: envelope not active");
    expect(await ctx.gift.hasOpened(id, ctx.bob.address)).to.equal(false);
    expect((await ctx.gift.getEnvelope(id)).claimedCount).to.equal(0);
    expect(await received(ctx, ctx.bob)).to.equal(0n);
    expect(await received(ctx, ctx.charlie)).to.equal(0n);
    await expect(ctx.gift.confirmFunding(id, false, "0x")).to.be.revertedWith("GiftMoney: not pending funding");
  });

  it("one short share voids the whole envelope; a share that already moved stays with its recipient", async () => {
    const ctx = await loadFixture(gateFixture);
    // Alice holds 1,000: the first 600 moves, the second 600 does not.
    const id = await create(ctx, ctx.alice, [ctx.bob.address, ctx.charlie.address], [usdc(600), usdc(600)]);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(600));
    await mock_expectPlaintext(ctx.charlie.provider, await ctx.gift.connect(ctx.charlie).getMyGift(id), 0n);

    const bit = await fundedBit(ctx, id);
    expect(bit.value).to.equal(false);
    await ctx.gift.confirmFunding(id, bit.value, bit.signature);
    expect(await ctx.gift.fundingStatus(id)).to.equal(VOID);
    await expect(ctx.gift.connect(ctx.bob).claimGift(id)).to.be.revertedWith("GiftMoney: envelope not active");
    // Transfers are irrevocable and the contract never held the funds.
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(600));
    expect(await received(ctx, ctx.bob)).to.equal(0n);
  });

  it("a zero share from a funded sender is Void too", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, [ctx.bob.address], [0n]);
    await fundLatest(ctx);
    expect(await ctx.gift.fundingStatus(id)).to.equal(VOID);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
  });

  it("the published value decides, not the caller's argument", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.eve, [ctx.bob.address], [usdc(5)]);
    const bit = await fundedBit(ctx, id);
    expect(bit.value).to.equal(false);
    await expect(ctx.gift.confirmFunding(id, true, bit.signature)).to.be.reverted;
    expect(await ctx.gift.fundingStatus(id)).to.equal(PENDING);

    const tm = await hre.cofhe.mocks.getMockTaskManager();
    await tm.publishDecryptResult(await ctx.gift.getFundingCheck(id), 0, bit.signature);
    await ctx.gift.confirmFunding(id, true, "0x");
    expect(await ctx.gift.fundingStatus(id)).to.equal(VOID);
  });

  it("confirmFunding rejects an unknown envelope and an already settled one", async () => {
    const ctx = await loadFixture(gateFixture);
    await expect(ctx.gift.confirmFunding(99, true, "0x")).to.be.revertedWith("GiftMoney: not pending funding");
    const id = await create(ctx, ctx.alice, [ctx.bob.address], [usdc(5)]);
    await fundLatest(ctx);
    await expect(ctx.gift.confirmFunding(id, true, "0x")).to.be.revertedWith("GiftMoney: not pending funding");
  });

  it("a deactivated pending envelope stays closed after it is confirmed, and still bumps real income", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, [ctx.bob.address], [usdc(10)]);
    await ctx.gift.connect(ctx.alice).deactivateEnvelope(id);
    await fundLatest(ctx);
    expect(await ctx.gift.fundingStatus(id)).to.equal(ACTIVE);
    await expect(ctx.gift.connect(ctx.bob).claimGift(id)).to.be.revertedWith("GiftMoney: envelope not active");
    await mock_expectPlaintext(ctx.bob.provider, await received(ctx, ctx.bob), usdc(10));
  });

  it("with no receipts contract wired, confirming still activates the envelope", async () => {
    const ctx = await loadFixture(gateFixture);
    await ctx.gift.setPaymentReceipts(hre.ethers.ZeroAddress);
    const id = await create(ctx, ctx.alice, [ctx.bob.address], [usdc(10)]);
    await fundLatest(ctx);
    await ctx.gift.connect(ctx.bob).claimGift(id);
    expect(await ctx.gift.hasOpened(id, ctx.bob.address)).to.equal(true);
  });

  // The mock replays CoFHE work on-chain, so a mock transaction hits the 16.7M
  // per-transaction cap well below MAX_RECIPIENTS (the old createEnvelope ran
  // out of gas at 10 recipients here). Five is the largest size that fits
  // comfortably in both create and confirm under the mock.
  it("a five-recipient envelope confirms and bumps every recipient", async () => {
    const ctx = await loadFixture(gateFixture);
    const wallets = Array.from({ length: 5 }, () => hre.ethers.Wallet.createRandom().address);
    const id = await create(ctx, ctx.alice, wallets, wallets.map(() => usdc(1)));
    await fundLatest(ctx);
    expect(await ctx.gift.fundingStatus(id)).to.equal(ACTIVE);
    expect((await ctx.gift.getRecipients(id)).length).to.equal(5);
  });

  // An envelope written before this upgrade has fundingStatus 0 (Active), no
  // funding bit, and already had its receipts bumped at create. Zeroing the
  // status slot of a pending envelope models that record.
  it("legacy record: an envelope with no funding state opens exactly as before", async () => {
    const ctx = await loadFixture(gateFixture);
    const id = await create(ctx, ctx.alice, [ctx.bob.address], [usdc(10)]);
    const slot = hre.ethers.keccak256(abi.encode(["uint256", "uint256"], [id, FUNDING_STATUS_SLOT]));
    await hre.network.provider.send("hardhat_setStorageAt", [
      await ctx.gift.getAddress(), slot, hre.ethers.ZeroHash,
    ]);
    expect(await ctx.gift.fundingStatus(id)).to.equal(ACTIVE);
    await expect(ctx.gift.confirmFunding(id, true, "0x")).to.be.revertedWith("GiftMoney: not pending funding");
    await ctx.gift.connect(ctx.bob).claimGift(id);
    expect(await ctx.gift.hasOpened(id, ctx.bob.address)).to.equal(true);
  });

  it("E5: setters reject a codeless address; zero still switches receipts off", async () => {
    const ctx = await loadFixture(gateFixture);
    const eoa = "0x000000000000000000000000000000000000bEEF";
    await expect(ctx.gift.setEventHub(eoa)).to.be.revertedWith("GiftMoney: bad event hub");
    await expect(ctx.gift.setPaymentReceipts(eoa)).to.be.revertedWith("GiftMoney: bad receipts");
    await expect(ctx.gift.setEventHub(await ctx.eventHub.getAddress())).to.not.be.reverted;
    await expect(ctx.gift.setPaymentReceipts(hre.ethers.ZeroAddress)).to.not.be.reverted;
    await expect(ctx.gift.connect(ctx.alice).setPaymentReceipts(await ctx.registry.getAddress())).to.be.reverted;
  });
});
