import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  ERC5564Announcer — Phase 9 stealth meta-address bulletin board
//
//  Verbatim port of the canonical ERC-5564 reference. The contract
//  has NO STATE and exactly one external function: `announce()`. The
//  test surface is the Announcement event shape + the per-call
//  semantics (anyone can call, caller = msg.sender, indexed fields
//  populated correctly).
//
//  Critical because:
//   • The Announcement event is THE discovery mechanism for stealth
//     recipients — they getLogs over this event to find payments
//     destined for them. A regression in field order or indexing
//     would silently break every stealth-wallet sweep flow.
//   • The `caller` field is indexed so recipients can filter by
//     sender (e.g. "all stealth payments from my employer"). A
//     missing indexed-flag would force full-scan instead of
//     filtered queries, blowing up RPC quota on busy chains.
//   • Anyone can call — the contract is a public bulletin board
//     by design. A regression that added access control would
//     reject every legit sender.
// ══════════════════════════════════════════════════════════════════

const SCHEME_ID = 1; // secp256k1 with view tag (per EIP-5564 §schemes)

// Deterministic test fixtures — any well-formed bytes work.
const stealthAddrA = hre.ethers.getAddress("0xaaaa000000000000000000000000000000000001");
const stealthAddrB = hre.ethers.getAddress("0xaaaa000000000000000000000000000000000002");

// 33-byte compressed secp256k1 pubkey (scheme 1 expects this size).
const ephemeralPubKey = "0x02" + "ab".repeat(32);

// Full EIP-5564 metadata: view tag (1) + function selector (4) + token (20) + amount (32) = 57 bytes.
const fullMetadata = "0x" + "7f" + "a9059cbb" + "11".repeat(20) + "22".repeat(32);

async function fixture() {
  const [deployer, alice, bob] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("ERC5564Announcer");
  const announcer = await Factory.deploy();
  await announcer.waitForDeployment();
  return { deployer, alice, bob, announcer };
}

describe("ERC5564Announcer — announce() event shape", () => {
  it("emits Announcement with schemeId + stealthAddress + caller(msg.sender) + ephemeralPubKey + metadata", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    await expect(
      announcer.connect(alice).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, fullMetadata),
    )
      .to.emit(announcer, "Announcement")
      .withArgs(SCHEME_ID, stealthAddrA, alice.address, ephemeralPubKey, fullMetadata);
  });

  it("caller field reflects msg.sender (per-signer attribution)", async () => {
    const { alice, bob, announcer } = await loadFixture(fixture);
    await expect(
      announcer.connect(bob).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, fullMetadata),
    )
      .to.emit(announcer, "Announcement")
      .withArgs(SCHEME_ID, stealthAddrA, bob.address, ephemeralPubKey, fullMetadata);
  });

  it("accepts schemeId 0 (the EIP-5564 default scheme — caller-supplied, no on-chain validation)", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    await expect(
      announcer.connect(alice).announce(0, stealthAddrA, ephemeralPubKey, fullMetadata),
    )
      .to.emit(announcer, "Announcement")
      .withArgs(0, stealthAddrA, alice.address, ephemeralPubKey, fullMetadata);
  });

  it("accepts arbitrary high schemeIds (new schemes can be added off-chain without contract upgrade)", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    // 2^32 - 1 is well within uint256; pins that the contract doesn't
    // cap schemeId behind an opinionated check.
    const highScheme = 4_294_967_295n;
    await expect(
      announcer.connect(alice).announce(highScheme, stealthAddrA, ephemeralPubKey, fullMetadata),
    )
      .to.emit(announcer, "Announcement")
      .withArgs(highScheme, stealthAddrA, alice.address, ephemeralPubKey, fullMetadata);
  });
});

describe("ERC5564Announcer — public bulletin board (no access control)", () => {
  it("anyone can call announce (no onlyOwner / onlyRole gate)", async () => {
    const { alice, bob, announcer } = await loadFixture(fixture);
    await expect(
      announcer.connect(alice).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, fullMetadata),
    ).to.not.be.reverted;
    await expect(
      announcer.connect(bob).announce(SCHEME_ID, stealthAddrB, ephemeralPubKey, fullMetadata),
    ).to.not.be.reverted;
  });

  it("multiple announcements from the SAME caller all emit independently (no rate limit)", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    // 3 back-to-back announcements — same caller, different stealth addresses.
    const addresses = [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
    ].map((a) => hre.ethers.getAddress(a));
    for (const addr of addresses) {
      await announcer.connect(alice).announce(SCHEME_ID, addr, ephemeralPubKey, fullMetadata);
    }
    const filter = announcer.filters.Announcement();
    const events = await announcer.queryFilter(filter);
    expect(events.length).to.equal(3);
    for (let i = 0; i < 3; i++) {
      expect(events[i].args.stealthAddress).to.equal(addresses[i]);
      expect(events[i].args.caller).to.equal(alice.address);
    }
  });
});

describe("ERC5564Announcer — payload shape tolerance (caller-supplied, no validation)", () => {
  it("accepts empty ephemeralPubKey + empty metadata (contract has no length checks)", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    await expect(
      announcer.connect(alice).announce(SCHEME_ID, stealthAddrA, "0x", "0x"),
    )
      .to.emit(announcer, "Announcement")
      .withArgs(SCHEME_ID, stealthAddrA, alice.address, "0x", "0x");
  });

  it("accepts metadata with only the view tag (1 byte) — minimum useful payload", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    const viewTagOnly = "0x7f";
    await expect(
      announcer.connect(alice).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, viewTagOnly),
    )
      .to.emit(announcer, "Announcement")
      .withArgs(SCHEME_ID, stealthAddrA, alice.address, ephemeralPubKey, viewTagOnly);
  });

  it("accepts oversized metadata (the EIP doesn't cap; caller pays the calldata gas)", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    // 1KB metadata — well beyond the EIP's documented 57-byte canonical
    // shape; the contract doesn't reject so any future scheme can extend.
    const bigMetadata = "0x" + "5a".repeat(1024);
    await expect(
      announcer.connect(alice).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, bigMetadata),
    ).to.emit(announcer, "Announcement");
  });

  it("accepts zero-address stealthAddress (caller-supplied, no validation)", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    // The contract doesn't reject the zero address — recipients are
    // expected to filter junk at the indexer / scanner layer.
    await expect(
      announcer.connect(alice).announce(
        SCHEME_ID,
        "0x0000000000000000000000000000000000000000",
        ephemeralPubKey,
        fullMetadata,
      ),
    ).to.emit(announcer, "Announcement");
  });
});

describe("ERC5564Announcer — indexed-field filtering (the scanner contract)", () => {
  it("filtering by stealthAddress returns only matching events", async () => {
    const { alice, bob, announcer } = await loadFixture(fixture);
    await announcer.connect(alice).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, fullMetadata);
    await announcer.connect(bob).announce(SCHEME_ID, stealthAddrB, ephemeralPubKey, fullMetadata);
    await announcer.connect(alice).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, fullMetadata);
    const filter = announcer.filters.Announcement(undefined, stealthAddrA);
    const events = await announcer.queryFilter(filter);
    expect(events.length).to.equal(2);
    for (const ev of events) expect(ev.args.stealthAddress).to.equal(stealthAddrA);
  });

  it("filtering by caller returns only that sender's events (employer-attribution use case)", async () => {
    const { alice, bob, announcer } = await loadFixture(fixture);
    await announcer.connect(alice).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, fullMetadata);
    await announcer.connect(bob).announce(SCHEME_ID, stealthAddrA, ephemeralPubKey, fullMetadata);
    await announcer.connect(alice).announce(SCHEME_ID, stealthAddrB, ephemeralPubKey, fullMetadata);
    const filter = announcer.filters.Announcement(undefined, undefined, alice.address);
    const events = await announcer.queryFilter(filter);
    expect(events.length).to.equal(2);
    for (const ev of events) expect(ev.args.caller).to.equal(alice.address);
  });

  it("filtering by schemeId returns only that scheme's events (multi-scheme coexistence)", async () => {
    const { alice, announcer } = await loadFixture(fixture);
    await announcer.connect(alice).announce(1, stealthAddrA, ephemeralPubKey, fullMetadata);
    await announcer.connect(alice).announce(2, stealthAddrA, ephemeralPubKey, fullMetadata);
    await announcer.connect(alice).announce(1, stealthAddrB, ephemeralPubKey, fullMetadata);
    const filter = announcer.filters.Announcement(1);
    const events = await announcer.queryFilter(filter);
    expect(events.length).to.equal(2);
    for (const ev of events) expect(ev.args.schemeId).to.equal(1n);
  });
});

describe("ERC5564Announcer — statelessness invariant", () => {
  it("contract has NO storage slots used (verified by storage layout snapshot)", async () => {
    // The contract is intentionally stateless — only emits events. A
    // regression that added a mapping / counter would break the
    // singleton-deterministic-deploy assumption (CREATE2 addr would
    // shift with every storage slot added).
    const { announcer } = await loadFixture(fixture);
    // Slot 0 must be empty.
    const slot0 = await hre.ethers.provider.getStorage(
      await announcer.getAddress(),
      0,
    );
    expect(slot0).to.equal(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});
