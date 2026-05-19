// Direct TestUSDC mint to wave-4 personas via the deployer wallet.
// Bypasses /api/faucet/usdc's per-address-day rate limit so Base
// Sepolia tests can run after the daily quota would otherwise be
// exhausted.
//
// Usage:
//   node scripts/faucet-personas-direct.cjs <chainId>
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const envText = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const CHAIN = {
  11155111: {
    rpc: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
    testUsdc: "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68",
    name: "eth-sepolia",
  },
  84532: {
    rpc: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    // Blank's own TestUSDC deployment (NOT the Circle FiatToken),
    // which is what /api/faucet/usdc mints and what the wave-4
    // suite reads via contracts.TestUSDC. Mint(to, amount) is
    // permissionless on this contract.
    testUsdc: "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a",
    name: "base-sepolia",
  },
};

// Wave-4 persona AA addresses (deterministic from passkey privKey).
// Pre-resolved offline to skip the EntryPoint.getAddress round-trip.
const PERSONAS = {
  Alice: "0xA7970e919DE5270266EcA67432F5D17cF1De26b1",
  Bob: "0xBf8dF3Ac2f1876a7Cfa1Fc9A06930BbbEb700f73",
  Carol: "0x1EA18b92F672df079D2bECfEC7F2df4ed077145a",
  Dave: "0x7eF99105308230eab5B8E4765842bc2BF7B1D175",
};

const MINT_AMOUNT = ethers.parseUnits("500", 6); // 500 USDC

async function main() {
  const chainId = Number(process.argv[2] ?? 84532);
  const cfg = CHAIN[chainId];
  if (!cfg) {
    console.error(`Unsupported chainId ${chainId}`);
    process.exit(1);
  }
  const pkey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pkey) {
    console.error("Missing RELAYER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY in .env.local");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const wallet = new ethers.Wallet(pkey.startsWith("0x") ? pkey : `0x${pkey}`, provider);
  console.log(`Network: ${cfg.name} (${chainId})`);
  console.log(`Signer:  ${wallet.address}`);

  const usdc = new ethers.Contract(
    cfg.testUsdc,
    [
      "function mint(address to, uint256 amount) external",
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ],
    wallet,
  );

  // Probe whether `mint(address,uint256)` is callable. Some TestUSDC
  // deployments use `faucet(address)` instead — try both.
  for (const [name, addr] of Object.entries(PERSONAS)) {
    const balBefore = await usdc.balanceOf(addr);
    if (balBefore >= MINT_AMOUNT) {
      console.log(`${name.padEnd(6)} ${addr}: balance ${ethers.formatUnits(balBefore, 6)} USDC (skipping)`);
      continue;
    }
    try {
      const tx = await usdc.mint(addr, MINT_AMOUNT);
      console.log(`${name.padEnd(6)} ${addr}: mint tx ${tx.hash}`);
      await tx.wait();
      const balAfter = await usdc.balanceOf(addr);
      console.log(`${name.padEnd(6)}                                              new bal ${ethers.formatUnits(balAfter, 6)} USDC`);
    } catch (e) {
      console.error(`${name.padEnd(6)} mint failed: ${e.shortMessage || e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
