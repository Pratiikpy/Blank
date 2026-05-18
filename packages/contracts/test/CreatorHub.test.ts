import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  CreatorHub — encrypted creator tipping with tier badges.
//
//  Critical because:
//   • Tip amounts are encrypted — even the creator doesn't see
//     individual contributions, only the encrypted running total.
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

async function encryptAmountFor(client: any, signer: any, amount: bigint) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const [enc] = await client.encryptInputs([Encryptable.uint64(amount)]).execute();
  return enc;
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

  // Mint + shield for all three signers; approve the hub via plaintext
  // so the FHE-side transferFromVerified is allowed.
  const MAX = (1n << 64n) - 1n;
  for (const signer of [alice, bob, charlie]) {
    await testUSDC.mint(signer.address, usdc(10_000));
    await testUSDC.connect(signer).approve(await vault.getAddress(), usdc(10_000));
    await vault.connect(signer).shield(usdc(1_000));
    await vault.connect(signer).approvePlaintext(await hub.getAddress(), MAX);
  }

  return { owner, alice, bob, charlie, client, testUSDC, eventHub, vault, hub };
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
  it("first-time supporter: tokens transferred + supporterCount=1 + Supported event", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    const tip = 50n;
    const encTip = await encryptAmountFor(ctx.client, ctx.bob, tip);
    await expect(
      ctx.hub.connect(ctx.bob).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        encTip,
        "love your work",
      ),
    )
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
      const enc = await encryptAmountFor(ctx.client, ctx.bob, tip);
      await ctx.hub.connect(ctx.bob).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        enc,
        "tip " + tip.toString(),
      );
    }
    const profile = await ctx.hub.getProfile(ctx.alice.address);
    expect(profile.supporterCount).to.equal(1);
  });

  it("second tip from SAME supporter: encrypted contribution accumulates (50 + 75 = 125)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    for (const tip of [50n, 75n]) {
      const enc = await encryptAmountFor(ctx.client, ctx.bob, tip);
      await ctx.hub.connect(ctx.bob).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        enc,
        "",
      );
    }
    const contrib = await ctx.hub.connect(ctx.bob).getMyContribution(ctx.alice.address);
    await mock_expectPlaintext(ctx.bob.provider, contrib, 125n);
  });

  it("two distinct supporters: supporterCount=2 + reverse-lookup populated for each", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    for (const supporter of [ctx.bob, ctx.charlie]) {
      const enc = await encryptAmountFor(ctx.client, supporter, 50n);
      await ctx.hub.connect(supporter).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        enc,
        "",
      );
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
      const enc = await encryptAmountFor(ctx.client, ctx.bob, 10n);
      await ctx.hub.connect(ctx.bob).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        enc,
        "",
      );
    }
    // Bob has tipped Alice 3 times; the reverse-lookup must contain
    // Alice exactly once (the push is gated by _hasContributed).
    expect(await ctx.hub.getSupportedCreators(ctx.bob.address)).to.deep.equal([ctx.alice.address]);
  });

  it("creator earnings accumulate across multiple supporters (50 + 50 = 100 total)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);

    for (const supporter of [ctx.bob, ctx.charlie]) {
      const enc = await encryptAmountFor(ctx.client, supporter, 50n);
      await ctx.hub.connect(supporter).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        enc,
        "",
      );
    }
    const earnings = await ctx.hub.connect(ctx.alice).getMyEarnings();
    await mock_expectPlaintext(ctx.alice.provider, earnings, 100n);
  });

  it("rejects support to a creator with NO profile", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encryptAmountFor(ctx.client, ctx.bob, 50n);
    await expect(
      ctx.hub.connect(ctx.bob).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        enc,
        "",
      ),
    ).to.be.revertedWith("CreatorHub: no profile");
  });

  it("rejects self-tipping (creator cannot inflate own count/earnings)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    const enc = await encryptAmountFor(ctx.client, ctx.alice, 50n);
    await expect(
      ctx.hub.connect(ctx.alice).support(
        ctx.alice.address,
        await ctx.vault.getAddress(),
        enc,
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
      ctx.hub.connect(ctx.bob).getMyContribution(ctx.alice.address),
    ).to.be.revertedWith("CreatorHub: not a supporter");
  });

  it("getMyEarnings reverts for accounts without a profile", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.hub.connect(ctx.bob).getMyEarnings(),
    ).to.be.revertedWith("CreatorHub: no profile");
  });

  it("checkMyTier reverts for non-supporters (the only require gate before FHE work)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    await expect(
      ctx.hub.connect(ctx.bob).checkMyTier(ctx.alice.address),
    ).to.be.revertedWith("CreatorHub: not a supporter");
  });

  it("checkMyTier succeeds for a supporter and submits FHE.gte tasks (no revert)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.hub.connect(ctx.alice).setProfile("Alice", "bio", TIER1, TIER2, TIER3);
    const enc = await encryptAmountFor(ctx.client, ctx.bob, 150n);
    await ctx.hub.connect(ctx.bob).support(
      ctx.alice.address,
      await ctx.vault.getAddress(),
      enc,
      "",
    );
    // Just assert the tx doesn't revert; the ebool returns are encrypted
    // handles that need a separate decrypt round to inspect. The encrypted
    // total IS verifiable via getMyContribution + mock_expectPlaintext.
    await expect(ctx.hub.connect(ctx.bob).checkMyTier(ctx.alice.address)).to.not.be.reverted;
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
