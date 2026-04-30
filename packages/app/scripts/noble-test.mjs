import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
const priv = new Uint8Array(32).fill(1);
const msg = new Uint8Array(32).fill(2);

const sig1 = p256.sign(msg, priv);
console.log("sign default:", sig1.length, "bytes");

try { const s = p256.sign(msg, priv, { prehash: true }); console.log("sign({prehash:true}):", s.length); } catch (e) { console.log("prehash:true err:", e.message); }
try { const s = p256.sign(msg, priv, { prehash: false }); console.log("sign({prehash:false}):", s.length); } catch (e) { console.log("prehash:false err:", e.message); }

const pub = p256.getPublicKey(priv, false);
console.log("verify(sig, msg, pub):", p256.verify(sig1, msg, pub));
console.log("verify(sig, sha256(msg), pub):", p256.verify(sig1, sha256(msg), pub));
