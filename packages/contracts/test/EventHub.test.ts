import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  EventHub — unified activity-event emitter
//
//  Covers:
//   • Whitelist gate: only whitelisted contracts can emitActivity
//   • Owner-only: whitelist + removeWhitelist + batchWhitelist
//   • Activity event shape preserves all args + auto-fills sourceContract
//   • batchWhitelist accepts multiple addresses in one tx
//   • Removing whitelist disables a previously-allowed caller
// ══════════════════════════════════════════════════════════════════

// Local UUPS proxy deploy helper — matches the shape used in Blank.test.ts.
// hre.upgrades from @openzeppelin/hardhat-upgrades is NOT a dependency in
// this repo, so we wire the ERC1967Proxy by hand.
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

async function fixture() {
  const [owner, alice, bob, eve] = await hre.ethers.getSigners();
  const hub = await deployProxy("EventHub");
  return { owner, alice, bob, eve, hub };
}

describe("EventHub — whitelist gate", () => {
  it("rejects emitActivity from non-whitelisted caller", async () => {
    const ctx = await loadFixture(fixture);
    await expect(
      ctx.hub.connect(ctx.eve).emitActivity(ctx.alice.address, ctx.bob.address, "payment", "note", 0),
    ).to.be.revertedWith("EventHub: caller not whitelisted");
  });

  it("accepts emitActivity from a whitelisted caller and emits Activity with msg.sender as sourceContract", async () => {
    const ctx = await loadFixture(fixture);
    // Whitelist Alice's EOA so she can emit directly (real callers are
    // contracts; using an EOA keeps the test simple — the modifier only
    // checks `whitelisted[msg.sender]`).
    await ctx.hub.connect(ctx.owner).whitelist(ctx.alice.address);
    await expect(
      ctx.hub.connect(ctx.alice).emitActivity(ctx.alice.address, ctx.bob.address, "payment", "lunch", 42),
    )
      .to.emit(ctx.hub, "Activity")
      .withArgs(ctx.alice.address, ctx.bob.address, "payment", ctx.alice.address, "lunch", 42, await time());
  });

  it("removeWhitelist disables a previously-allowed caller", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.hub.connect(ctx.owner).whitelist(ctx.alice.address);
    await ctx.hub.connect(ctx.owner).removeWhitelist(ctx.alice.address);
    await expect(
      ctx.hub.connect(ctx.alice).emitActivity(ctx.alice.address, ctx.bob.address, "payment", "x", 0),
    ).to.be.revertedWith("EventHub: caller not whitelisted");
  });
});

describe("EventHub — owner-only admin", () => {
  it("non-owner cannot whitelist", async () => {
    const ctx = await loadFixture(fixture);
    await expect(
      ctx.hub.connect(ctx.eve).whitelist(ctx.alice.address),
    ).to.be.revertedWithCustomError(ctx.hub, "OwnableUnauthorizedAccount");
  });

  it("non-owner cannot removeWhitelist", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.hub.connect(ctx.owner).whitelist(ctx.alice.address);
    await expect(
      ctx.hub.connect(ctx.eve).removeWhitelist(ctx.alice.address),
    ).to.be.revertedWithCustomError(ctx.hub, "OwnableUnauthorizedAccount");
  });

  it("non-owner cannot batchWhitelist", async () => {
    const ctx = await loadFixture(fixture);
    await expect(
      ctx.hub.connect(ctx.eve).batchWhitelist([ctx.alice.address, ctx.bob.address]),
    ).to.be.revertedWithCustomError(ctx.hub, "OwnableUnauthorizedAccount");
  });
});

describe("EventHub — batchWhitelist", () => {
  it("whitelists multiple addresses in one tx; each one can then emit", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.hub.connect(ctx.owner).batchWhitelist([ctx.alice.address, ctx.bob.address]);
    // Both Alice and Bob should now be able to emit; Eve still can't.
    await expect(
      ctx.hub.connect(ctx.alice).emitActivity(ctx.alice.address, ctx.bob.address, "tip", "thanks", 0),
    ).to.not.be.reverted;
    await expect(
      ctx.hub.connect(ctx.bob).emitActivity(ctx.bob.address, ctx.alice.address, "tip", "back at you", 0),
    ).to.not.be.reverted;
    await expect(
      ctx.hub.connect(ctx.eve).emitActivity(ctx.eve.address, ctx.alice.address, "tip", "x", 0),
    ).to.be.revertedWith("EventHub: caller not whitelisted");
  });
});

// Helper — return the latest-block timestamp + 1 so `withArgs` lines up
// with the timestamp the contract reads on the emit-tx's mined block.
// hardhat advances by 1 second per block by default; the next tx after
// this call mines at `latest + 1`.
async function time(): Promise<number> {
  const latest = await hre.ethers.provider.getBlock("latest");
  return (latest?.timestamp ?? 0) + 1;
}
