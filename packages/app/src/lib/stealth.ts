// Phase 9 — ERC-5564 stealth meta-addresses, scheme 1 (secp256k1 + view tag).
//
// CRITICAL implementation notes (verified against EIP-5564 + Vitalik /
// Nerolation's reference Python notebook + the official reference
// `ERC5564Announcer.sol`):
//
//   1. Hash function is keccak256, NOT sha256. The spec writes "h()"
//      ambiguously; the reference code is keccak.
//   2. Shared-secret hashing input is the 64-byte (X || Y) representation
//      of the ECDH point — NOT the 33-byte compressed form. ScopeLift's
//      stealth-address-sdk hashes the compressed form and produces
//      addresses that don't interoperate with canonical implementations.
//      WE MATCH THE REFERENCE.
//   3. View tag = first byte (most-significant) of keccak(X || Y).
//   4. Stealth privkey: `(spendingPriv + s_h) mod n` where n is the
//      secp256k1 curve order. The sum can overflow; mod-reduce explicitly.
//   5. Stealth address: standard Ethereum derivation =
//      `last 20 bytes of keccak256(uncompressed_pubkey_without_0x04_prefix)`.
//   6. Compressed pubkey prefix MUST be 0x02 or 0x03. Reject anything else.
//
// Test strategy (no published vectors exist in the EIP):
//   Closed-loop self-test in `lib/stealth.test.ts` — sender derives
//   stealth address + viewTag; recipient with viewing privkey runs
//   checkStealthAddress (boolean true); recipient with both privkeys
//   runs computeStealthKey to recover the stealth privkey, then derives
//   the address from that privkey, asserts it matches what the sender
//   produced. Three independent code paths agreeing = correctness.

// @noble/curves@2.x uses ESM `.js` extensions in its exports map.
// `@noble/curves/secp256k1` (no .js) doesn't resolve under bundler
// moduleResolution; use the explicit `.js` form which IS exported.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "viem/utils";
import { type Address } from "viem";

/** Compressed secp256k1 pubkey — 33 bytes (1 prefix + 32 X-coord). */
export type CompressedPubKey = `0x${string}`;

/** ERC-5564 stealth meta-address. Format: `st:eth:0x<spend><view>` where
 *  each pubkey is a 33-byte compressed secp256k1 point (66 hex chars).
 *  Total length: `st:eth:0x` + 132 hex = 141 chars. */
export type StealthMetaAddress = `st:eth:0x${string}`;

/** Address-derivation helper: ethereum address from an uncompressed
 *  pubkey. Per spec, the input MUST NOT include the 0x04 leading byte —
 *  it's keccak256(X || Y), then last 20 bytes. */
function addressFromUncompressedXY(uncompressedXY: Uint8Array): Address {
  if (uncompressedXY.length !== 64) {
    throw new Error("Stealth: uncompressed point must be 64 bytes (X||Y)");
  }
  const hash = keccak_256(uncompressedXY);
  // Last 20 bytes → checksummed address.
  const addr = ("0x" + bytesToHex(hash.slice(12)).slice(2)) as Address;
  return addr;
}

/** Validate a compressed pubkey: 33 bytes, prefix 0x02 or 0x03. */
function assertCompressed(pub: Uint8Array): void {
  if (pub.length !== 33) {
    throw new Error(`Stealth: compressed pubkey must be 33 bytes, got ${pub.length}`);
  }
  if (pub[0] !== 0x02 && pub[0] !== 0x03) {
    throw new Error(`Stealth: compressed pubkey prefix must be 0x02 or 0x03, got 0x${pub[0]?.toString(16)}`);
  }
}

/** Decode a stealth meta-address into its two compressed pubkeys.
 *  Throws on malformed input — caller catches + surfaces a friendly UI error. */
export function parseMetaAddress(meta: string): {
  spendingPubKey: CompressedPubKey;
  viewingPubKey: CompressedPubKey;
} {
  if (!meta.startsWith("st:eth:0x")) {
    throw new Error("Stealth: meta-address must start with 'st:eth:0x'");
  }
  const hex = meta.slice("st:eth:0x".length);
  if (hex.length !== 132) {
    throw new Error(`Stealth: meta-address payload must be 132 hex chars (132 = 2x33-byte compressed pubkeys), got ${hex.length}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("Stealth: meta-address payload must be hex");
  }
  const spendingHex = hex.slice(0, 66);
  const viewingHex = hex.slice(66);
  // Validate prefix bytes.
  assertCompressed(hexToBytes(`0x${spendingHex}`));
  assertCompressed(hexToBytes(`0x${viewingHex}`));
  return {
    spendingPubKey: `0x${spendingHex}` as CompressedPubKey,
    viewingPubKey: `0x${viewingHex}` as CompressedPubKey,
  };
}

/** Encode two compressed pubkeys into the canonical meta-address string. */
export function formatMetaAddress(args: {
  spendingPubKey: CompressedPubKey | Uint8Array;
  viewingPubKey: CompressedPubKey | Uint8Array;
}): StealthMetaAddress {
  const spend =
    typeof args.spendingPubKey === "string"
      ? hexToBytes(args.spendingPubKey)
      : args.spendingPubKey;
  const view =
    typeof args.viewingPubKey === "string"
      ? hexToBytes(args.viewingPubKey)
      : args.viewingPubKey;
  assertCompressed(spend);
  assertCompressed(view);
  return `st:eth:0x${bytesToHex(spend).slice(2)}${bytesToHex(view).slice(2)}` as StealthMetaAddress;
}

/** Derive a public meta-address from two private keys (e.g. a fresh
 *  recipient setting up their stealth identity). Both privkeys are
 *  32-byte hex; the function returns the compressed pubkeys + the
 *  meta-address string. */
export function metaAddressFromPrivKeys(args: {
  spendingPrivateKey: `0x${string}`;
  viewingPrivateKey: `0x${string}`;
}): {
  spendingPubKey: CompressedPubKey;
  viewingPubKey: CompressedPubKey;
  metaAddress: StealthMetaAddress;
} {
  const spendBytes = hexToBytes(args.spendingPrivateKey);
  const viewBytes = hexToBytes(args.viewingPrivateKey);
  const spendingPub = secp256k1.getPublicKey(spendBytes, true);
  const viewingPub = secp256k1.getPublicKey(viewBytes, true);
  return {
    spendingPubKey: bytesToHex(spendingPub) as CompressedPubKey,
    viewingPubKey: bytesToHex(viewingPub) as CompressedPubKey,
    metaAddress: formatMetaAddress({
      spendingPubKey: spendingPub,
      viewingPubKey: viewingPub,
    }),
  };
}

/** Hash the ECDH shared point per the canonical algorithm:
 *  `s_h = keccak256(Q.x || Q.y)` where Q.x and Q.y are the 32-byte
 *  big-endian coordinates of the ECDH-derived point Q. */
function sharedSecretHash(sharedPoint: { x: bigint; y: bigint }): Uint8Array {
  const xBytes = bigIntTo32Bytes(sharedPoint.x);
  const yBytes = bigIntTo32Bytes(sharedPoint.y);
  const concat = new Uint8Array(64);
  concat.set(xBytes, 0);
  concat.set(yBytes, 32);
  return keccak_256(concat);
}

function bigIntTo32Bytes(n: bigint): Uint8Array {
  // Big-endian 32-byte representation of an unsigned bigint < 2^256.
  // (negatives shouldn't appear; the `secp256k1` curve always returns
  //  affine coords in the field [0, p).) Defensive: any caller that
  //  passes an unreduced value gets a loud failure instead of a silently
  //  truncated low-256-bit slice — silently-wrong crypto is the worst
  //  kind of crypto.
  if (n < 0n) {
    throw new Error("Stealth: bigIntTo32Bytes refuses a negative value");
  }
  const out = new Uint8Array(32);
  let i = 31;
  let v = n;
  while (v > 0n && i >= 0) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
    i--;
  }
  if (v > 0n) {
    throw new Error("Stealth: bigIntTo32Bytes input exceeds 32 bytes — caller forgot to reduce mod n");
  }
  return out;
}

const SECP256K1_N = secp256k1.Point.Fn.ORDER;

/** Sender-side derivation: given a recipient's meta-address, generate
 *  a fresh ephemeral keypair, compute the stealth address and view tag.
 *  The caller must announce `(schemeId=1, stealthAddress, ephemeralPubKey,
 *  metadata = [viewTag, ...])` via ERC5564Announcer.
 *
 *  @param metaAddress Recipient's stealth meta-address.
 *  @param ephemeralPrivateKey Optional 32-byte hex; if omitted, generated.
 *                              Override is exposed for deterministic tests. */
export function generateStealthAddress(args: {
  metaAddress: StealthMetaAddress;
  ephemeralPrivateKey?: `0x${string}`;
}): {
  stealthAddress: Address;
  ephemeralPublicKey: CompressedPubKey;
  viewTag: number;
} {
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(args.metaAddress);

  // 1. Ephemeral keypair.
  const ephemeralPriv = args.ephemeralPrivateKey
    ? hexToBytes(args.ephemeralPrivateKey)
    : secp256k1.utils.randomSecretKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true);

  // 2. ECDH point Q = ephemeralPriv * viewingPub. We DON'T use
  //    `getSharedSecret` because (a) v2 of @noble/curves no longer
  //    exposes that helper directly and (b) we need the full point
  //    (X and Y) to hash, not the SDK's truncated/encoded form.
  const viewingPubPoint = secp256k1.Point.fromHex(bytesToHex(hexToBytes(viewingPubKey)).slice(2));
  // BigInt scalar — `secp256k1.utils.normPrivateKeyToScalar` validates
  // the privkey is in [1, n-1] and returns it as a bigint scalar.
  const ephemeralScalar = bytesToBigInt(ephemeralPriv);
  const sharedPoint = viewingPubPoint.multiply(ephemeralScalar);
  const sharedAffine = sharedPoint.toAffine();

  // 3. s_h = keccak256(X || Y). View tag = s_h[0].
  const sH = sharedSecretHash(sharedAffine);
  const viewTag = sH[0]!;

  // 4. P_stealth = K_spend + s_h * G.
  const spendingPubPoint = secp256k1.Point.fromHex(bytesToHex(hexToBytes(spendingPubKey)).slice(2));
  const sHScalar = bytesToBigInt(sH) % SECP256K1_N;
  const stealthPoint = spendingPubPoint.add(secp256k1.Point.BASE.multiply(sHScalar));
  const stealthAffine = stealthPoint.toAffine();

  // 5. Stealth address = ethereum-derive from uncompressed (X||Y).
  const xy = new Uint8Array(64);
  xy.set(bigIntTo32Bytes(stealthAffine.x), 0);
  xy.set(bigIntTo32Bytes(stealthAffine.y), 32);
  const stealthAddress = addressFromUncompressedXY(xy);

  return {
    stealthAddress,
    ephemeralPublicKey: bytesToHex(ephemeralPub) as CompressedPubKey,
    viewTag,
  };
}

/** Recipient-side fast filter: given an Announcement event, the
 *  recipient's viewing private key, and their spending pubkey, return
 *  whether this announcement was for them. View-tag check short-circuits
 *  the (more expensive) point-add for ~99.6% of irrelevant announcements
 *  (1 in 256 false positives by design — view tag is 1 byte). */
export function checkStealthAddress(args: {
  announcedStealthAddress: Address;
  ephemeralPublicKey: CompressedPubKey;
  viewingPrivateKey: `0x${string}`;
  spendingPublicKey: CompressedPubKey;
  /** First byte of metadata, per scheme 1. */
  viewTag: number;
}): boolean {
  const ephPubBytes = hexToBytes(args.ephemeralPublicKey);
  assertCompressed(ephPubBytes);

  const viewPrivBytes = hexToBytes(args.viewingPrivateKey);
  if (viewPrivBytes.length !== 32) {
    throw new Error("Stealth: viewing private key must be 32 bytes");
  }

  // Q = viewingPriv * ephemeralPub
  const ephPubPoint = secp256k1.Point.fromHex(bytesToHex(ephPubBytes).slice(2));
  const viewScalar = bytesToBigInt(viewPrivBytes);
  const sharedPoint = ephPubPoint.multiply(viewScalar);
  const sharedAffine = sharedPoint.toAffine();
  const sH = sharedSecretHash(sharedAffine);

  // View-tag fast filter.
  if (sH[0] !== args.viewTag) return false;

  // Full check: derive stealth address and compare.
  const spendBytes = hexToBytes(args.spendingPublicKey);
  assertCompressed(spendBytes);
  const spendPoint = secp256k1.Point.fromHex(bytesToHex(spendBytes).slice(2));
  const sHScalar = bytesToBigInt(sH) % SECP256K1_N;
  const stealthPoint = spendPoint.add(secp256k1.Point.BASE.multiply(sHScalar));
  const stealthAffine = stealthPoint.toAffine();
  const xy = new Uint8Array(64);
  xy.set(bigIntTo32Bytes(stealthAffine.x), 0);
  xy.set(bigIntTo32Bytes(stealthAffine.y), 32);
  return addressFromUncompressedXY(xy).toLowerCase() === args.announcedStealthAddress.toLowerCase();
}

/** Recover the stealth private key for sweeping funds out. Caller MUST
 *  have already confirmed the announcement is theirs via
 *  `checkStealthAddress`. The returned key is 32-byte hex; treat it as a
 *  one-time-use secret (never store it). */
export function computeStealthKey(args: {
  ephemeralPublicKey: CompressedPubKey;
  viewingPrivateKey: `0x${string}`;
  spendingPrivateKey: `0x${string}`;
}): `0x${string}` {
  const ephPubBytes = hexToBytes(args.ephemeralPublicKey);
  assertCompressed(ephPubBytes);
  const viewPrivBytes = hexToBytes(args.viewingPrivateKey);
  const spendPrivBytes = hexToBytes(args.spendingPrivateKey);

  // Q = viewingPriv * ephemeralPub.
  const ephPubPoint = secp256k1.Point.fromHex(bytesToHex(ephPubBytes).slice(2));
  const viewScalar = bytesToBigInt(viewPrivBytes);
  const sharedPoint = ephPubPoint.multiply(viewScalar);
  const sharedAffine = sharedPoint.toAffine();
  const sH = sharedSecretHash(sharedAffine);

  // p_stealth = (spendingPriv + s_h) mod n.
  const spendScalar = bytesToBigInt(spendPrivBytes);
  const sHScalar = bytesToBigInt(sH);
  const stealthScalar = (spendScalar + sHScalar) % SECP256K1_N;
  if (stealthScalar === 0n) {
    // Astronomically unlikely (~1/n), but mathematically possible.
    // A zero scalar is an invalid private key.
    throw new Error("Stealth: derived private key is zero — re-run announcement");
  }
  const out = bigIntTo32Bytes(stealthScalar);
  return bytesToHex(out) as `0x${string}`;
}

function bytesToBigInt(b: Uint8Array): bigint {
  let result = 0n;
  for (const byte of b) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

// ─── EIP-5564 §"Announcement metadata" layout ────────────────────────
//
// Per the spec, the `metadata` bytes argument to ERC5564Announcer.announce
// for an ERC-20 / ERC-721 transfer is:
//
//   byte  0       view tag (first byte of keccak256(shared_secret))
//   bytes 1-4     function selector (4 bytes) — `transfer(address,uint256)` =
//                 `0xa9059cbb` for ERC-20, or `0xeeeeeeee` for native ETH
//   bytes 5-24    token address (20 bytes)
//   bytes 25-56   amount (uint256, 32 bytes) — for ERC-20, the raw amount;
//                 for ERC-721, the tokenId.
//
// Total: 57 bytes. Recipients use byte 0 for the view-tag fast filter,
// then bytes 1-56 to know which token + how much landed, so they can
// decide whether the sweep is worth the gas.
//
// The "native ETH" sentinel `0xeeeeeeee` is from EIP-5564 §metadata; we
// expose it for the future native-ETH stealth flow but currently only
// emit ERC-20 announcements.

export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb" as `0x${string}`;
export const NATIVE_ETH_SELECTOR = "0xeeeeeeee" as `0x${string}`;

export function encodeAnnouncementMetadata(args: {
  /** First byte of keccak256(shared_secret) — recipient's fast-filter. */
  viewTag: number;
  /** 4-byte function selector. Use `ERC20_TRANSFER_SELECTOR` for ERC-20
   *  transfers, `NATIVE_ETH_SELECTOR` for native ETH. */
  functionSelector?: `0x${string}`;
  /** Token contract address (20 bytes). Pass `0x0…0` for native ETH. */
  token: Address;
  /** Amount (ERC-20) or tokenId (ERC-721) — uint256, big-endian. */
  amount: bigint;
}): `0x${string}` {
  if (args.viewTag < 0 || args.viewTag > 255 || !Number.isInteger(args.viewTag)) {
    throw new Error(`Stealth: viewTag must be an integer in [0, 255], got ${args.viewTag}`);
  }
  if (args.amount < 0n) {
    throw new Error("Stealth: amount must be non-negative");
  }
  const selector = args.functionSelector ?? ERC20_TRANSFER_SELECTOR;
  const selBytes = hexToBytes(selector);
  if (selBytes.length !== 4) {
    throw new Error(`Stealth: functionSelector must be 4 bytes, got ${selBytes.length}`);
  }
  const tokenBytes = hexToBytes(args.token);
  if (tokenBytes.length !== 20) {
    throw new Error(`Stealth: token must be a 20-byte address, got ${tokenBytes.length} bytes`);
  }
  const amountBytes = bigIntTo32Bytes(args.amount);

  const out = new Uint8Array(1 + 4 + 20 + 32);
  out[0] = args.viewTag;
  out.set(selBytes, 1);
  out.set(tokenBytes, 5);
  out.set(amountBytes, 25);
  return bytesToHex(out) as `0x${string}`;
}
