import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

// Load .env.local
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

const FACTORY = "0xd19Bfd90907c943Eee129a2066BCbC350F4a16fb";
const PREDICTED = "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f";
const PUBX = 0xcb95c03c21bd16e22f34d0a253c35a5bd53ad5a9fc0e4ef9f3dd61ced364573an;
const PUBY = 0xe969d62fbbffa077bcc2ec6ea520bac95d62388d8edcf40f795c20e607e62dc4n;
const ZERO = "0x0000000000000000000000000000000000000000";

const c = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const code = await c.getCode({ address: PREDICTED });
console.log("Code at predicted:", code === undefined || code === "0x" ? "NONE" : `${code.length} chars`);

if (code === undefined || code === "0x") {
  console.log("Account NOT deployed. Deploying directly via factory.createAccount...");
  const w = createWalletClient({
    account: privateKeyToAccount("0x" + process.env.DEPLOYER_PRIVATE_KEY.replace(/^0x/, "")),
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });
  const abi = parseAbi(["function createAccount(uint256 x, uint256 y, address recoveryModule, uint256 salt) external returns (address)"]);
  const hash = await w.writeContract({
    address: FACTORY, abi, functionName: "createAccount",
    args: [PUBX, PUBY, ZERO, 0n],
  });
  console.log("  tx:", hash);
  const receipt = await c.waitForTransactionReceipt({ hash });
  console.log("  status:", receipt.status, "gasUsed:", receipt.gasUsed);
  const code2 = await c.getCode({ address: PREDICTED });
  console.log("Code after deploy:", code2 === "0x" ? "STILL NONE" : `${code2.length} chars`);
}
