import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const FACTORY = "0xd19Bfd90907c943Eee129a2066BCbC350F4a16fb";
const PUBX = 0xcb95c03c21bd16e22f34d0a253c35a5bd53ad5a9fc0e4ef9f3dd61ced364573an;
const PUBY = 0xe969d62fbbffa077bcc2ec6ea520bac95d62388d8edcf40f795c20e607e62dc4n;
const ZERO = "0x0000000000000000000000000000000000000000";
const SALT = 0n;
const ENTRYPOINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

const abi = [
  { type: "function", name: "createAccount", inputs: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }, { name: "recoveryModule", type: "address" }, { name: "salt", type: "uint256" }], outputs: [{ type: "address" }], stateMutability: "payable" },
  { type: "function", name: "getAddress", inputs: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }, { name: "recoveryModule", type: "address" }, { name: "salt", type: "uint256" }], outputs: [{ type: "address" }], stateMutability: "view" },
];

const predicted = await client.readContract({ address: FACTORY, abi, functionName: "getAddress", args: [PUBX, PUBY, ZERO, SALT] });
console.log("Predicted:", predicted);

const code = await client.getCode({ address: predicted });
console.log("Code at predicted:", code === undefined || code === "0x" ? "NONE (counterfactual)" : `${code.length} chars`);

console.log("\nSimulating factory.createAccount FROM EntryPoint...");
try {
  // Factories must be called BY EntryPoint (deployment is via initCode)
  const result = await client.simulateContract({
    address: FACTORY,
    abi,
    functionName: "createAccount",
    args: [PUBX, PUBY, ZERO, SALT],
    account: ENTRYPOINT,
  });
  console.log("✅ Factory call works! Returned:", result.result);
  console.log("   gas estimate:", result.request.gas?.toString() ?? "n/a");
} catch (err) {
  console.log("❌ Factory call reverts:", err.shortMessage);
  if (err.cause?.data) console.log("   raw data:", err.cause.data);
  if (err.metaMessages) console.log("   meta:", err.metaMessages.join("\n   "));
}
