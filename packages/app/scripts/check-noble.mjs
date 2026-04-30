import { p256 } from "@noble/curves/nist.js";
const priv = new Uint8Array(32).fill(1);
const msg = new Uint8Array(32).fill(2);
const sig = p256.sign(msg, priv);
console.log("Type:", typeof sig, sig.constructor?.name);
console.log("Has r:", typeof sig.r, "Has s:", typeof sig.s);
console.log("Has length:", sig.length);
console.log("Is Uint8Array:", sig instanceof Uint8Array);
if (sig.toCompactRawBytes) console.log("toCompactRawBytes:", Buffer.from(sig.toCompactRawBytes()).toString("hex"));
if (sig.toBytes) {
  try { console.log("toBytes(compact):", Buffer.from(sig.toBytes("compact")).toString("hex")); } catch (e) { console.log("toBytes err:", e.message); }
}
