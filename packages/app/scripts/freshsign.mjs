import { p256 } from "@noble/curves/nist.js";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// Same priv key as setup
const seedBytes = new TextEncoder().encode("phase2-test-passkey-seed-1");
const priv = new Uint8Array(32);
for (let i = 0; i < seedBytes.length; i++) priv[i % 32] ^= seedBytes[i];
for (let i = 0; i < 32; i++) if (priv[i] === 0) priv[i] = (i + 1) & 0xff;

const pub = p256.getPublicKey(priv, false);
console.log("pubX:", "0x" + Buffer.from(pub.slice(1, 33)).toString("hex"));

// userOpHash from earlier
const hashHex = "94520bb8ae051ecd1a2d6892218d3e33cd41705121dcb0fc0c9067c0d204c1b6";
const hashBytes = new Uint8Array(32);
for (let i = 0; i < 32; i++) hashBytes[i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);

// Sign FRESH (every sign produces a different sig due to random k)
const sig = p256.sign(hashBytes, priv);
const r = Buffer.from(sig.slice(0, 32)).toString("hex");
const s = Buffer.from(sig.slice(32, 64)).toString("hex");
console.log("Fresh sig r:", r);
console.log("Fresh sig s:", s);

// Verify locally
console.log("Local verify:", p256.verify(sig, hashBytes, pub));

// Try precompile
const c = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const result = await c.call({
  to: "0x0000000000000000000000000000000000000100",
  data: ("0x" + hashHex + r + s + Buffer.from(pub.slice(1, 33)).toString("hex") + Buffer.from(pub.slice(33, 65)).toString("hex")),
});
console.log("RIP-7212 returned:", result.data || "EMPTY");
