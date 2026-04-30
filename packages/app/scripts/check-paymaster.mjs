import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const PAYMASTER = "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de";
const FACTORY = "0xd19Bfd90907c943Eee129a2066BCbC350F4a16fb";
const PAYMENT_HUB = "0xF420102Dea1acf437bfc49ded5F4E2f5ed32e831";
const VAULT_USDC = "0x789f0bC466E172eD737493e9796a6d0a3aB0ff23";
const TEST_USDC = "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a";

const abi = [
  { type: "function", name: "approvedFactory", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "whitelistEnabled", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "approvedTargets", inputs: [{ name: "", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "approvedTargetsCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "feeToken", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
];

const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

console.log("Paymaster state on Base Sepolia:");
console.log("  approvedFactory   ", await client.readContract({ address: PAYMASTER, abi, functionName: "approvedFactory" }));
console.log("  whitelistEnabled  ", await client.readContract({ address: PAYMASTER, abi, functionName: "whitelistEnabled" }));
console.log("  approvedTargetsCount", await client.readContract({ address: PAYMASTER, abi, functionName: "approvedTargetsCount" }));
console.log("  feeToken          ", await client.readContract({ address: PAYMASTER, abi, functionName: "feeToken" }));

console.log("\nExpected factory: ", FACTORY);
console.log("\napprovedTargets checks:");
for (const [name, addr] of Object.entries({ PaymentHub: PAYMENT_HUB, Vault: VAULT_USDC, TestUSDC: TEST_USDC })) {
  const v = await client.readContract({ address: PAYMASTER, abi, functionName: "approvedTargets", args: [addr] });
  console.log(`  ${name.padEnd(12)} ${addr}: ${v}`);
}
