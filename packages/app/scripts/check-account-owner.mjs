import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
const ACCOUNT = "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f";
const c = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const abi = parseAbi(["function ownerX() view returns (uint256)", "function ownerY() view returns (uint256)"]);
const x = await c.readContract({ address: ACCOUNT, abi, functionName: "ownerX" });
const y = await c.readContract({ address: ACCOUNT, abi, functionName: "ownerY" });
console.log("Account ownerX:", "0x" + x.toString(16).padStart(64, "0"));
console.log("Account ownerY:", "0x" + y.toString(16).padStart(64, "0"));

// Check low-s
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const halfN = N >> 1n;
const s = 0x17cdf764e53aa97bf4d6d440b6ca23d3b1ef6b2c2c03508adc56a19b433b9782n;
console.log("\ns is low-s:", s <= halfN);
console.log("s:    ", s.toString(16));
console.log("halfN:", halfN.toString(16));

// Also try the precompile directly
console.log("\nCalling RIP-7212 precompile directly with userOpHash + sig + pubkey...");
const PRE = "0x0000000000000000000000000000000000000100";
const hash = "0x94520bb8ae051ecd1a2d6892218d3e33cd41705121dcb0fc0c9067c0d204c1b6";
const r = "0x8f8d5a6235597577cb64ea3ab5df26efacac8cebd7f924efe89855577983c132";
const sHex = "0x17cdf764e53aa97bf4d6d440b6ca23d3b1ef6b2c2c03508adc56a19b433b9782";
const result = await c.call({
  to: PRE,
  data: hash + r.slice(2) + sHex.slice(2) + x.toString(16).padStart(64, "0") + y.toString(16).padStart(64, "0"),
});
console.log("Precompile returned:", result.data || "EMPTY");
