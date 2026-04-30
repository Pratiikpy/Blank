// Phase 9 — closed-loop self-test for ERC-5564 scheme 1 stealth crypto.
//
// No public vectors exist for the EIP. Strategy: drive sender + recipient
// + privkey-recovery through three INDEPENDENT code paths and assert
// they all converge on the same stealth address. If any one path is
// wrong, convergence breaks — so all three agreeing is strong evidence
// that the math matches the canonical reference (Nerolation's Python
// notebook + Fluidkey's stealth-account-kit).

import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, getAddress } from "viem/utils";
import {
  parseMetaAddress,
  formatMetaAddress,
  metaAddressFromPrivKeys,
  generateStealthAddress,
  checkStealthAddress,
  computeStealthKey,
  encodeAnnouncementMetadata,
  ERC20_TRANSFER_SELECTOR,
  NATIVE_ETH_SELECTOR,
} from "./stealth";

// Deterministic test inputs. Spend = 3, view = 2 are tiny but VALID
// secp256k1 scalars (any nonzero scalar < n is a legal privkey). We use
// small values so any hand-derivation/debugging is tractable without
// changing the algorithm under test.
const SPEND_PRIV = "0x0000000000000000000000000000000000000000000000000000000000000003" as const;
const VIEW_PRIV = "0x0000000000000000000000000000000000000000000000000000000000000002" as const;
const EPHEMERAL_PRIV = "0xd952fe0740d9d14011fc8ead3ab7de3c739d3aa93ce9254c10b0134d80d26a30" as const;

function ethereumAddressFromPrivKey(priv: `0x${string}`): string {
  // Independent address derivation — does NOT go through stealth.ts.
  // If stealth.ts's address-derivation is wrong, this path will diverge
  // and the closed-loop test will fail.
  const pub = secp256k1.getPublicKey(hexToBytes(priv), false); // uncompressed, 65 bytes
  // Drop 0x04 prefix → keccak → last 20 bytes.
  const xy = pub.slice(1);
  const hash = keccak_256(xy);
  return getAddress("0x" + bytesToHex(hash.slice(12)).slice(2));
}

describe("parseMetaAddress / formatMetaAddress", () => {
  it("roundtrips a valid meta-address", () => {
    const { metaAddress, spendingPubKey, viewingPubKey } =
      metaAddressFromPrivKeys({ spendingPrivateKey: SPEND_PRIV, viewingPrivateKey: VIEW_PRIV });

    const parsed = parseMetaAddress(metaAddress);
    expect(parsed.spendingPubKey).toBe(spendingPubKey);
    expect(parsed.viewingPubKey).toBe(viewingPubKey);

    const reformatted = formatMetaAddress(parsed);
    expect(reformatted).toBe(metaAddress);
  });

  it("rejects missing 'st:eth:0x' prefix", () => {
    expect(() => parseMetaAddress("0xabcd")).toThrow(/must start with/);
  });

  it("rejects wrong-length payload", () => {
    expect(() => parseMetaAddress("st:eth:0xdeadbeef")).toThrow(/132 hex chars/);
  });

  it("rejects non-hex payload", () => {
    const bad = "st:eth:0x" + "z".repeat(132);
    expect(() => parseMetaAddress(bad)).toThrow(/must be hex/);
  });

  it("rejects an invalid compressed-pubkey prefix byte", () => {
    // Replace the spending pubkey's prefix (first 2 hex chars) with 0x05
    // — only 0x02 / 0x03 are legal for compressed secp256k1.
    const { metaAddress } = metaAddressFromPrivKeys({
      spendingPrivateKey: SPEND_PRIV,
      viewingPrivateKey: VIEW_PRIV,
    });
    const corrupted = "st:eth:0x05" + metaAddress.slice("st:eth:0x".length + 2);
    expect(() => parseMetaAddress(corrupted)).toThrow(/prefix must be 0x02 or 0x03/);
  });
});

describe("generateStealthAddress", () => {
  it("is deterministic for a fixed ephemeral private key", () => {
    const { metaAddress } = metaAddressFromPrivKeys({
      spendingPrivateKey: SPEND_PRIV,
      viewingPrivateKey: VIEW_PRIV,
    });
    const a = generateStealthAddress({ metaAddress, ephemeralPrivateKey: EPHEMERAL_PRIV });
    const b = generateStealthAddress({ metaAddress, ephemeralPrivateKey: EPHEMERAL_PRIV });
    expect(a.stealthAddress).toBe(b.stealthAddress);
    expect(a.ephemeralPublicKey).toBe(b.ephemeralPublicKey);
    expect(a.viewTag).toBe(b.viewTag);
  });

  it("returns a view tag in [0, 255]", () => {
    const { metaAddress } = metaAddressFromPrivKeys({
      spendingPrivateKey: SPEND_PRIV,
      viewingPrivateKey: VIEW_PRIV,
    });
    const { viewTag } = generateStealthAddress({ metaAddress, ephemeralPrivateKey: EPHEMERAL_PRIV });
    expect(Number.isInteger(viewTag)).toBe(true);
    expect(viewTag).toBeGreaterThanOrEqual(0);
    expect(viewTag).toBeLessThanOrEqual(255);
  });
});

describe("closed-loop self-test (sender ↔ recipient ↔ privkey recovery)", () => {
  it("recipient detects a payment that sender announced", () => {
    const { metaAddress, spendingPubKey } = metaAddressFromPrivKeys({
      spendingPrivateKey: SPEND_PRIV,
      viewingPrivateKey: VIEW_PRIV,
    });

    // Sender side:
    const { stealthAddress, ephemeralPublicKey, viewTag } = generateStealthAddress({
      metaAddress,
      ephemeralPrivateKey: EPHEMERAL_PRIV,
    });

    // Recipient side — only viewing privkey available (the "watching" role):
    const isMine = checkStealthAddress({
      announcedStealthAddress: stealthAddress,
      ephemeralPublicKey,
      viewingPrivateKey: VIEW_PRIV,
      spendingPublicKey: spendingPubKey,
      viewTag,
    });
    expect(isMine).toBe(true);
  });

  it("derived stealth privkey controls the stealth address", () => {
    const { metaAddress } = metaAddressFromPrivKeys({
      spendingPrivateKey: SPEND_PRIV,
      viewingPrivateKey: VIEW_PRIV,
    });
    const { stealthAddress, ephemeralPublicKey } = generateStealthAddress({
      metaAddress,
      ephemeralPrivateKey: EPHEMERAL_PRIV,
    });

    // Recipient with BOTH privkeys (the "spending" role):
    const stealthPriv = computeStealthKey({
      ephemeralPublicKey,
      viewingPrivateKey: VIEW_PRIV,
      spendingPrivateKey: SPEND_PRIV,
    });

    // Independent address derivation — uses raw @noble/curves directly,
    // NOT stealth.ts's helpers. If both paths agree, two implementations
    // of the address-from-pubkey rule converge.
    const derivedAddr = ethereumAddressFromPrivKey(stealthPriv);
    expect(derivedAddr.toLowerCase()).toBe(stealthAddress.toLowerCase());
  });
});

describe("negative cases — view tag and wrong recipient", () => {
  it("rejects when the view tag does not match", () => {
    const { metaAddress, spendingPubKey } = metaAddressFromPrivKeys({
      spendingPrivateKey: SPEND_PRIV,
      viewingPrivateKey: VIEW_PRIV,
    });
    const { stealthAddress, ephemeralPublicKey, viewTag } = generateStealthAddress({
      metaAddress,
      ephemeralPrivateKey: EPHEMERAL_PRIV,
    });

    const wrongTag = (viewTag ^ 0xff) & 0xff;
    const isMine = checkStealthAddress({
      announcedStealthAddress: stealthAddress,
      ephemeralPublicKey,
      viewingPrivateKey: VIEW_PRIV,
      spendingPublicKey: spendingPubKey,
      viewTag: wrongTag,
    });
    expect(isMine).toBe(false);
  });

  it("rejects when checked with a different recipient's viewing key (view-tag branch)", () => {
    // Recipient A is the intended recipient.
    const { metaAddress, spendingPubKey } = metaAddressFromPrivKeys({
      spendingPrivateKey: SPEND_PRIV,
      viewingPrivateKey: VIEW_PRIV,
    });
    const { stealthAddress, ephemeralPublicKey, viewTag } = generateStealthAddress({
      metaAddress,
      ephemeralPrivateKey: EPHEMERAL_PRIV,
    });

    // Recipient B tries to claim the announcement with their own viewing key.
    const otherViewingPriv =
      "0x0000000000000000000000000000000000000000000000000000000000000005" as const;
    const isMine = checkStealthAddress({
      announcedStealthAddress: stealthAddress,
      ephemeralPublicKey,
      viewingPrivateKey: otherViewingPriv,
      spendingPublicKey: spendingPubKey,
      viewTag,
    });
    expect(isMine).toBe(false);
  });

  it("rejects via address-comparison fallback even when view tag collides", () => {
    // The view-tag fast filter rejects ~255/256 wrong recipients
    // immediately. The full address-comparison branch is the safety net
    // for the 1/256 collision case. To prove that branch actually
    // rejects (rather than passing because the fast filter already did),
    // we deterministically search for a wrong viewing privkey whose
    // ECDH with the same ephemeral pubkey produces a colliding view tag,
    // then assert the address comparison still says "not yours".
    const { metaAddress, spendingPubKey } = metaAddressFromPrivKeys({
      spendingPrivateKey: SPEND_PRIV,
      viewingPrivateKey: VIEW_PRIV,
    });
    const { stealthAddress, ephemeralPublicKey, viewTag } = generateStealthAddress({
      metaAddress,
      ephemeralPrivateKey: EPHEMERAL_PRIV,
    });

    // Search for a colliding wrong-viewing-priv. With a uniform 1/256
    // collision rate, an exhaustive scan of the first ~1500 candidates
    // finds one with overwhelming probability (and the search is
    // deterministic, so the test is reproducible). Skip 2 (the right
    // privkey) — including it would bias the test.
    let collidingPriv: `0x${string}` | null = null;
    for (let i = 3; i < 1500; i++) {
      const candidate = ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;
      const wouldMatch = checkStealthAddress({
        announcedStealthAddress: stealthAddress,
        ephemeralPublicKey,
        viewingPrivateKey: candidate,
        spendingPublicKey: spendingPubKey,
        viewTag,
      });
      // Re-derive view tag with this candidate to detect a collision
      // independently of checkStealthAddress's verdict.
      const candidateSh = sharedSecretHashViaCandidate(candidate, ephemeralPublicKey);
      if (candidateSh[0] === viewTag) {
        // View tag collided — this is the case we want to test.
        // checkStealthAddress must STILL return false because the full
        // address-comparison branch should reject.
        expect(wouldMatch).toBe(false);
        collidingPriv = candidate;
        break;
      }
    }
    expect(collidingPriv).not.toBeNull();
  });
});

/**
 * Independent re-implementation of `s_h = keccak256(X || Y)` for the
 * test only. Mirrors stealth.ts's `sharedSecretHash` so the test can
 * detect a view-tag collision without relying on the function under
 * test to report it.
 */
function sharedSecretHashViaCandidate(
  privKey: `0x${string}`,
  ephPub: `0x${string}`,
): Uint8Array {
  const ephPoint = secp256k1.Point.fromHex(ephPub.slice(2));
  const scalar = bigIntFromHex(privKey);
  const shared = ephPoint.multiply(scalar).toAffine();
  const xy = new Uint8Array(64);
  xy.set(int32Bytes(shared.x), 0);
  xy.set(int32Bytes(shared.y), 32);
  return keccak_256(xy);
}

function bigIntFromHex(h: `0x${string}`): bigint {
  return BigInt(h);
}

function int32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

describe("encodeAnnouncementMetadata (EIP-5564 §metadata)", () => {
  // Spec layout (57 bytes): [viewTag(1) | selector(4) | token(20) | amount(32)]
  const TEST_TOKEN = "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68" as `0x${string}`;

  it("produces the documented ERC-20 transfer layout", () => {
    const md = encodeAnnouncementMetadata({
      viewTag: 0xab,
      token: TEST_TOKEN,
      amount: 100_000000n, // 100 USDC at 6 decimals
    });
    // Strip 0x, length 57 bytes = 114 hex chars.
    const hex = md.slice(2);
    expect(hex.length).toBe(114);
    // Byte 0 — view tag.
    expect(hex.slice(0, 2)).toBe("ab");
    // Bytes 1-4 — function selector defaults to ERC-20 transfer.
    expect(`0x${hex.slice(2, 10)}`).toBe(ERC20_TRANSFER_SELECTOR);
    // Bytes 5-24 — token address (20 bytes / 40 hex).
    expect(`0x${hex.slice(10, 50)}`.toLowerCase()).toBe(TEST_TOKEN.toLowerCase());
    // Bytes 25-56 — amount (32 bytes / 64 hex), big-endian.
    const amountHex = hex.slice(50, 114);
    expect(BigInt(`0x${amountHex}`)).toBe(100_000000n);
  });

  it("supports the native-ETH sentinel selector", () => {
    const md = encodeAnnouncementMetadata({
      viewTag: 0,
      functionSelector: NATIVE_ETH_SELECTOR,
      token: "0x0000000000000000000000000000000000000000",
      amount: 1n,
    });
    const hex = md.slice(2);
    expect(`0x${hex.slice(2, 10)}`).toBe(NATIVE_ETH_SELECTOR);
  });

  it("rejects out-of-range view tag", () => {
    expect(() =>
      encodeAnnouncementMetadata({ viewTag: 256, token: TEST_TOKEN, amount: 1n }),
    ).toThrow(/viewTag must be an integer in/);
    expect(() =>
      encodeAnnouncementMetadata({ viewTag: -1, token: TEST_TOKEN, amount: 1n }),
    ).toThrow(/viewTag must be an integer in/);
    expect(() =>
      encodeAnnouncementMetadata({ viewTag: 1.5, token: TEST_TOKEN, amount: 1n }),
    ).toThrow(/viewTag must be an integer in/);
  });

  it("rejects negative amount", () => {
    expect(() =>
      encodeAnnouncementMetadata({ viewTag: 0, token: TEST_TOKEN, amount: -1n }),
    ).toThrow(/amount must be non-negative/);
  });

  it("rejects non-4-byte function selector", () => {
    expect(() =>
      encodeAnnouncementMetadata({
        viewTag: 0,
        functionSelector: "0xabcd" as `0x${string}`,
        token: TEST_TOKEN,
        amount: 1n,
      }),
    ).toThrow(/functionSelector must be 4 bytes/);
  });

  it("encodes max uint256 amount (boundary)", () => {
    const max = (1n << 256n) - 1n;
    const md = encodeAnnouncementMetadata({
      viewTag: 0xff,
      token: TEST_TOKEN,
      amount: max,
    });
    const amountHex = md.slice(2).slice(50);
    expect(BigInt(`0x${amountHex}`)).toBe(max);
  });
});
