import { describe, it, expect } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha256Hex, verifyP256 } from "./passkey";

// §15.x lib test for the pure passkey helpers (sha256Hex +
// verifyP256). These run in the e2e test path to prove signature
// encoding round-trips before committing to an on-chain verifier
// call. Pin the bit-exact behavior so a refactor can't silently
// break the round-trip.

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

describe("sha256Hex", () => {
  it("hashes a string to a 32-byte 0x-hex digest", () => {
    const out = sha256Hex("hello");
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
    // Match the canonical sha256 of the UTF-8 bytes of "hello".
    expect(out.slice(2)).toBe(bytesToHex(sha256(new TextEncoder().encode("hello"))));
  });

  it("hashes raw bytes equivalently", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(sha256Hex(bytes)).toBe(sha256Hex("hello"));
  });

  it("is deterministic + collision-free across distinct inputs", () => {
    const a = sha256Hex("hello");
    const b = sha256Hex("world");
    expect(a).not.toBe(b);
    expect(sha256Hex("hello")).toBe(a);
  });
});

describe("verifyP256", () => {
  // Generate a deterministic-ish keypair + signature for the round-trip.
  // p256 from @noble/curves uses RFC 6979 deterministic-k by default so
  // signing the same hash with the same key produces the same (r, s).
  const PRIV = new Uint8Array(32).fill(7); // any 32-byte non-zero secret
  const pub = p256.getPublicKey(PRIV, false);
  // Uncompressed pub = 0x04 || X(32) || Y(32)
  const PUB_X = ("0x" + bytesToHex(pub.slice(1, 33))) as `0x${string}`;
  const PUB_Y = ("0x" + bytesToHex(pub.slice(33, 65))) as `0x${string}`;

  const HASH = sha256Hex("blank passkey test message");
  const HASH_BYTES = new Uint8Array(
    HASH.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
  );
  // Noble v2: p256.sign returns 64-byte (r||s) compact bytes when
  // prehash:false (matches passkey.ts signHash semantics).
  const sigBytes = p256.sign(HASH_BYTES, PRIV, { prehash: false });
  const R = ("0x" + bytesToHex(sigBytes.slice(0, 32))) as `0x${string}`;
  const S = ("0x" + bytesToHex(sigBytes.slice(32, 64))) as `0x${string}`;

  it("verifies a valid signature against the matching pubkey + hash", () => {
    expect(verifyP256(HASH, R, S, PUB_X, PUB_Y)).toBe(true);
  });

  it("rejects a signature that doesn't match the hash", () => {
    const wrongHash = sha256Hex("different message");
    expect(verifyP256(wrongHash, R, S, PUB_X, PUB_Y)).toBe(false);
  });

  it("rejects a signature against the wrong pubkey", () => {
    const otherPriv = new Uint8Array(32).fill(13);
    const otherPub = p256.getPublicKey(otherPriv, false);
    const otherX = ("0x" + bytesToHex(otherPub.slice(1, 33))) as `0x${string}`;
    const otherY = ("0x" + bytesToHex(otherPub.slice(33, 65))) as `0x${string}`;
    expect(verifyP256(HASH, R, S, otherX, otherY)).toBe(false);
  });

  it("rejects a tampered (r, s)", () => {
    // Flip the last byte of r → invalid signature.
    const tamperedR = (R.slice(0, -2) + "00") as `0x${string}`;
    expect(verifyP256(HASH, tamperedR, S, PUB_X, PUB_Y)).toBe(false);
  });
});
