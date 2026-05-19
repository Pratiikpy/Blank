/**
 * One-shot funding for Dave's Rabby EOA on Base Sepolia.
 *
 *   pnpm exec tsx packages/app/e2e/fixtures/rabby/fund-dave-base.ts
 *
 * The live-smoke originally funded Dave on Ethereum Sepolia only.
 * Phase 9 now also tests Base Sepolia, which needs the same pre-state:
 * 0.05 ETH for gas + 10000 TestUSDC for shielding + sending.
 *
 * Uses the deployer key from packages/contracts/.env. Idempotent —
 * skips funding legs that already have sufficient balance.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
  parseUnits,
  formatEther,
  formatUnits,
} from "ethers";

function loadEnvFile(path: string): void {
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env missing is fine if PRIVATE_KEY is already set in shell env.
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnvFile(resolve(__dirname, "..", "..", "..", "..", "contracts", ".env"));

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error("FATAL: DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) missing from packages/contracts/.env");
  process.exit(1);
}

// Dave's Rabby EOA address — pinned via the live-smoke's RABBI_PRIVATE_KEY
// derivation. Matches the address shown in the persistent profile UI:
// 0x7ef991...b1d175.
const DAVE_ADDRESS = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175";

const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const BASE_SEPOLIA_CHAIN_ID = 84532;
// TestUSDC address on Base Sepolia — see packages/app/src/lib/constants.ts:254.
const TEST_USDC_BASE = "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a";

const TEST_USDC_ABI = [
  "function faucet() external",
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function main(): Promise<void> {
  const provider = new JsonRpcProvider(BASE_SEPOLIA_RPC, BASE_SEPOLIA_CHAIN_ID);
  const deployer = new Wallet(DEPLOYER_PRIVATE_KEY, provider);

  console.log(`Deployer:        ${deployer.address}`);
  console.log(`Dave (Rabby):    ${DAVE_ADDRESS}`);
  console.log(`Chain:           Base Sepolia (${BASE_SEPOLIA_CHAIN_ID})`);
  console.log("");

  // — ETH for gas —
  const ethBalance = await provider.getBalance(DAVE_ADDRESS);
  console.log(`Dave ETH:        ${formatEther(ethBalance)} ETH`);
  // Threshold: 0.005 ETH is enough for ~10 txs on Base Sepolia at
  // current gas. Lower bar = less deployer drain.
  const ethThreshold = parseEther("0.005");
  if (ethBalance < ethThreshold) {
    const ethTopUp = parseEther("0.01");
    const tx = await deployer.sendTransaction({ to: DAVE_ADDRESS, value: ethTopUp });
    console.log(`ETH funding tx:  ${tx.hash}  (waiting...)`);
    await tx.wait(1);
    console.log(`ETH funding:     ✓ Dave topped up to 0.01 ETH`);
  } else {
    console.log(`ETH funding:     skipped (already sufficient)`);
  }

  // — TestUSDC —
  const usdc = new Contract(TEST_USDC_BASE, TEST_USDC_ABI, deployer);
  const decimals = Number(await usdc.decimals());
  const usdcBalance = (await usdc.balanceOf(DAVE_ADDRESS)) as bigint;
  console.log(`Dave TestUSDC:   ${formatUnits(usdcBalance, decimals)} USDC`);
  const usdcTarget = parseUnits("10000", decimals);
  if (usdcBalance < usdcTarget) {
    try {
      const tx = await usdc.mint(DAVE_ADDRESS, usdcTarget);
      console.log(`USDC mint tx:    ${tx.hash}  (waiting...)`);
      await tx.wait(1);
      console.log(`USDC mint:       ✓ Dave funded with 10000 TestUSDC`);
    } catch (e) {
      console.error(`USDC mint failed: ${(e as Error).message.slice(0, 200)}`);
      console.error(`Deployer may not have admin mint privileges on Base TestUSDC.`);
      process.exit(2);
    }
  } else {
    console.log(`USDC mint:       skipped (already sufficient)`);
  }

  console.log("");
  console.log("✓ Dave's Rabby EOA is funded on Base Sepolia. Rerun Phase 9.");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(99);
});
