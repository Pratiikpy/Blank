// Debug: simulate the recipient's first UserOp (deploy + setProfile) to surface
// the actual revert reason. The relayer's error wrapper hides the AA FailedOp.

import { createPublicClient, http, encodeFunctionData, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { p256 } from "@noble/curves/nist.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETUP = JSON.parse(readFileSync(resolve(__dirname, "..", "e2e", "fixtures", "phase6-setup.json"), "utf8"));

const FACTORY_ABI = [
  { type: "function", name: "createAccount", inputs: [
    { name: "ownerX", type: "uint256" }, { name: "ownerY", type: "uint256" },
    { name: "recoveryModule", type: "address" }, { name: "salt", type: "uint256" },
  ], outputs: [{ type: "address" }], stateMutability: "nonpayable" },
  { type: "function", name: "getAddress", inputs: [
    { name: "ownerX", type: "uint256" }, { name: "ownerY", type: "uint256" },
    { name: "recoveryModule", type: "address" }, { name: "salt", type: "uint256" },
  ], outputs: [{ type: "address" }], stateMutability: "view" },
];

const ENTRYPOINT_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getNonce", inputs: [{ name: "sender", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

const CREATOR_HUB_ABI = [
  { type: "function", name: "setProfile", inputs: [
    { name: "name", type: "string" }, { name: "bio", type: "string" },
    { name: "tier1", type: "uint64" }, { name: "tier2", type: "uint64" }, { name: "tier3", type: "uint64" },
  ], outputs: [], stateMutability: "nonpayable" },
];

const ACCOUNT_EXECUTE_ABI = [
  { type: "function", name: "execute", inputs: [
    { name: "dest", type: "address" }, { name: "value", type: "uint256" }, { name: "func", type: "bytes" },
  ], outputs: [], stateMutability: "nonpayable" },
];

const c = SETUP.contracts;
const recipient = SETUP.recipient;

const publicClient = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

console.log("Recipient smart account:", recipient.address);
console.log("Recipient pubX        :", recipient.passkey.pubX);
console.log("Recipient pubY        :", recipient.passkey.pubY);

// Re-derive the predicted address from the factory
const predicted = await publicClient.readContract({
  address: c.BlankAccountFactory, abi: FACTORY_ABI, functionName: "getAddress",
  args: [BigInt(recipient.passkey.pubX), BigInt(recipient.passkey.pubY), "0x0000000000000000000000000000000000000000", 0n],
});
console.log("Factory predicted     :", predicted);
console.log("Match                 :", getAddress(predicted) === getAddress(recipient.address));

// Check current state on chain
const code = await publicClient.getCode({ address: recipient.address });
console.log("Recipient code length :", code?.length ?? 0, code === undefined ? "(not deployed)" : "(deployed)");
const nonce = await publicClient.readContract({
  address: c.EntryPoint, abi: ENTRYPOINT_ABI, functionName: "getNonce",
  args: [recipient.address, 0n],
});
console.log("EntryPoint nonce      :", nonce);

// Encode the inner call
const setProfileData = encodeFunctionData({
  abi: CREATOR_HUB_ABI, functionName: "setProfile",
  args: [`e2e-${Date.now()}`, "", BigInt(5_000000), BigInt(15_000000), BigInt(50_000000)],
});
const callData = encodeFunctionData({
  abi: ACCOUNT_EXECUTE_ABI, functionName: "execute",
  args: [c.CreatorHub, 0n, setProfileData],
});
console.log("\ncallData length      :", callData.length);

// Try a static simulation of execute() against the predicted address WITH state
// override that pretends the account is deployed. This isolates "does the call
// itself revert" from "does deployment fail."
//
// Actually simpler: just simulate setProfile from CreatorHub (no AA wrap).
try {
  await publicClient.simulateContract({
    address: c.CreatorHub, abi: CREATOR_HUB_ABI, functionName: "setProfile",
    args: [`e2e-${Date.now()}`, "", BigInt(5_000000), BigInt(15_000000), BigInt(50_000000)],
    account: recipient.address,
  });
  console.log("\n✅ setProfile would succeed if account were deployed");
} catch (e) {
  console.error("\n❌ setProfile would revert:", String(e).slice(0, 800));
}

// And try simulating createAccount on the factory
try {
  await publicClient.simulateContract({
    address: c.BlankAccountFactory, abi: FACTORY_ABI, functionName: "createAccount",
    args: [BigInt(recipient.passkey.pubX), BigInt(recipient.passkey.pubY), "0x0000000000000000000000000000000000000000", 0n],
    account: "0xb860513A3C5348C46cF52a573Fd743bA03c2c53F",
  });
  console.log("✅ Factory createAccount would succeed");
} catch (e) {
  console.error("❌ Factory createAccount would revert:", String(e).slice(0, 800));
}
