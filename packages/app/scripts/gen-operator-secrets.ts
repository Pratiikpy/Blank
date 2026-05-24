import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

console.log("PUSH_NOTIFY_SECRET:", randomBytes(32).toString("hex"));
console.log("");

const paymasterPk = generatePrivateKey();
const paymasterAddr = privateKeyToAccount(paymasterPk).address;
console.log("PAYMASTER_TOPUP_PRIVATE_KEY:", paymasterPk);
console.log("  → address (fund this):", paymasterAddr);
console.log("");

const relayerPk = generatePrivateKey();
const relayerAddr = privateKeyToAccount(relayerPk).address;
console.log("RELAYER_TOPUP_PRIVATE_KEY:", relayerPk);
console.log("  → address (fund this):", relayerAddr);
