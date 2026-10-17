import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  BurnerRegistry — Phase 6.2 durable backup for burner metadata
//
//  Covers:
//   • setMetadata happy path stores blob + emits event
//   • setMetadata rejects zero tag / empty blob / oversized blob
//   • setMetadata overwrites prior value
//   • clearMetadata happy path deletes slot + emits event
//   • clearMetadata rejects unwritten slot / zero tag
//   • No event or input carries a burner address (L4)
//   • Read helpers: getMetadata returns last written, hasMetadata reflects
//   • Per-owner isolation: alice's writes don't appear under bob's owner key
//   • Read of non-existent slot returns empty bytes
// ══════════════════════════════════════════════════════════════════

async function fixture() {
  const [owner, alice, bob, eve] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("BurnerRegistry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();
  return { owner, alice, bob, eve, registry };
}

// Deterministic burner addresses for tests — any 20-byte address works.
// Use ethers' checksummed form so chai matchers' EIP-55 case-comparison
// against the event payload doesn't bark.
// Opaque tags the client derives from secret material (e.g. HMAC(backupKey, burnerId)).
const burnerA = hre.ethers.id("tag-a");
const burnerB = hre.ethers.id("tag-b");

const blobA = "0x" + "11".repeat(64); // 64-byte blob (typical AES-GCM ciphertext size)
const blobB = "0x" + "22".repeat(80); // 80-byte
const blobLong = "0x" + "33".repeat(1024); // exactly at MAX_BLOB_BYTES
const blobTooLong = "0x" + "44".repeat(1025); // 1 byte over the cap

describe("BurnerRegistry — setMetadata", () => {
  it("stores blob and emits BackupSet", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await expect(registry.connect(alice).setMetadata(burnerA, blobA))
      .to.emit(registry, "BackupSet")
      .withArgs(alice.address, burnerA, blobA, anyTimestamp());

    expect(await registry.getMetadata(alice.address, burnerA)).to.equal(blobA);
    expect(await registry.hasMetadata(alice.address, burnerA)).to.equal(true);
  });

  it("overwrites prior blob (re-set)", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobA);
    await registry.connect(alice).setMetadata(burnerA, blobB);
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal(blobB);
  });

  it("rejects zero tag", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await expect(
      registry.connect(alice).setMetadata(hre.ethers.ZeroHash, blobA),
    ).to.be.revertedWithCustomError(registry, "ZeroTag");
  });

  it("rejects empty blob (use clearMetadata instead)", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await expect(
      registry.connect(alice).setMetadata(burnerA, "0x"),
    ).to.be.revertedWithCustomError(registry, "EmptyBlob");
  });

  it("accepts blob at MAX_BLOB_BYTES (1024 bytes)", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobLong);
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal(blobLong);
  });

  it("rejects blob just over MAX_BLOB_BYTES", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await expect(
      registry.connect(alice).setMetadata(burnerA, blobTooLong),
    ).to.be.revertedWithCustomError(registry, "BlobTooLarge");
  });
});

describe("BurnerRegistry — clearMetadata", () => {
  it("deletes slot and emits BackupCleared", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobA);
    await expect(registry.connect(alice).clearMetadata(burnerA))
      .to.emit(registry, "BackupCleared")
      .withArgs(alice.address, burnerA, anyTimestamp());
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal("0x");
    expect(await registry.hasMetadata(alice.address, burnerA)).to.equal(false);
  });

  it("rejects clear when no metadata exists", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await expect(
      registry.connect(alice).clearMetadata(burnerA),
    ).to.be.revertedWithCustomError(registry, "NoMetadata");
  });

  it("rejects zero tag", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await expect(
      registry.connect(alice).clearMetadata(hre.ethers.ZeroHash),
    ).to.be.revertedWithCustomError(registry, "ZeroTag");
  });

  it("after clear, can re-set the same burner", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobA);
    await registry.connect(alice).clearMetadata(burnerA);
    await registry.connect(alice).setMetadata(burnerA, blobB);
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal(blobB);
  });
});

describe("BurnerRegistry — per-owner isolation", () => {
  it("alice's writes don't appear under bob's owner key", async () => {
    const { alice, bob, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobA);
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal(blobA);
    expect(await registry.getMetadata(bob.address, burnerA)).to.equal("0x");
    expect(await registry.hasMetadata(bob.address, burnerA)).to.equal(false);
  });

  it("eve cannot clear alice's metadata", async () => {
    const { alice, eve, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobA);
    // Eve can call clearMetadata for a burner under her OWN owner key,
    // but it reverts because she has no metadata. She CANNOT clear
    // alice's slot — the contract uses msg.sender as the owner key
    // unconditionally, so eve's clearMetadata only ever touches
    // metadata[eve][burnerA], not metadata[alice][burnerA].
    await expect(
      registry.connect(eve).clearMetadata(burnerA),
    ).to.be.revertedWithCustomError(registry, "NoMetadata");
    // Alice's data is untouched.
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal(blobA);
  });

  it("eve cannot overwrite alice's metadata via her own setMetadata", async () => {
    const { alice, eve, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobA);
    // Eve writes to her OWN owner key for the same burner address.
    // She gets her own slot — alice's is unaffected.
    await registry.connect(eve).setMetadata(burnerA, blobB);
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal(blobA);
    expect(await registry.getMetadata(eve.address, burnerA)).to.equal(blobB);
  });
});

describe("BurnerRegistry — multi-burner per owner", () => {
  it("alice can register multiple burners independently", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobA);
    await registry.connect(alice).setMetadata(burnerB, blobB);
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal(blobA);
    expect(await registry.getMetadata(alice.address, burnerB)).to.equal(blobB);
  });

  it("clearing one burner doesn't affect another", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await registry.connect(alice).setMetadata(burnerA, blobA);
    await registry.connect(alice).setMetadata(burnerB, blobB);
    await registry.connect(alice).clearMetadata(burnerA);
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal("0x");
    expect(await registry.getMetadata(alice.address, burnerB)).to.equal(blobB);
  });
});

describe("BurnerRegistry — view defaults", () => {
  it("getMetadata of unset slot returns empty bytes", async () => {
    const { alice, registry } = await loadFixture(fixture);
    expect(await registry.getMetadata(alice.address, burnerA)).to.equal("0x");
  });

  it("hasMetadata returns false for unset slot", async () => {
    const { alice, registry } = await loadFixture(fixture);
    expect(await registry.hasMetadata(alice.address, burnerA)).to.equal(false);
  });

  it("MAX_BLOB_BYTES exposes the upper bound", async () => {
    const { registry } = await loadFixture(fixture);
    expect(await registry.MAX_BLOB_BYTES()).to.equal(1024);
  });
});

// L4: v1 emitted (owner, burner) as indexed topics, publishing the main-to-burner
// link. v2 events and storage never carry a burner address.
describe("BurnerRegistry — burner address never published (L4)", () => {
  it("no log topic or data contains the burner address", async () => {
    const { alice, registry } = await loadFixture(fixture);
    const burner = hre.ethers.Wallet.createRandom().address.toLowerCase().slice(2);
    // Real clients put the burner address only inside the encrypted blob.
    const tag = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("secret-key|burner-1"));
    const tx = await registry.connect(alice).setMetadata(tag, blobA);
    const rc = await tx.wait();
    const clear = await (await registry.connect(alice).clearMetadata(tag)).wait();
    for (const log of [...rc!.logs, ...clear!.logs]) {
      for (const t of log.topics) expect(t.toLowerCase()).to.not.include(burner);
      expect(log.data.toLowerCase()).to.not.include(burner);
    }
    expect(registry.interface.getFunction("setMetadata")!.inputs[0].type).to.equal("bytes32");
  });
});

function anyTimestamp(): (v: any) => boolean {
  return (v) => typeof v === "bigint" && v > 0n;
}
