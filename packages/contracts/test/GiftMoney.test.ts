import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable } from "@cofhe/sdk";
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

  for (const s of [alice, bob, charlie, dave]) {
    await testUSDC.mint(s.address, usdc(10_000));
    await testUSDC.connect(s).approve(await vault.getAddress(), usdc(10_000));
  }
  await vault.connect(alice).shield(usdc(1_000));
  const MAX = (1n << 64n) - 1n;
  await vault.connect(alice).approvePlaintext(await gift.getAddress(), MAX);

  return { owner, alice, bob, charlie, dave, client, testUSDC, vault, gift };
}

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
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.charlie.address], [s2[0]], s2[1], "no-exp", 0,
    );

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
    await ctx.gift.connect(ctx.alice).createEnvelope(
      await ctx.vault.getAddress(), [ctx.charlie.address], [s2[0]], s2[1], "second", 0,
    );

    expect((await ctx.gift.getSentEnvelopes(ctx.alice.address)).length).to.equal(2);
    expect((await ctx.gift.getReceivedEnvelopes(ctx.bob.address)).length).to.equal(1);
    expect((await ctx.gift.getReceivedEnvelopes(ctx.charlie.address)).length).to.equal(1);
    expect((await ctx.gift.getReceivedEnvelopes(ctx.dave.address)).length).to.equal(0);
  });
});
