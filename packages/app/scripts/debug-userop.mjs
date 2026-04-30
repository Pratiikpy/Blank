// Replay the failed UserOp via simulateContract so EntryPoint's
// FailedOp(opIndex, reason) error is properly decoded.
import { createPublicClient, http, parseAbi, parseAbiParameters, encodeFunctionData, decodeErrorResult } from "viem";
import { baseSepolia } from "viem/chains";

const ENTRYPOINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const RELAYER = "0xb860513A3C5348C46cF52a573Fd743bA03c2c53F";

// The UserOp from the latest failed attempt — extracted from logs
const userOp = {
  sender: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f",
  nonce: 0n,
  // Account already deployed — no initCode
  initCode: "0x",
  callData: "0x47e1da2a000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000200000000000000000000000006377ef23b3464019ecf35528be6eb6d6d57d0b1a000000000000000000000000789f0bc466e172ed737493e9796a6d0a3ab0ff230000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000789f0bc466e172ed737493e9796a6d0a3ab0ff2300000000000000000000000000000000000000000000000000000000009896800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000245f0110f9000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000",
  // 2M verif, 2M call (account already deployed, no factory call needed)
  accountGasLimits: "0x000000000000000000000000001e8480000000000000000000000000001e8480",
  preVerificationGas: 100_000n,
  // 0.1 gwei priority, 1 gwei max → packed
  gasFees: ("0x" + (100_000_000n).toString(16).padStart(32, "0") + (1_000_000_000n).toString(16).padStart(32, "0")),
  paymasterAndData: "0xb1cbbd59e63d7ab0bbf0406ccf1016c1dd8e63de00000000000000000000000000030d40000000000000000000000000000186a00000000000000000000000000000000000000000000000000000000000000000",
  // Real sig from the failed test: r=0x8f8d5a..., s=0x17cdf764... abi-encoded
  // (32 bytes r || 32 bytes s = 64 bytes = abi.encode(uint256, uint256))
  signature: "0x8f8d5a6235597577cb64ea3ab5df26efacac8cebd7f924efe89855577983c13217cdf764e53aa97bf4d6d440b6ca23d3b1ef6b2c2c03508adc56a19b433b9782",
};

const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

const ENTRYPOINT_ABI = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);

console.log("Simulating handleOps([userOp], relayer)...");
console.log("  sender:", userOp.sender);
console.log("  nonce:", userOp.nonce);
console.log("  paymaster:", "0x" + userOp.paymasterAndData.slice(2, 42));

try {
  await client.simulateContract({
    address: ENTRYPOINT,
    abi: ENTRYPOINT_ABI,
    functionName: "handleOps",
    args: [[userOp], RELAYER],
    account: RELAYER,
  });
  console.log("✅ Simulation succeeded! UserOp would execute.");
} catch (err) {
  console.log("\n❌ Simulation reverted.");
  // viem unwraps structured errors automatically
  if (err.cause?.data) {
    console.log("  raw revert data:", err.cause.data);
    try {
      const decoded = decodeErrorResult({ abi: ENTRYPOINT_ABI, data: err.cause.data });
      console.log("  decoded error:", decoded.errorName);
      console.log("  args:", decoded.args);
    } catch (decodeErr) {
      console.log("  could not decode:", decodeErr.message);
    }
  }
  console.log("\n  short message:", err.shortMessage);
  if (err.metaMessages) console.log("  meta:", err.metaMessages.slice(0, 3).join("\n  "));
}
