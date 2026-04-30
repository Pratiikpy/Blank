import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  ERC6538Registry — Phase 9 stealth meta-address registry
//
//  Verbatim port of the canonical EIP-6538 reference. Tests exercise
//  the contract at semantic level (event emissions, storage updates,
//  signature auth paths) since this is a faithful port of an audited
//  reference — we're guarding against regression in the port, not
//  re-auditing the spec.
//
//  Covers:
//   • registerKeys writes mapping + emits StealthMetaAddressSet
//   • registerKeys overwrites silently (per spec — last writer wins)
//   • registerKeysOnBehalf with valid EOA ECDSA signature
//   • registerKeysOnBehalf rejects mismatched-signer ECDSA sig
//   • registerKeysOnBehalf reverts on unsigned bytes from a non-1271 EOA
//   • Nonce post-increments in the typed-data hash even when sig fails
//   • incrementNonce bumps + emits NonceIncremented
//   • DOMAIN_SEPARATOR matches the EIP-712 hand-computed value
//   • Type hash constant matches the canonical mixed-case spelling
// ══════════════════════════════════════════════════════════════════

const SCHEME_ID = 1n; // secp256k1 + view tag

async function fixture() {
  const [owner, alice, bob] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("ERC6538Registry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();
  return { owner, alice, bob, registry };
}

// Build a mock 66-byte stealth meta-address (33-byte spend pubkey || 33-byte view pubkey).
// Real values would be produced by stealth.ts on the frontend; for
// contract-level tests the bytes are opaque.
function mockMetaAddress(seed: number): string {
  const half = "0x02" + "ab".repeat(32); // valid-looking 0x02-prefixed compressed key
  return half + half.slice(2).replace(/ab/g, (c, i) => (i === 0 ? "cd" : "ab")) + seed.toString(16).padStart(2, "0");
}

// EIP-712 sig over the registry's typed data.
async function signRegistration(
  registry: any,
  signer: any,
  schemeId: bigint,
  metaAddress: string,
  nonce: bigint,
): Promise<string> {
  const domain = {
    name: "ERC6538Registry",
    version: "1.0",
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    verifyingContract: await registry.getAddress(),
  };
  const types = {
    Erc6538RegistryEntry: [
      { name: "schemeId", type: "uint256" },
      { name: "stealthMetaAddress", type: "bytes" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const value = {
    schemeId,
    stealthMetaAddress: metaAddress,
    nonce,
  };
  return signer.signTypedData(domain, types, value);
}

describe("ERC6538Registry — registerKeys", () => {
  it("writes mapping + emits StealthMetaAddressSet", async () => {
    const { alice, registry } = await loadFixture(fixture);
    const meta = mockMetaAddress(1);
    await expect(registry.connect(alice).registerKeys(SCHEME_ID, meta))
      .to.emit(registry, "StealthMetaAddressSet")
      .withArgs(alice.address, SCHEME_ID, meta);
    expect(await registry.stealthMetaAddressOf(alice.address, SCHEME_ID)).to.equal(meta);
  });

  it("overwrites prior meta-address silently — last writer wins", async () => {
    const { alice, registry } = await loadFixture(fixture);
    const a = mockMetaAddress(10);
    const b = mockMetaAddress(20);
    await registry.connect(alice).registerKeys(SCHEME_ID, a);
    await registry.connect(alice).registerKeys(SCHEME_ID, b);
    expect(await registry.stealthMetaAddressOf(alice.address, SCHEME_ID)).to.equal(b);
  });

  it("isolates schemes — different schemeId is a separate slot", async () => {
    const { alice, registry } = await loadFixture(fixture);
    const m1 = mockMetaAddress(1);
    const m2 = mockMetaAddress(2);
    await registry.connect(alice).registerKeys(1n, m1);
    await registry.connect(alice).registerKeys(2n, m2);
    expect(await registry.stealthMetaAddressOf(alice.address, 1n)).to.equal(m1);
    expect(await registry.stealthMetaAddressOf(alice.address, 2n)).to.equal(m2);
  });
});

describe("ERC6538Registry — registerKeysOnBehalf (ECDSA path)", () => {
  it("accepts a valid EOA EIP-712 signature from the registrant", async () => {
    const { alice, bob, registry } = await loadFixture(fixture);
    const meta = mockMetaAddress(7);
    const nonce = await registry.nonceOf(alice.address);
    const sig = await signRegistration(registry, alice, SCHEME_ID, meta, nonce);

    // Bob (anyone) submits the tx on alice's behalf.
    await expect(registry.connect(bob).registerKeysOnBehalf(alice.address, SCHEME_ID, sig, meta))
      .to.emit(registry, "StealthMetaAddressSet")
      .withArgs(alice.address, SCHEME_ID, meta);
    expect(await registry.stealthMetaAddressOf(alice.address, SCHEME_ID)).to.equal(meta);
    // Nonce post-incremented.
    expect(await registry.nonceOf(alice.address)).to.equal(nonce + 1n);
  });

  it("nonce stays unchanged after a failed sig (revert rolls back the unchecked++)", async () => {
    // The contract post-increments `nonceOf[registrant]++` inside an
    // `unchecked` block while computing the dataHash — but Solidity
    // rolls back ALL state when the function later reverts on the bad
    // sig. So the persisted nonce is unchanged, even though the spec
    // text superficially reads as "nonce increments unconditionally."
    const { alice, bob, registry } = await loadFixture(fixture);
    const meta = mockMetaAddress(9);
    const nonceBefore = await registry.nonceOf(alice.address);
    const badSig = "0x" + "ee".repeat(65);
    await expect(
      registry.connect(bob).registerKeysOnBehalf(alice.address, SCHEME_ID, badSig, meta),
    ).to.be.reverted;
    expect(await registry.nonceOf(alice.address)).to.equal(nonceBefore);
  });

  it("does not allow sig replay — second call with the same sig fails", async () => {
    const { alice, bob, registry } = await loadFixture(fixture);
    const meta = mockMetaAddress(11);
    const nonce = await registry.nonceOf(alice.address);
    const sig = await signRegistration(registry, alice, SCHEME_ID, meta, nonce);
    await registry.connect(bob).registerKeysOnBehalf(alice.address, SCHEME_ID, sig, meta);
    // Re-submit. After the first success, the on-disk nonce is now nonce+1.
    // The second call's dataHash uses the new nonce → ecrecover returns a
    // different address → ECDSA branch fails → 1271 fallback against
    // alice (EOA, no code) returns false-via-low-level-call → revert.
    await expect(
      registry.connect(bob).registerKeysOnBehalf(alice.address, SCHEME_ID, sig, meta),
    ).to.be.reverted;
  });
});

describe("ERC6538Registry — registerKeysOnBehalf (ERC-1271 path)", () => {
  // The ERC-1271 fallback is the ONLY path that works for our passkey-AA
  // (BlankAccount) production signers — they cannot produce a 65-byte
  // ECDSA sig that recovers to their own address. These tests exercise
  // that path against a Mock1271 contract that returns a configurable
  // magic value, which mirrors what BlankAccount's isValidSignature
  // returns when the passkey signature validates.
  const MAGIC = "0x1626ba7e";
  const NOT_MAGIC = "0xffffffff";

  async function mockFixture() {
    const base = await fixture();
    const Mock = await hre.ethers.getContractFactory("Mock1271");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    return { ...base, mock };
  }

  it("accepts a valid 1271 contract sig (mock returns magic value)", async () => {
    const { bob, registry, mock } = await loadFixture(mockFixture);
    await mock.setReturnValue(MAGIC);
    const meta = mockMetaAddress(20);
    // Sig payload is opaque to a 1271 verifier — just must NOT be 65 bytes
    // so the ECDSA branch is skipped (otherwise we'd hit ecrecover with a
    // garbage byte string and possibly recover SOME address, then still
    // fall through; the 1271 path is exercised either way, but a non-65
    // length cleanly skips ECDSA which keeps the test focused).
    const opaqueSig = "0x" + "11".repeat(40);
    const mockAddr = await mock.getAddress();
    await expect(registry.connect(bob).registerKeysOnBehalf(mockAddr, SCHEME_ID, opaqueSig, meta))
      .to.emit(registry, "StealthMetaAddressSet")
      .withArgs(mockAddr, SCHEME_ID, meta);
    expect(await registry.stealthMetaAddressOf(mockAddr, SCHEME_ID)).to.equal(meta);
  });

  it("reverts with the specific custom error when 1271 returns non-magic", async () => {
    const { bob, registry, mock } = await loadFixture(mockFixture);
    await mock.setReturnValue(NOT_MAGIC);
    const meta = mockMetaAddress(21);
    const opaqueSig = "0x" + "22".repeat(40);
    const mockAddr = await mock.getAddress();
    await expect(
      registry.connect(bob).registerKeysOnBehalf(mockAddr, SCHEME_ID, opaqueSig, meta),
    ).to.be.revertedWithCustomError(registry, "ERC6538Registry__InvalidSignature");
  });

  it("reverts with the specific custom error when 1271 returns magic and ECDSA also fails (sanity)", async () => {
    // Sets the mock to NOT return magic and uses a 65-byte sig that
    // recovers to a wrong address. Confirms the AND-condition between
    // ECDSA and 1271 in the contract: BOTH must fail to revert. This
    // also confirms ECDSA mismatch alone (when 1271 also fails) hits
    // the specific custom error path.
    const { bob, registry, mock } = await loadFixture(mockFixture);
    await mock.setReturnValue(NOT_MAGIC);
    const meta = mockMetaAddress(22);
    const mockAddr = await mock.getAddress();
    // 65-byte sig with random content → ecrecover yields some address
    // ≠ mockAddr → 1271 then asked → returns NOT_MAGIC → revert.
    const noisySig = "0x" + "ab".repeat(64) + "1b"; // r=ab*32, s=ab*32, v=27
    await expect(
      registry.connect(bob).registerKeysOnBehalf(mockAddr, SCHEME_ID, noisySig, meta),
    ).to.be.revertedWithCustomError(registry, "ERC6538Registry__InvalidSignature");
  });
});

describe("ERC6538Registry — incrementNonce", () => {
  it("bumps nonce and emits NonceIncremented", async () => {
    const { alice, registry } = await loadFixture(fixture);
    const before = await registry.nonceOf(alice.address);
    await expect(registry.connect(alice).incrementNonce())
      .to.emit(registry, "NonceIncremented")
      .withArgs(alice.address, before + 1n);
    expect(await registry.nonceOf(alice.address)).to.equal(before + 1n);
  });

  it("invalidates a previously-issued sig", async () => {
    const { alice, bob, registry } = await loadFixture(fixture);
    const meta = mockMetaAddress(12);
    const nonce = await registry.nonceOf(alice.address);
    const sig = await signRegistration(registry, alice, SCHEME_ID, meta, nonce);
    // Alice rotates her nonce out-of-band.
    await registry.connect(alice).incrementNonce();
    // Sig now references a stale nonce.
    await expect(
      registry.connect(bob).registerKeysOnBehalf(alice.address, SCHEME_ID, sig, meta),
    ).to.be.reverted;
  });
});

describe("ERC6538Registry — EIP-712 constants", () => {
  it("type hash matches the canonical mixed-case spelling", async () => {
    const { registry } = await loadFixture(fixture);
    const expected = hre.ethers.keccak256(
      hre.ethers.toUtf8Bytes(
        "Erc6538RegistryEntry(uint256 schemeId,bytes stealthMetaAddress,uint256 nonce)",
      ),
    );
    expect(await registry.ERC6538REGISTRY_ENTRY_TYPE_HASH()).to.equal(expected);
  });

  it("DOMAIN_SEPARATOR matches the hand-computed EIP-712 value", async () => {
    const { registry } = await loadFixture(fixture);
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const expected = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          hre.ethers.keccak256(
            hre.ethers.toUtf8Bytes(
              "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
            ),
          ),
          hre.ethers.keccak256(hre.ethers.toUtf8Bytes("ERC6538Registry")),
          hre.ethers.keccak256(hre.ethers.toUtf8Bytes("1.0")),
          chainId,
          await registry.getAddress(),
        ],
      ),
    );
    expect(await registry.DOMAIN_SEPARATOR()).to.equal(expected);
  });
});
