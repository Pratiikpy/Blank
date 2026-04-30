import { p256 } from "@noble/curves/nist.js";
import { webcrypto } from "node:crypto";
const subtle = webcrypto.subtle;

// Same priv as our test
const seedBytes = new TextEncoder().encode("phase2-test-passkey-seed-1");
const priv = new Uint8Array(32);
for (let i = 0; i < seedBytes.length; i++) priv[i % 32] ^= seedBytes[i];
for (let i = 0; i < 32; i++) if (priv[i] === 0) priv[i] = (i + 1) & 0xff;

const pub = p256.getPublicKey(priv, false);

const hashHex = "94520bb8ae051ecd1a2d6892218d3e33cd41705121dcb0fc0c9067c0d204c1b6";
const hashBytes = new Uint8Array(32);
for (let i = 0; i < 32; i++) hashBytes[i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);

// Noble sig
const nobleSig = p256.sign(hashBytes, priv);
console.log("Noble sig (64B):", Buffer.from(nobleSig).toString("hex"));
console.log("Noble verify:", p256.verify(nobleSig, hashBytes, pub));

// WebCrypto verify of noble sig
const pubKey = await subtle.importKey(
  "raw",
  pub,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["verify"],
);
// WebCrypto verify expects (sig, hashed-data) where sig is r||s and data is the
// PRE-IMAGE that gets SHA-256 hashed internally. Since we already have the
// digest, we can't use verify() directly. Need crypto.verify or low-level.
// Alternative: use SubtleCrypto.verify with the data as the hash and skip hashing
// — but SubtleCrypto always hashes. So we have to find another way.

// Use noble to verify the same sig — explicitly with prehash flag variants
console.log("\nNoble verify variants:");
console.log("  verify(sig, hash, pub):       ", p256.verify(nobleSig, hashBytes, pub));
try { console.log("  verify(sig, hash, pub, {prehash:false}):", p256.verify(nobleSig, hashBytes, pub, { prehash: false })); } catch (e) { console.log("err:", e.message); }
try { console.log("  verify(sig, hash, pub, {prehash:true}):", p256.verify(nobleSig, hashBytes, pub, { prehash: true })); } catch (e) { console.log("err:", e.message); }

// Check EIP-2 normalization
import { sha256 } from "@noble/hashes/sha2.js";
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const halfN = N >> 1n;
const r = BigInt("0x" + Buffer.from(nobleSig.slice(0, 32)).toString("hex"));
const s = BigInt("0x" + Buffer.from(nobleSig.slice(32, 64)).toString("hex"));
console.log("\nr:", r);
console.log("s:", s);
console.log("s <= halfN (low-s):", s <= halfN);
