const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const envText = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const RPCS = {
  11155111: process.env.SEPOLIA_RPC_URL || process.env.VITE_SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
  84532: process.env.BASE_SEPOLIA_RPC_URL || process.env.VITE_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
};

const KEYS = {
  DEPLOYER: process.env.DEPLOYER_PRIVATE_KEY,
  RELAYER: process.env.RELAYER_PRIVATE_KEY,
  AGENT: process.env.AGENT_PRIVATE_KEY,
};

async function main() {
  for (const [label, key] of Object.entries(KEYS)) {
    if (!key) {
      console.log(`${label.padEnd(10)}  NO KEY SET`);
      continue;
    }
    const wallet = new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`);
    for (const [chainId, rpc] of Object.entries(RPCS)) {
      const provider = new ethers.JsonRpcProvider(rpc);
      try {
        const bal = await provider.getBalance(wallet.address);
        console.log(`${label.padEnd(10)} chain=${chainId.padEnd(8)} ${wallet.address}  ${ethers.formatEther(bal)} ETH`);
      } catch (e) {
        console.log(`${label.padEnd(10)} chain=${chainId} ERR ${e.message.slice(0, 80)}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
