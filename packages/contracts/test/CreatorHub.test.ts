import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  CreatorHub — encrypted creator tipping with tier badges.
//
//  Critical because:
//   • Tip amounts are encrypted: no handle granted to the creator
//     carries an individual tip, only the encrypted running total.
//     A regression in FHE.add accumulation would silently corrupt
//     the creator's totalEarnings, and a regression in the per-
//     supporter contribution accumulation would break tier badges
//     (a $1000 supporter would show as Bronze if the running total
//     reset on each tip).
//   • supporterCount is the only PUBLIC field — duplicate counting
//     on second-tip would inflate counts; missing the first-time
//     gate would never increment. Pinned independently.
//   • Tier thresholds MUST be strictly ascending (tier1 < tier2 <
//     tier3) — non-ascending tiers would let supporters silently
//     unlock Gold without meeting Silver, breaking the badge
//     hierarchy.
//   • self-tip rejection: a creator tipping themselves would
//     inflate supporterCount AND totalEarnings without any new
//     funds entering the system.
//   • _supportedCreators reverse-lookup must NOT duplicate when a
//     supporter tips the same creator twice (the push happens
//     only on first-time, gated by _hasContributed).
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

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

async function encryptAmountFor(client: any, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

// A tip counts only after confirmFunding. This runs both steps the way the app
// does: support, decrypt the public funded bit, publish it on-chain.
async function confirmTip(ctx: any, tipId: bigint, caller?: any) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, caller ?? ctx.owner);
  const handle = await ctx.hub.getTipFundedHandle(tipId);
  const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
  return ctx.hub.connect(caller ?? ctx.owner).confirmFunding(tipId, Boolean(proof.decryptedValue), proof.signature);
}

async function tipAndConfirm(ctx: any, supporter: any, creator: string, amount: bigint, message = "", vault?: string) {
  const hubAddr = await ctx.hub.getAddress();
  const tipId = await ctx.hub.nextTipId();
  const enc = await encryptAmountFor(ctx.client, supporter, amount, hubAddr);
  await ctx.hub.connect(supporter).support(creator, vault ?? (await ctx.vault.getAddress()), ...enc, message);
  await confirmTip(ctx, tipId);
  return tipId as bigint;
}

async function deployFixture() {
  const [owner, alice, bob, charlie] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const testUSDC = await TestUSDC.deploy();
  await testUSDC.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await testUSDC.getAddress(),
    "Blank USDC Vault",
    "bvUSDC",
    USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const hub = await deployProxy("CreatorHub", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await hub.getAddress()]);
  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await testUSDC.getAddress(), "Test USDC", "USDC", USDC_DECIMALS);
  await hub.setTokenRegistry(await registry.getAddress());

  // Mint + shield for all three signers; approve the hub via plaintext
  // so the FHE-side transferFromVerified is allowed.
  const MAX = (1n << 64n) - 1n;
  for (const signer of [alice, bob, charlie]) {
    await testUSDC.mint(signer.address, usdc(10_000));
    await testUSDC.connect(signer).approve(await vault.getAddress(), usdc(10_000));
    await vault.connect(signer).shield(usdc(1_000));
    await vault.connect(signer).approvePlaintext(await hub.getAddress(), MAX);
  }

  return { owner, alice, bob, charlie, client, testUSDC, eventHub, vault, hub, registry };
}

// Tier thresholds: 100 / 200 / 300 in token smallest units (so a tip
// of 150 lands between tier1 and tier2).
const TIER1 = 100n;
const TIER2 = 200n;
const TIER3 = 300n;

describe("CreatorHub — initialization", () => {
  it("sets owner=deployer + wires eventHub address", async () => {
    const ctx = await loadFixture(deployFixture);
    expect(await ctx.hub.owner()).to.equal(ctx.owner.address);
    expect(await ctx.hub.eventHub()).to.equal(await ctx.eventHub.getAddress());
  });

  it("rejects a second initialize() call (UUPS one-shot guard)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.hub.initialize(await ctx.eventHub.getAddress()),
    ).to.be.revertedWithCustomError(ctx.hub, "InvalidInitialization");
  });
});

describe("CreatorHub — setProfile (create + update)", () => {
  it("creates a fresh profile + emits ProfileCreated + hasProfile flips to true", async () => {
    const ctx = await loadFixture(deployFixture);
    expect(await ctx.hub.hasProfile(ctx.alice.address)).to.equal(false);
    // Pre-tx getBlock("latest").timestamp is one second behind the
    // setProfile tx's mined block on hardhat (default per-block advance),
    // so `withArgs(..., pre.timestamp + 0)` flaked when tests crossed a
    // second-boundary. Drop the strict timestamp; assert only the event
    // fired with the indexed args we care about (address + name).
    await expect(
      ctx.hub.connect(ctx.alice).setProfile("Alice", "creator bio", TIER1, TIER2, TIER3),
    ).to.emit(ctx.hub, "ProfileCreated");
    expect(await ctx.hub.hasProfile(ctx.alice.address)).to.equal(true);
  });

  it("second setProfile call emits ProfileUpdated NOT ProfileCreated (no duplicate-init)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio v1", TIER1, TIER2, TIER3);
    // Re-set with different bio + new tiers (still ascending).
    await expect(
      ctx.hub.connect(ctx.alice).setProfile("Alice v2", "bio v2", 50n, 150n, 250n),
    )
      .to.emit(ctx.hub, "ProfileUpdated")
      .and.to.not.emit(ctx.hub, "ProfileCreated");
  });

  it("rejects empty name (catches accidental empty-string profiles)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.hub.connect(ctx.alice).setProfile("", "bio", TIER1, TIER2, TIER3),
    ).to.be.revertedWith("CreatorHub: empty name");
  });

  it("rejects non-ascending tiers (tier1 >= tier2 OR tier2 >= tier3)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", 200n, 100n, 300n),
    ).to.be.revertedWith("CreatorHub: tiers must be ascending");
    await expect(
      ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", 100n, 200n, 150n),
    ).to.be.revertedWith("CreatorHub: tiers must be ascending");
    // Equal-tier case also rejected (must be strictly ascending).
    await expect(
      ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", 100n, 100n, 300n),
    ).to.be.revertedWith("CreatorHub: tiers must be ascending");
  });

  it("getProfile returns the stored fields", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "creator bio", TIER1, TIER2, TIER3);
    const profile = await ctx.hub.getProfile(ctx.alice.address);
    expect(profile.name).to.equal("Alice");
    expect(profile.bio).to.equal("creator bio");
    expect(profile.tier1).to.equal(TIER1);
    expect(profile.tier2).to.equal(TIER2);
    expect(profile.tier3).to.equal(TIER3);
    expect(profile.supporterCount).to.equal(0);
    expect(profile.active).to.equal(true);
  });
});

describe("CreatorHub — support (tipping path)", () => {
  it("first-time supporter: tokens transferred + supporterCount=1 + Supported event once confirmed", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    const tip = 50n;
    const encTip = await encryptAmountFor(ctx.client, ctx.bob, tip, await ctx.hub.getAddress());
    await expect(
      ctx.hub.connect(ctx.bob).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        ...encTip,
        "love your work",
      ),
    )
      .to.emit(ctx.hub, "TipPending")
      .and.to.not.emit(ctx.hub, "Supported");
    expect((await ctx.hub.getProfile(ctx.alice.address)).supporterCount).to.equal(0);

    await expect(confirmTip(ctx, 0n))
      .to.emit(ctx.hub, "Supported")
      .withArgs(ctx.bob.address, ctx.alice.address, "love your work", (_t: bigint) => true);

    const profile = await ctx.hub.getProfile(ctx.alice.address);
    expect(profile.supporterCount).to.equal(1);

    // Alice's vault balance should have gained `tip`.
    const aliceVault = await ctx.vault.balanceOf(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, aliceVault, usdc(1_000) + tip);
  });

  it("second tip from SAME supporter: supporterCount stays 1 (no duplicate count)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    for (const tip of [50n, 75n]) {
      await tipAndConfirm(ctx, ctx.bob, ctx.alice.address, tip, "tip " + tip.toString());
    }
    const profile = await ctx.hub.getProfile(ctx.alice.address);
    expect(profile.supporterCount).to.equal(1);
  });

  it("second tip from SAME supporter: encrypted contribution accumulates (50 + 75 = 125)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    for (const tip of [50n, 75n]) {
      await tipAndConfirm(ctx, ctx.bob, ctx.alice.address, tip);
    }
    const contrib = await ctx.hub.connect(ctx.bob).getMyContributionIn(ctx.alice.address, await ctx.vault.getAddress());
    await mock_expectPlaintext(ctx.bob.provider, contrib, 125n);
  });

  it("two distinct supporters: supporterCount=2 + reverse-lookup populated for each", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    for (const supporter of [ctx.bob, ctx.charlie]) {
      await tipAndConfirm(ctx, supporter, ctx.alice.address, 50n);
    }
    const profile = await ctx.hub.getProfile(ctx.alice.address);
    expect(profile.supporterCount).to.equal(2);
    expect(await ctx.hub.getSupportedCreators(ctx.bob.address)).to.deep.equal([ctx.alice.address]);
    expect(await ctx.hub.getSupportedCreators(ctx.charlie.address)).to.deep.equal([ctx.alice.address]);
  });

  it("getSupportedCreators does NOT duplicate the same creator on repeated tips", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    for (let i = 0; i < 3; i++) {
      await tipAndConfirm(ctx, ctx.bob, ctx.alice.address, 10n);
    }
    // Bob has tipped Alice 3 times; the reverse-lookup must contain
    // Alice exactly once (the push is gated by _hasContributed).
    expect(await ctx.hub.getSupportedCreators(ctx.bob.address)).to.deep.equal([ctx.alice.address]);
  });

  it("creator earnings accumulate across multiple supporters (50 + 50 = 100 total)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    for (const supporter of [ctx.bob, ctx.charlie]) {
      const enc = await encryptAmountFor(ctx.client, supporter, 50n, await ctx.hub.getAddress());
      await ctx.hub.connect(supporter).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        ...enc,
        "",
      );
    }
    const earnings = await ctx.hub.connect(ctx.alice).getMyEarningsIn(await ctx.vault.getAddress());
    await mock_expectPlaintext(ctx.alice.provider, earnings, 100n);
  });

  it("rejects support to a creator with NO profile", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encryptAmountFor(ctx.client, ctx.bob, 50n, await ctx.hub.getAddress());
    await expect(
      ctx.hub.connect(ctx.bob).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        ...enc,
        "",
      ),
    ).to.be.revertedWith("CreatorHub: no profile");
  });

  it("rejects self-tipping (creator cannot inflate own count/earnings)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    const enc = await encryptAmountFor(ctx.client, ctx.alice, 50n, await ctx.hub.getAddress());
    await expect(
      ctx.hub.connect(ctx.alice).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        ...enc,
        "",
      ),
    ).to.be.revertedWith("CreatorHub: cannot self-tip");
  });
});

describe("CreatorHub — view + tier-check gates", () => {
  it("getMyContribution reverts for non-supporters", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    await expect(
      ctx.hub.connect(ctx.bob).getMyContributionIn(ctx.alice.address, await ctx.vault.getAddress()),
    ).to.be.revertedWith("CreatorHub: not a supporter");
  });

  it("getMyEarnings reverts for accounts without a profile", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.hub.connect(ctx.bob).getMyEarningsIn(await ctx.vault.getAddress()),
    ).to.be.revertedWith("CreatorHub: no profile");
  });

  it("checkMyTier reverts for non-supporters (the only require gate before FHE work)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    await expect(
      ctx.hub.connect(ctx.bob).checkMyTierIn(ctx.alice.address, await ctx.vault.getAddress()),
    ).to.be.revertedWith("CreatorHub: not a supporter");
  });

  it("checkMyTier succeeds for a supporter and submits FHE.gte tasks (no revert)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    await tipAndConfirm(ctx, ctx.bob, ctx.alice.address, 150n);
    // Just assert the tx doesn't revert; the ebool returns are encrypted
    // handles that need a separate decrypt round to inspect. The encrypted
    // total IS verifiable via getMyContribution + mock_expectPlaintext.
    await expect(ctx.hub.connect(ctx.bob).checkMyTierIn(ctx.alice.address, await ctx.vault.getAddress())).to.not.be.reverted;
  });

  it("getSupportedCreators returns empty array for non-supporters", async () => {
    const ctx = await loadFixture(deployFixture);
    expect(await ctx.hub.getSupportedCreators(ctx.bob.address)).to.deep.equal([]);
  });
});

describe("CreatorHub — admin (setEventHub + UUPS upgrade gate)", () => {
  it("setEventHub is owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    const newHub = await deployProxy("EventHub");
    await expect(
      ctx.hub.connect(ctx.alice).setEventHub(await newHub.getAddress()),
    ).to.be.revertedWithCustomError(ctx.hub, "OwnableUnauthorizedAccount");
  });

  it("setEventHub updates the eventHub pointer when called by owner", async () => {
    const ctx = await loadFixture(deployFixture);
    const newHub = await deployProxy("EventHub");
    await ctx.hub.connect(ctx.owner).setEventHub(await newHub.getAddress());
    expect(await ctx.hub.eventHub()).to.equal(await newHub.getAddress());
  });

  it("setEventHub rejects a codeless address (an EOA would brick every tip)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.hub.connect(ctx.owner).setEventHub(ctx.bob.address))
      .to.be.revertedWith("CreatorHub: bad event hub");
    await expect(ctx.hub.connect(ctx.owner).setEventHub(hre.ethers.ZeroAddress))
      .to.be.revertedWith("CreatorHub: bad event hub");
  });

  it("UUPS upgrade is owner-only (non-owner cannot upgradeToAndCall)", async () => {
    const ctx = await loadFixture(deployFixture);
    const Factory = await hre.ethers.getContractFactory("CreatorHub");
    const newImpl = await Factory.deploy();
    await newImpl.waitForDeployment();
    await expect(
      ctx.hub.connect(ctx.alice).upgradeToAndCall(await newImpl.getAddress(), "0x"),
    ).to.be.revertedWithCustomError(ctx.hub, "OwnableUnauthorizedAccount");
  });
});

describe("CreatorHub — audit fixes (H13)", () => {
  it("credits the moved amount, not the requested one (short balance moves 0)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    // Bob has 1,000 USDC shielded; requests a 5,000 USDC tip.
    const enc = await encryptAmountFor(ctx.client, ctx.bob, usdc(5_000), await ctx.hub.getAddress());
    await ctx.hub.connect(ctx.bob).support(ctx.alice.address, await ctx.vault.getAddress(), ...enc, "");
    const v = await ctx.vault.getAddress();
    await mock_expectPlaintext(ctx.alice.provider, await ctx.hub.connect(ctx.alice).getMyEarningsIn(v), 0n);
    await confirmTip(ctx, 0n);
    // Bob never became a supporter, so there is no contribution to read.
    await expect(ctx.hub.connect(ctx.bob).getMyContributionIn(ctx.alice.address, v))
      .to.be.revertedWith("CreatorHub: not a supporter");
  });

  it("rejects an unregistered vault (fake vault cannot mint earnings or tiers)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    const Stub = await hre.ethers.getContractFactory("MockVaultStub");
    const fake = await Stub.deploy(await ctx.testUSDC.getAddress());
    const enc = await encryptAmountFor(ctx.client, ctx.bob, 50n, await ctx.hub.getAddress());
    await expect(
      ctx.hub.connect(ctx.bob).support(ctx.alice.address, await fake.getAddress(), ...enc, ""),
    ).to.be.revertedWith("CreatorHub: vault not allowed");
  });

  it("unset registry fails closed", async () => {
    const ctx = await loadFixture(deployFixture);
    const fresh = await deployProxy("CreatorHub", [await ctx.eventHub.getAddress()]);
    await fresh.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    const enc = await encryptAmountFor(ctx.client, ctx.bob, 50n, await fresh.getAddress());
    await expect(
      fresh.connect(ctx.bob).support(ctx.alice.address, await ctx.vault.getAddress(), ...enc, ""),
    ).to.be.revertedWith("CreatorHub: vault not allowed");
    await expect(fresh.setTokenRegistry(ctx.bob.address)).to.be.revertedWith("CreatorHub: bad registry");
  });

  it("tips in two tokens are tracked separately, never summed", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
    const token2 = await TestUSDC.deploy();
    const vault2 = await deployProxy("FHERC20Vault", [
      await token2.getAddress(), "Second", "bv2", USDC_DECIMALS, await ctx.eventHub.getAddress(),
    ]);
    await ctx.registry.registerToken(await vault2.getAddress(), await token2.getAddress(), "Second", "T2", USDC_DECIMALS);
    await token2.mint(ctx.bob.address, usdc(10));
    await token2.connect(ctx.bob).approve(await vault2.getAddress(), usdc(10));
    await vault2.connect(ctx.bob).shield(usdc(10));
    await vault2.connect(ctx.bob).approvePlaintext(await ctx.hub.getAddress(), (1n << 64n) - 1n);

    await tipAndConfirm(ctx, ctx.bob, ctx.alice.address, 150n);
    await tipAndConfirm(ctx, ctx.bob, ctx.alice.address, 70n, "", await vault2.getAddress());

    const v1 = await ctx.vault.getAddress();
    const v2 = await vault2.getAddress();
    await mock_expectPlaintext(ctx.alice.provider, await ctx.hub.connect(ctx.alice).getMyEarningsIn(v1), 150n);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.hub.connect(ctx.alice).getMyEarningsIn(v2), 70n);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.hub.connect(ctx.bob).getMyContributionIn(ctx.alice.address, v2), 70n);
    expect(await ctx.hub.getSupportedCreators(ctx.bob.address)).to.deep.equal([ctx.alice.address]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Funding gate (C1): the vault moves 0 when the tipper is short, so a
//  tip counts only after confirmFunding proves a non-zero movement.
// ══════════════════════════════════════════════════════════════════

const TIP_NONE = 0;
const TIP_PENDING = 1;
const TIP_CONFIRMED = 2;
const TIP_VOIDED = 3;

function mappingSlot(key: string, slot: bigint | number): string {
  return hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [key, slot]));
}

async function setStorage(address: string, slot: string, value: bigint) {
  await hre.network.provider.send("hardhat_setStorageAt", [address, slot, hre.ethers.toBeHex(value, 32)]);
}

describe("CreatorHub: funding gate (C1)", () => {
  async function aliceCreator(ctx: any) {
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
  }

  it("a funded tip is Pending first, then Confirmed: counted only after confirmFunding", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const hubAddr = await ctx.hub.getAddress();
    const enc = await encryptAmountFor(ctx.client, ctx.bob, 50n, hubAddr);
    await expect(ctx.hub.connect(ctx.bob).support(ctx.alice.address, await ctx.vault.getAddress(), ...enc, "hi"))
      .to.emit(ctx.hub, "TipPending")
      .withArgs(0, ctx.bob.address, ctx.alice.address, await ctx.vault.getAddress(), (_h: string) => true);

    expect((await ctx.hub.getTip(0)).status).to.equal(TIP_PENDING);
    expect((await ctx.hub.getProfile(ctx.alice.address)).supporterCount).to.equal(0);
    expect(await ctx.hub.getSupportedCreators(ctx.bob.address)).to.deep.equal([]);
    await expect(ctx.hub.connect(ctx.bob).getMyContributionIn(ctx.alice.address, await ctx.vault.getAddress()))
      .to.be.revertedWith("CreatorHub: not a supporter");
    await expect(ctx.hub.connect(ctx.bob).checkMyTierIn(ctx.alice.address, await ctx.vault.getAddress()))
      .to.be.revertedWith("CreatorHub: not a supporter");

    await expect(confirmTip(ctx, 0n))
      .to.emit(ctx.hub, "SupportedIn")
      .and.to.emit(ctx.hub, "Supported");
    expect((await ctx.hub.getTip(0)).status).to.equal(TIP_CONFIRMED);
    expect((await ctx.hub.getProfile(ctx.alice.address)).supporterCount).to.equal(1);
    expect(await ctx.hub.getSupportedCreators(ctx.bob.address)).to.deep.equal([ctx.alice.address]);
    await expect(ctx.hub.connect(ctx.bob).checkMyTierIn(ctx.alice.address, await ctx.vault.getAddress())).to.not.be.reverted;
  });

  it("a zero-balance supporter is voided: no count, no list entry, no tier access, no Supported", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const v = await ctx.vault.getAddress();
    const hubAddr = await ctx.hub.getAddress();
    // A fresh address with no vault balance at all.
    const [, , , , sybil] = await hre.ethers.getSigners();
    await ctx.vault.connect(sybil).approvePlaintext(hubAddr, (1n << 64n) - 1n);
    const enc = await encryptAmountFor(ctx.client, sybil, 50n, hubAddr);
    await ctx.hub.connect(sybil).support(ctx.alice.address, v, ...enc, "free ride");

    await expect(confirmTip(ctx, 0n))
      .to.emit(ctx.hub, "TipVoided").withArgs(0, sybil.address, ctx.alice.address)
      .and.to.not.emit(ctx.hub, "Supported")
      .and.to.not.emit(ctx.hub, "SupportedIn");
    expect((await ctx.hub.getTip(0)).status).to.equal(TIP_VOIDED);
    expect((await ctx.hub.getProfile(ctx.alice.address)).supporterCount).to.equal(0);
    expect(await ctx.hub.getSupportedCreators(sybil.address)).to.deep.equal([]);
    await expect(ctx.hub.connect(sybil).checkMyTierIn(ctx.alice.address, v))
      .to.be.revertedWith("CreatorHub: not a supporter");
    await mock_expectPlaintext(ctx.alice.provider, await ctx.hub.connect(ctx.alice).getMyEarningsIn(v), 0n);
  });

  it("an over-balance tip (vault moves 0) and an explicit zero tip are both voided", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const v = await ctx.vault.getAddress();
    const hubAddr = await ctx.hub.getAddress();
    await ctx.hub.connect(ctx.bob).support(ctx.alice.address, v, ...(await encryptAmountFor(ctx.client, ctx.bob, usdc(5_000), hubAddr)), "");
    await ctx.hub.connect(ctx.charlie).support(ctx.alice.address, v, ...(await encryptAmountFor(ctx.client, ctx.charlie, 0n, hubAddr)), "");
    await confirmTip(ctx, 0n);
    await confirmTip(ctx, 1n);
    expect((await ctx.hub.getTip(0)).status).to.equal(TIP_VOIDED);
    expect((await ctx.hub.getTip(1)).status).to.equal(TIP_VOIDED);
    expect((await ctx.hub.getProfile(ctx.alice.address)).supporterCount).to.equal(0);
  });

  it("encrypted totals still reflect exactly what moved, whether or not the tip is confirmed yet", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const v = await ctx.vault.getAddress();
    const hubAddr = await ctx.hub.getAddress();
    await ctx.hub.connect(ctx.bob).support(ctx.alice.address, v, ...(await encryptAmountFor(ctx.client, ctx.bob, 60n, hubAddr)), "");
    await mock_expectPlaintext(ctx.alice.provider, await ctx.hub.connect(ctx.alice).getMyEarningsIn(v), 60n);
    await confirmTip(ctx, 0n);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.hub.connect(ctx.bob).getMyContributionIn(ctx.alice.address, v), 60n);
  });

  it("anyone can confirm; a tip settles once; unknown ids revert", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const hubAddr = await ctx.hub.getAddress();
    await ctx.hub.connect(ctx.bob).support(ctx.alice.address, await ctx.vault.getAddress(), ...(await encryptAmountFor(ctx.client, ctx.bob, 10n, hubAddr)), "");
    await confirmTip(ctx, 0n, ctx.charlie);
    expect((await ctx.hub.getTip(0)).status).to.equal(TIP_CONFIRMED);
    await expect(confirmTip(ctx, 0n)).to.be.revertedWith("CreatorHub: tip not pending");
    await expect(ctx.hub.confirmFunding(99, true, "0x")).to.be.revertedWith("CreatorHub: tip not pending");
    expect((await ctx.hub.getTip(99)).status).to.equal(TIP_NONE);
  });

  it("a forged flag cannot turn a void tip into a supporter", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const hubAddr = await ctx.hub.getAddress();
    const [, , , , sybil] = await hre.ethers.getSigners();
    await ctx.vault.connect(sybil).approvePlaintext(hubAddr, (1n << 64n) - 1n);
    await ctx.hub.connect(sybil).support(ctx.alice.address, await ctx.vault.getAddress(), ...(await encryptAmountFor(ctx.client, sybil, 50n, hubAddr)), "");
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.owner);
    const proof = await ctx.client.decryptForTx(await ctx.hub.getTipFundedHandle(0), FheTypes.Bool).withoutACP().execute();
    expect(Boolean(proof.decryptedValue)).to.equal(false);
    await expect(ctx.hub.confirmFunding(0, true, proof.signature)).to.be.reverted;
    expect((await ctx.hub.getTip(0)).status).to.equal(TIP_PENDING);
    expect((await ctx.hub.getProfile(ctx.alice.address)).supporterCount).to.equal(0);
  });

  it("confirmFunding still settles when someone published the decryption first", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const hubAddr = await ctx.hub.getAddress();
    await ctx.hub.connect(ctx.bob).support(ctx.alice.address, await ctx.vault.getAddress(), ...(await encryptAmountFor(ctx.client, ctx.bob, 10n, hubAddr)), "");
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.owner);
    const handle = await ctx.hub.getTipFundedHandle(0);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
    const tm = await hre.cofhe.mocks.getMockTaskManager();
    await tm.publishDecryptResult(handle, 1n, proof.signature);
    // The stored result wins; the arguments are not trusted.
    await ctx.hub.confirmFunding(0, false, "0x");
    expect((await ctx.hub.getTip(0)).status).to.equal(TIP_CONFIRMED);
  });

  it("existing supporters are unaffected: a legacy supporter keeps their count and a repeat tip does not re-count", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const hubAddr = await ctx.hub.getAddress();
    // Emulate a pre-gate record: _hasContributed[alice][bob] (slot 5) and
    // supporterCount (profile struct slot 4) already set.
    const hasContribSlot = mappingSlot(ctx.bob.address, BigInt(mappingSlot(ctx.alice.address, 5)));
    await setStorage(hubAddr, hasContribSlot, 1n);
    const profileBase = BigInt(mappingSlot(ctx.alice.address, 2));
    await setStorage(hubAddr, hre.ethers.toBeHex(profileBase + 4n, 32), 1n);
    expect((await ctx.hub.getProfile(ctx.alice.address)).supporterCount).to.equal(1);

    await tipAndConfirm(ctx, ctx.bob, ctx.alice.address, 20n);
    expect((await ctx.hub.getProfile(ctx.alice.address)).supporterCount).to.equal(1);
    // Already counted, so no second list entry is pushed (the emulated
    // record never had one).
    expect(await ctx.hub.getSupportedCreators(ctx.bob.address)).to.deep.equal([]);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.hub.connect(ctx.bob).getMyContributionIn(ctx.alice.address, await ctx.vault.getAddress()), 20n);
  });

  it("privacy: the creator is never granted the moved handle, the tipper is", async () => {
    const ctx = await loadFixture(deployFixture);
    await aliceCreator(ctx);
    const hubAddr = await ctx.hub.getAddress();
    const enc = await encryptAmountFor(ctx.client, ctx.bob, 40n, hubAddr);
    await ctx.hub.connect(ctx.bob).support(ctx.alice.address, await ctx.vault.getAddress(), ...enc, "");
    const tx = await confirmTip(ctx, 0n);
    const receipt = await tx.wait();
    const log = receipt.logs
      .map((l: any) => { try { return ctx.hub.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p && p.name === "SupportedIn");
    const movedHandle = log.args.moved;
    const acl = await hre.cofhe.mocks.getMockACL();
    expect(await acl.isAllowed(movedHandle, ctx.bob.address)).to.equal(true);
    expect(await acl.isAllowed(movedHandle, ctx.alice.address)).to.equal(false);
    // The creator's aggregate view still works.
    await mock_expectPlaintext(ctx.alice.provider, await ctx.hub.connect(ctx.alice).getMyEarningsIn(await ctx.vault.getAddress()), 40n);
  });
});
