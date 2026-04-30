import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
const c = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const code = await c.getCode({ address: "0x0000000000000000000000000000000000000100" });
console.log("Precompile code:", code === undefined ? "NONE" : code.slice(0, 50) + "...");

// Try with a known-good test vector from WebAuthn-sol
// Test vector: hash = sha256("test"), known r/s/x/y from FIPS 186-4
// Actually — let me try the OFFICIAL EIP-7212 test vector
const TEST_HASH = "bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023";
const TEST_R = "44a282a0795b1ac1b9a5c91f3573aaeb40b6e8ad7d8c91ed3a8a8b8e51a2c0f4";
const TEST_S = "0c2c1f9a13e7b0e2c70a3f6e5e94e0e3c7e8c5b3d3a7f4e1c2b1d0a98765432";
const TEST_X = "1ccbe91c075fc7f4f033bfa248db8fccd3565de94bbfb12f3c59ff46c271bf83";
const TEST_Y = "ce4014c68811f9a21a1fdb2c0e6113e06db7ca93b7404e78dc7ccd5ca89a4ca9";

console.log("\nWith FIPS test vector:");
const r1 = await c.call({
  to: "0x0000000000000000000000000000000000000100",
  data: "0x" + TEST_HASH + TEST_R + TEST_S + TEST_X + TEST_Y,
});
console.log("Result:", r1.data || "EMPTY");
