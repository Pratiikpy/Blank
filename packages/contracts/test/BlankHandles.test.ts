import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toUtf8Bytes, ZeroAddress } from "ethers";

// Wave 5 Block 2 — BlankHandles tests.
//
// Locks the invariants the screen + send-to-handle flow depend on:
//   - case-insensitive uniqueness
//   - 3-24 length bounds
//   - char allowlist (a-z A-Z 0-9 . - _)
//   - reserved-word block
//   - short-handle (<=4) admin-only at v1
//   - one handle per address
//   - reverseLookup round-trip
//   - recoveryHook rebind on guardian recovery
//   - 30-day inactivity reclaim
//   - email digest + ENS fallback writes

async function deployProxy(name: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(name);
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

function normHash(handle: string): string {
  return keccak256(toUtf8Bytes(handle.toLowerCase()));
}

async function deployFixture() {
  const [owner, alice, bob, carol, recoveryHook] = await hre.ethers.getSigners();
  const handles = await deployProxy("BlankHandles");
  return { owner, alice, bob, carol, recoveryHook, handles };
}

describe("BlankHandles", () => {
  it("reserves a valid handle, emits HandleReserved, sets reverseLookup", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32)))
      .to.emit(ctx.handles, "HandleReserved");
    const h = await ctx.handles.lookup("alice123");
    expect(h.owner).to.equal(ctx.alice.address);
    expect(await ctx.handles.reverseLookup(ctx.alice.address)).to.equal(normHash("alice123"));
  });

  it("rejects too-short handles", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.handles.connect(ctx.alice).reserve("ab", "0x" + "00".repeat(32)))
      .to.be.revertedWith("BlankHandles: too short");
  });

  it("rejects too-long handles (> 24)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.handles.connect(ctx.alice).reserve("a".repeat(25), "0x" + "00".repeat(32)))
      .to.be.revertedWith("BlankHandles: too long");
  });

  it("rejects short (3-4 char) handles via reserve (admin-only)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.handles.connect(ctx.alice).reserve("abc", "0x" + "00".repeat(32)))
      .to.be.revertedWith("BlankHandles: short handles admin-only at v1");
    await expect(ctx.handles.connect(ctx.alice).reserve("abcd", "0x" + "00".repeat(32)))
      .to.be.revertedWith("BlankHandles: short handles admin-only at v1");
  });

  it("allows owner to adminMintShort", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.owner).adminMintShort("abc", ctx.alice.address);
    const h = await ctx.handles.lookup("abc");
    expect(h.owner).to.equal(ctx.alice.address);
  });

  it("rejects non-owner adminMintShort", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.handles.connect(ctx.alice).adminMintShort("abc", ctx.alice.address))
      .to.be.reverted;
  });

  it("is case-insensitive on uniqueness", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32));
    // Bob can't reserve the same handle in different casing.
    await expect(ctx.handles.connect(ctx.bob).reserve("ALICE123", "0x" + "00".repeat(32)))
      .to.be.revertedWith("BlankHandles: taken");
  });

  it("rejects non-allowlist characters", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.handles.connect(ctx.alice).reserve("alice!world", "0x" + "00".repeat(32)))
      .to.be.revertedWith("BlankHandles: bad chars");
  });

  it("allows dots, dashes, underscores, digits", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.alice).reserve("a.b-c_1", "0x" + "00".repeat(32));
    expect((await ctx.handles.lookup("a.b-c_1")).owner).to.equal(ctx.alice.address);
  });

  it("rejects reserved-word handle", async () => {
    const ctx = await loadFixture(deployFixture);
    const apple = normHash("apple");
    await ctx.handles.connect(ctx.owner).setReservedList([apple], true);
    await expect(ctx.handles.connect(ctx.alice).reserve("apple", "0x" + "00".repeat(32)))
      .to.be.revertedWith("BlankHandles: reserved");
  });

  it("rejects one address reserving a second handle", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32));
    await expect(ctx.handles.connect(ctx.alice).reserve("alice456", "0x" + "00".repeat(32)))
      .to.be.revertedWith("BlankHandles: already have handle");
  });

  it("isAvailable returns ok+empty reason for fresh handle", async () => {
    const ctx = await loadFixture(deployFixture);
    const [ok, reason] = await ctx.handles.isAvailable("freshname");
    expect(ok).to.equal(true);
    expect(reason).to.equal("");
  });

  it("isAvailable returns false for short / taken / reserved / bad-chars", async () => {
    const ctx = await loadFixture(deployFixture);
    expect((await ctx.handles.isAvailable("ab"))[1]).to.equal("too short");
    expect((await ctx.handles.isAvailable("a".repeat(25)))[1]).to.equal("too long");
    expect((await ctx.handles.isAvailable("bad!name"))[1]).to.equal("bad chars");
    expect((await ctx.handles.isAvailable("abc"))[1]).to.equal("short admin-only at v1");
    await ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32));
    expect((await ctx.handles.isAvailable("alice123"))[1]).to.equal("taken");
    await ctx.handles.connect(ctx.owner).setReservedList([normHash("apple")], true);
    expect((await ctx.handles.isAvailable("apple"))[1]).to.equal("reserved");
  });

  it("setEmailDigest writes + emits", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32));
    const digest = "0x" + "11".repeat(32);
    await expect(ctx.handles.connect(ctx.alice).setEmailDigest("alice123", digest))
      .to.emit(ctx.handles, "HandleEmailDigestSet");
    expect((await ctx.handles.lookup("alice123")).emailDigest).to.equal(digest);
  });

  it("setEnsFallback writes + emits", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32));
    const ens = "0x" + "22".repeat(32);
    await expect(ctx.handles.connect(ctx.alice).setEnsFallback("alice123", ens))
      .to.emit(ctx.handles, "HandleEnsSet");
    expect((await ctx.handles.lookup("alice123")).ensRecord).to.equal(ens);
  });

  it("transferOwner is gated to the recoveryHook", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32));
    const h = normHash("alice123");
    // No hook set yet -> anyone reverts.
    await expect(ctx.handles.connect(ctx.alice).transferOwner(h, ctx.bob.address))
      .to.be.revertedWith("BlankHandles: not recovery hook");
    // Set the hook then call from it.
    await ctx.handles.connect(ctx.owner).setRecoveryHook(ctx.recoveryHook.address);
    await expect(ctx.handles.connect(ctx.recoveryHook).transferOwner(h, ctx.bob.address))
      .to.emit(ctx.handles, "HandleOwnerTransferred");
    const updated = await ctx.handles.lookup("alice123");
    expect(updated.owner).to.equal(ctx.bob.address);
    expect(await ctx.handles.reverseLookup(ctx.alice.address)).to.equal("0x" + "00".repeat(32));
  });

  it("reclaimInactive frees a handle after 30 days of no activity", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32));
    // Too early
    await expect(ctx.handles.connect(ctx.carol).reclaimInactive("alice123"))
      .to.be.revertedWith("BlankHandles: not inactive");
    // Skip past 30 days.
    await hre.network.provider.send("evm_increaseTime", [30 * 24 * 3600 + 1]);
    await hre.network.provider.send("evm_mine");
    await expect(ctx.handles.connect(ctx.carol).reclaimInactive("alice123"))
      .to.emit(ctx.handles, "HandleOwnerTransferred");
    const after = await ctx.handles.lookup("alice123");
    expect(after.owner).to.equal(ZeroAddress);
    // Bob can now reserve it.
    await ctx.handles.connect(ctx.bob).reserve("alice123", "0x" + "00".repeat(32));
    expect((await ctx.handles.lookup("alice123")).owner).to.equal(ctx.bob.address);
  });

  it("pingActivity bumps lastActivityAt", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.handles.connect(ctx.alice).reserve("alice123", "0x" + "00".repeat(32));
    await hre.network.provider.send("evm_increaseTime", [5 * 24 * 3600]);
    await ctx.handles.connect(ctx.bob).pingActivity("alice123");
    // Now 30 days from THIS ping; cannot reclaim immediately.
    await expect(ctx.handles.connect(ctx.carol).reclaimInactive("alice123"))
      .to.be.revertedWith("BlankHandles: not inactive");
  });
});
