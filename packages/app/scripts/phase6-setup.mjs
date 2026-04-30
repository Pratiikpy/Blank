// Phase 6 setup — pre-fund TWO smart accounts (sender + recipient) so we can
// drive cross-user E2E flows in Playwright (notifications, balance updates,
// claim flows, etc).
//
// Idempotent — safe to re-run. Mirrors phase2-setup.mjs but with two passkeys.
//
// Usage: `node scripts/phase6-setup.mjs` (loads .env.local).

import { createWalletClient, createPublicClient, http, parseUnits, parseEther } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { p256 } from "@noble/curves/nist.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
try {
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  console.error("Failed to read .env.local"); process.exit(1);
}

const CHAIN = baseSepolia;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

// Same addresses Phase 2 uses + we'll inject the new TestUSDT/FHERC20Vault_USDT
// once they're deployed (script will read base-sepolia.json from contracts pkg
// to pick them up automatically).
const BASE_ADDR_PATH = resolve(__dirname, "..", "..", "contracts", "deployments", "base-sepolia.json");
let DEPLOYED = {};
try { DEPLOYED = JSON.parse(readFileSync(BASE_ADDR_PATH, "utf8")); } catch {}

const ADDRESSES = {
  TestUSDC: "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a",
  FHERC20Vault_USDC: "0x789f0bC466E172eD737493e9796a6d0a3aB0ff23",
  PaymentHub: "0xF420102Dea1acf437bfc49ded5F4E2f5ed32e831",
  GiftMoney: "0x37374487A6575780A6DE3C83440441C7aB03cDDf",
  StealthPayments: "0x76aDF6D800D34B9Ee42AeAEC87dC7C8824132F1C",
  GroupManager: "0x1749E0E08f86211D8239F40BdEcb9497704f9D3d",
  CreatorHub: "0x5dc36868c89F38F56856DDD55096E3F115cC12ea",
  BusinessHub: "0xEfD67E33f12a7b3A221d25f965f70d1BE6721EFD",
  P2PExchange: "0xDa606096d5C2bdE73ccB418771e12630030Ff116",
  InheritanceManager: "0x289714c46F3c47B2E610191d924dC9bDf22973d5",
  BlankAccountFactory: "0xd19Bfd90907c943Eee129a2066BCbC350F4a16fb",
  BlankPaymaster: "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de",
  EntryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  // Optional — present only after deploy-second-vault has run
  TestUSDT: DEPLOYED.TestUSDT,
  FHERC20Vault_USDT: DEPLOYED.FHERC20Vault_USDT,
};

// Two distinct seeds → two distinct passkeys → two distinct smart accounts.
// "phase2-test-passkey-seed-1" is the EXISTING sender (we keep it so Phase 2
// state isn't lost). "phase6-recipient-seed-A" is the new recipient.
const SENDER_SEED = "phase2-test-passkey-seed-1";
const RECIPIENT_SEED = "phase6-recipient-seed-A";

function deriveTestPasskey(seed) {
  const seedBytes = new TextEncoder().encode(seed);
  const hash32 = new Uint8Array(32);
  for (let i = 0; i < seedBytes.length; i++) hash32[i % 32] ^= seedBytes[i];
  for (let i = 0; i < 32; i++) if (hash32[i] === 0) hash32[i] = (i + 1) & 0xff;
  const priv = hash32;
  const pub = p256.getPublicKey(priv, false);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("bad pubkey");
  return {
    pubX: "0x" + bytesToHex(pub.slice(1, 33)),
    pubY: "0x" + bytesToHex(pub.slice(33, 65)),
    privKey: bytesToHex(priv),
  };
}

const ERC20_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "mint", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
];
const FACTORY_ABI = [
  {
    type: "function", name: "getAddress",
    inputs: [
      { name: "ownerX", type: "uint256" }, { name: "ownerY", type: "uint256" },
      { name: "recoveryModule", type: "address" }, { name: "salt", type: "uint256" },
    ],
    outputs: [{ type: "address" }], stateMutability: "view",
  },
  {
    type: "function", name: "createAccount",
    inputs: [
      { name: "ownerX", type: "uint256" }, { name: "ownerY", type: "uint256" },
      { name: "recoveryModule", type: "address" }, { name: "salt", type: "uint256" },
    ],
    outputs: [{ type: "address" }], stateMutability: "nonpayable",
  },
];
const ENTRYPOINT_ABI = [
  { type: "function", name: "depositTo", inputs: [{ type: "address" }], outputs: [], stateMutability: "payable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY missing");
  const deployer = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account: deployer, chain: CHAIN, transport: http(RPC_URL) });

  console.log("════════════════════════════════════════════════════════");
  console.log("Phase 6 Setup — Base Sepolia (2 smart accounts)");
  console.log("════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.address);
  const deployerEth = await publicClient.getBalance({ address: deployer.address });
  console.log("  ETH balance:", Number(deployerEth) / 1e18, "ETH");

  const senderPasskey = deriveTestPasskey(SENDER_SEED);
  const recipientPasskey = deriveTestPasskey(RECIPIENT_SEED);

  const senderAddr = await publicClient.readContract({
    address: ADDRESSES.BlankAccountFactory, abi: FACTORY_ABI, functionName: "getAddress",
    args: [BigInt(senderPasskey.pubX), BigInt(senderPasskey.pubY), "0x0000000000000000000000000000000000000000", 0n],
  });
  const recipientAddr = await publicClient.readContract({
    address: ADDRESSES.BlankAccountFactory, abi: FACTORY_ABI, functionName: "getAddress",
    args: [BigInt(recipientPasskey.pubX), BigInt(recipientPasskey.pubY), "0x0000000000000000000000000000000000000000", 0n],
  });
  console.log("\nSender    smart account:", senderAddr);
  console.log("Recipient smart account:", recipientAddr);

  // Pre-deploy the recipient via factory.createAccount() called by the
  // deployer EOA. The recipient's first UserOp would otherwise carry
  // initCode that gets validated by the paymaster + EntryPoint — a fragile
  // path on free RPC tiers. Pre-deploying flattens that to a normal UserOp.
  for (const [label, passkey, addr] of [
    ["sender", senderPasskey, senderAddr],
    ["recipient", recipientPasskey, recipientAddr],
  ]) {
    const code = await publicClient.getBytecode({ address: addr }).catch(() => null);
    if (code && code !== "0x") {
      console.log(`${label} smart account already deployed`);
      continue;
    }
    console.log(`${label} smart account undeployed — calling factory.createAccount...`);
    const hash = await walletClient.writeContract({
      address: ADDRESSES.BlankAccountFactory, abi: FACTORY_ABI, functionName: "createAccount",
      args: [BigInt(passkey.pubX), BigInt(passkey.pubY), "0x0000000000000000000000000000000000000000", 0n],
    });
    const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (r.status !== "success") throw new Error(`createAccount reverted for ${label}`);
    console.log(`  ✅ ${label} deployed at`, addr);
  }

  // Mint USDC to both. Recipient needs balance for gift-claim, p2p-fill,
  // business-pay etc, so fund well above sender minimum.
  for (const [label, addr] of [["sender", senderAddr], ["recipient", recipientAddr]]) {
    const bal = await publicClient.readContract({
      address: ADDRESSES.TestUSDC, abi: ERC20_ABI, functionName: "balanceOf", args: [addr],
    });
    console.log(`\n${label} TestUSDC balance:`, Number(bal) / 1e6, "USDC");
    if (bal < parseUnits("500", 6)) {
      const mintAmount = parseUnits("2000", 6);
      console.log(`  minting 2000 USDC...`);
      const hash = await walletClient.writeContract({
        address: ADDRESSES.TestUSDC, abi: ERC20_ABI, functionName: "mint", args: [addr, mintAmount],
      });
      const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (r.status !== "success") throw new Error("USDC mint reverted");
      console.log("  ✅ minted");
    } else { console.log("  ✅ already funded"); }
  }

  // If 2nd vault deployed, mint USDT to both too.
  if (ADDRESSES.TestUSDT) {
    for (const [label, addr] of [["sender", senderAddr], ["recipient", recipientAddr]]) {
      const bal = await publicClient.readContract({
        address: ADDRESSES.TestUSDT, abi: ERC20_ABI, functionName: "balanceOf", args: [addr],
      });
      console.log(`\n${label} TestUSDT balance:`, Number(bal) / 1e6, "USDT");
      if (bal < parseUnits("500", 6)) {
        const mintAmount = parseUnits("2000", 6);
        console.log(`  minting 2000 USDT...`);
        const hash = await walletClient.writeContract({
          address: ADDRESSES.TestUSDT, abi: ERC20_ABI, functionName: "mint", args: [addr, mintAmount],
        });
        const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (r.status !== "success") throw new Error("USDT mint reverted");
        console.log("  ✅ minted");
      } else { console.log("  ✅ already funded"); }
    }
  }

  // Top up paymaster aggressively — Phase 6 runs many UserOps across both
  // accounts (gift create + claim, stealth send + claim + finalize, business
  // invoice + pay, escrow lifecycle...). Fund 0.05 ETH = ~25 UserOps.
  const paymasterBal = await publicClient.readContract({
    address: ADDRESSES.EntryPoint, abi: ENTRYPOINT_ABI, functionName: "balanceOf", args: [ADDRESSES.BlankPaymaster],
  });
  console.log("\nPaymaster deposit:", Number(paymasterBal) / 1e18, "ETH");
  const TARGET = parseEther("0.05");
  if (paymasterBal < TARGET) {
    const delta = TARGET - paymasterBal;
    const ethBal = await publicClient.getBalance({ address: deployer.address });
    const reserve = parseEther("0.002");
    const available = ethBal > reserve ? ethBal - reserve : 0n;
    const deposit = delta < available ? delta : available;
    if (deposit > 0n) {
      console.log(`  depositing ${Number(deposit) / 1e18} ETH...`);
      const hash = await walletClient.writeContract({
        address: ADDRESSES.EntryPoint, abi: ENTRYPOINT_ABI, functionName: "depositTo",
        args: [ADDRESSES.BlankPaymaster], value: deposit,
      });
      const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (r.status !== "success") throw new Error("paymaster deposit reverted");
      console.log("  ✅ deposited");
    }
  } else { console.log("  ✅ already topped up"); }

  // Write fixture
  const output = {
    chainId: CHAIN.id,
    sender: { address: senderAddr, passkey: senderPasskey, seed: SENDER_SEED },
    recipient: { address: recipientAddr, passkey: recipientPasskey, seed: RECIPIENT_SEED },
    contracts: ADDRESSES,
  };
  const outPath = resolve(__dirname, "..", "e2e", "fixtures", "phase6-setup.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("\n════════════════════════════════════════════════════════");
  console.log("✅ Phase 6 setup complete");
  console.log("Fixture written to:", outPath);
  console.log("Sender    :", senderAddr);
  console.log("Recipient :", recipientAddr);
  console.log("════════════════════════════════════════════════════════");
}

main().catch((err) => { console.error("\n❌ Phase 6 setup failed:", err); process.exit(1); });
