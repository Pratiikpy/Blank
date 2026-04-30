// Phase 2 setup — pre-fund everything Phase 2 tests need on Base Sepolia.
//
// Actions (idempotent — safe to re-run):
//  1. Derive deployer EOA from DEPLOYER_PRIVATE_KEY env
//  2. Compute the test smart account address for the canonical test passkey
//     (pubX/pubY derived from a known seed so the address is stable across runs)
//  3. Mint 1000 TestUSDC to the smart account (covers many sends)
//  4. Mint 1000 TestUSDC to a test recipient EOA (so receive flow has data)
//  5. Deposit 0.02 ETH to BlankPaymaster via EntryPoint.depositTo(paymaster)
//     — covers ~5-10 UserOps depending on gas
//  6. Print all addresses so tests can assert against them
//
// Requires: `node scripts/phase2-setup.mjs` with .env.local loaded.

import { createWalletClient, createPublicClient, http, parseUnits, parseEther, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { p256 } from "@noble/curves/nist.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env.local manually (node doesn't auto-load it)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
try {
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch (e) {
  console.error("Failed to read .env.local:", e.message);
  process.exit(1);
}

// ─── Config ────────────────────────────────────────────────────────────

const CHAIN = baseSepolia;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

// Contract addresses — must match packages/app/src/lib/constants.ts
// CONTRACTS_BY_CHAIN[84532]
const ADDRESSES = {
  TestUSDC: "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a",
  FHERC20Vault_USDC: "0x789f0bC466E172eD737493e9796a6d0a3aB0ff23",
  PaymentHub: "0xF420102Dea1acf437bfc49ded5F4E2f5ed32e831",
  BlankAccountFactory: "0xd19Bfd90907c943Eee129a2066BCbC350F4a16fb",
  BlankPaymaster: "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de",
  EntryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
};

// ─── Canonical test passkey — deterministic so address stays stable ───
// Seed is literally "phase2-test-passkey-seed-1" hashed to a P-256 key.
// Same seed → same pubkey → same smart account address across runs.
const PASSKEY_SEED = "phase2-test-passkey-seed-1";

function deriveTestPasskey() {
  // Derive a deterministic 32-byte scalar by hashing the seed repeatedly
  // until it's in the valid P-256 range. Using sha256 from noble.
  const seedBytes = new TextEncoder().encode(PASSKEY_SEED);
  // Use the raw seed — p256.utils.randomSecretKey expects random bytes,
  // but for determinism we hand it the seed directly. P-256 order is
  // very close to 2^256 so any random-looking 32 bytes is valid with
  // probability ~1 (rejection probability < 2^-128).
  const hash32 = new Uint8Array(32);
  // Fold the seed into 32 bytes (simple deterministic derivation)
  for (let i = 0; i < seedBytes.length; i++) {
    hash32[i % 32] ^= seedBytes[i];
  }
  // Sprinkle "1" into empty slots so it doesn't look all zero
  for (let i = 0; i < 32; i++) if (hash32[i] === 0) hash32[i] = (i + 1) & 0xff;

  const priv = hash32;
  const pub = p256.getPublicKey(priv, false); // uncompressed 65 bytes
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("derived passkey has unexpected pubkey format");
  }
  const pubX = ("0x" + bytesToHex(pub.slice(1, 33)));
  const pubY = ("0x" + bytesToHex(pub.slice(33, 65)));
  return { pubX, pubY, privKey: bytesToHex(priv) };
}

// ─── ABIs (minimal — only what this script needs) ─────────────────────

const ERC20_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "mint", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
];

const FACTORY_ABI = [
  {
    type: "function",
    name: "getAddress",
    inputs: [
      { name: "ownerX", type: "uint256" },
      { name: "ownerY", type: "uint256" },
      { name: "recoveryModule", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
];

const ENTRYPOINT_ABI = [
  { type: "function", name: "depositTo", inputs: [{ name: "account", type: "address" }], outputs: [], stateMutability: "payable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY missing from .env.local");
  const deployer = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account: deployer, chain: CHAIN, transport: http(RPC_URL) });

  console.log("════════════════════════════════════════════════════════");
  console.log("Phase 2 Setup — Base Sepolia");
  console.log("════════════════════════════════════════════════════════");
  console.log("Deployer:", deployer.address);

  const deployerEth = await publicClient.getBalance({ address: deployer.address });
  console.log("  ETH balance:", Number(deployerEth) / 1e18, "ETH");

  if (deployerEth < parseEther("0.01")) {
    console.error("❌ Deployer has < 0.01 ETH — fund this address before running setup.");
    process.exit(1);
  }

  // ─── Compute test smart account address ──────────────────────────────
  const passkey = deriveTestPasskey();
  console.log("\nTest passkey pubX:", passkey.pubX);
  console.log("Test passkey pubY:", passkey.pubY);

  const smartAccountAddr = await publicClient.readContract({
    address: ADDRESSES.BlankAccountFactory,
    abi: FACTORY_ABI,
    functionName: "getAddress",
    args: [BigInt(passkey.pubX), BigInt(passkey.pubY), "0x0000000000000000000000000000000000000000", 0n],
  });
  console.log("Smart account address:", smartAccountAddr);

  // ─── Create a test recipient EOA ─────────────────────────────────────
  // Stable address — derived from a known seed so tests can hard-code it.
  const recipient = privateKeyToAccount(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  );
  console.log("Test recipient EOA:", recipient.address);

  // ─── Mint USDC to smart account + recipient ──────────────────────────
  const usdcBalanceSa = await publicClient.readContract({
    address: ADDRESSES.TestUSDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [smartAccountAddr],
  });
  console.log("\nSmart account USDC balance:", Number(usdcBalanceSa) / 1e6, "USDC");

  const MIN_SA_USDC = parseUnits("100", 6);
  if (usdcBalanceSa < MIN_SA_USDC) {
    const mintAmount = parseUnits("1000", 6);
    console.log(`Minting 1000 USDC to smart account ${smartAccountAddr}...`);
    const hash = await walletClient.writeContract({
      address: ADDRESSES.TestUSDC,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [smartAccountAddr, mintAmount],
    });
    console.log("  tx:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error("mint reverted");
    console.log("  ✅ minted");
  } else {
    console.log("  ✅ already funded (skipping mint)");
  }

  const usdcBalanceR = await publicClient.readContract({
    address: ADDRESSES.TestUSDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [recipient.address],
  });
  console.log("Recipient USDC balance:", Number(usdcBalanceR) / 1e6, "USDC");
  if (usdcBalanceR < parseUnits("100", 6)) {
    console.log(`Minting 1000 USDC to recipient ${recipient.address}...`);
    const hash = await walletClient.writeContract({
      address: ADDRESSES.TestUSDC,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [recipient.address, parseUnits("1000", 6)],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error("mint reverted");
    console.log("  ✅ minted");
  } else {
    console.log("  ✅ already funded (skipping mint)");
  }

  // ─── Fund paymaster ──────────────────────────────────────────────────
  const paymasterBalance = await publicClient.readContract({
    address: ADDRESSES.EntryPoint,
    abi: ENTRYPOINT_ABI,
    functionName: "balanceOf",
    args: [ADDRESSES.BlankPaymaster],
  });
  console.log("\nPaymaster EntryPoint deposit:", Number(paymasterBalance) / 1e18, "ETH");

  // First UserOp (with initCode for deployment) needs higher verifGas
  // (~5M to cover factory + validateUserOp). At 1 gwei maxFeePerGas:
  // 5M+5M+200k+100k+100k = ~10.4M × 1 gwei = 0.0104 ETH per UserOp.
  // Want 0.015 ETH minimum so first UserOp fits with margin.
  const MIN_PAYMASTER_DEPOSIT = parseEther("0.012");
  if (paymasterBalance < MIN_PAYMASTER_DEPOSIT) {
    // Top up by the delta we need — don't dump large amounts we can't
    // afford. Deployer ETH is precious; keep a reserve for minting / etc.
    const target = parseEther("0.015");
    const delta = target - paymasterBalance;
    const deployerEth2 = await publicClient.getBalance({ address: deployer.address });
    const reserveFor = parseEther("0.002"); // keep for mint txs
    const available = deployerEth2 > reserveFor ? deployerEth2 - reserveFor : 0n;
    const deposit = delta < available ? delta : available;
    if (deposit <= 0n) {
      console.error(`❌ Not enough ETH to top up paymaster (have ${Number(deployerEth2) / 1e18}, need ${Number(delta) / 1e18} delta + reserve).`);
      process.exit(1);
    }
    console.log(`Depositing ${Number(deposit) / 1e18} ETH for paymaster ${ADDRESSES.BlankPaymaster}...`);
    const hash = await walletClient.writeContract({
      address: ADDRESSES.EntryPoint,
      abi: ENTRYPOINT_ABI,
      functionName: "depositTo",
      args: [ADDRESSES.BlankPaymaster],
      value: deposit,
    });
    console.log("  tx:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error("deposit reverted");
    console.log("  ✅ deposited");
  } else {
    console.log("  ✅ already funded (skipping deposit)");
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════");
  console.log("✅ Phase 2 setup complete on Base Sepolia");
  console.log("════════════════════════════════════════════════════════");
  console.log("Smart account address:", smartAccountAddr);
  console.log("Recipient EOA:       ", recipient.address);
  console.log("Paymaster funded:    ", ADDRESSES.BlankPaymaster);
  console.log("Test passphrase:     phase2-test-pass");
  console.log("\nTest script can now:");
  console.log("  - Use passkey with privKey =", passkey.privKey);
  console.log("  - Expect smart account to hold ≥100 USDC");
  console.log("  - Expect paymaster to sponsor ~5-10 UserOps");
  console.log("════════════════════════════════════════════════════════");

  // Emit values that tests can consume (write to a file)
  const output = {
    chainId: CHAIN.id,
    smartAccount: smartAccountAddr,
    recipient: recipient.address,
    passkey: { pubX: passkey.pubX, pubY: passkey.pubY, privKey: passkey.privKey },
    contracts: ADDRESSES,
  };
  // Store OUTSIDE test-results — Playwright wipes that dir before each run.
  // `e2e/fixtures/` is the conventional spot for test inputs.
  const outPath = resolve(__dirname, "..", "e2e", "fixtures", "phase2-setup.json");
  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("Wrote:", outPath);
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err);
  process.exit(1);
});
