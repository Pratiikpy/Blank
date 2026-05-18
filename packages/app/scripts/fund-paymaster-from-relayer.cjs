const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const envText = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const PAYMASTERS = {
  11155111: "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E",
  84532: "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de",
};
const ENTRY_POINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const RPCS = {
  11155111: process.env.SEPOLIA_RPC_URL || process.env.VITE_SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
  84532: process.env.BASE_SEPOLIA_RPC_URL || process.env.VITE_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
};

const chainId = Number(process.argv[2] ?? 11155111);
const amount = process.argv[3] ?? "0.1";
const pkey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
if (!pkey) {
  console.error("Missing RELAYER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY in .env.local");
  process.exit(1);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPCS[chainId]);
  const wallet = new ethers.Wallet(pkey.startsWith("0x") ? pkey : `0x${pkey}`, provider);
  const paymaster = PAYMASTERS[chainId];
  if (!paymaster) {
    console.error(`No paymaster known for chainId ${chainId}`);
    process.exit(1);
  }
  const ep = new ethers.Contract(
    ENTRY_POINT,
    [
      "function balanceOf(address) view returns (uint256)",
      "function depositTo(address) payable",
    ],
    wallet,
  );
  const bal = await provider.getBalance(wallet.address);
  console.log(`Signer:     ${wallet.address}  (${ethers.formatEther(bal)} ETH on chain ${chainId})`);
  console.log(`Paymaster:  ${paymaster}`);
  const dep0 = await ep.balanceOf(paymaster);
  console.log(`Before:     ${ethers.formatEther(dep0)} ETH deposit`);

  const wei = ethers.parseEther(amount);
  if (bal < wei + ethers.parseEther("0.002")) {
    console.error(`Insufficient signer ETH (${ethers.formatEther(bal)}) for amount ${amount} plus gas`);
    process.exit(1);
  }
  const tx = await ep.depositTo(paymaster, { value: wei });
  console.log(`tx:         ${tx.hash}`);
  await tx.wait();
  const dep1 = await ep.balanceOf(paymaster);
  console.log(`After:      ${ethers.formatEther(dep1)} ETH deposit`);
  console.log(`Delta:      +${ethers.formatEther(dep1 - dep0)} ETH`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
