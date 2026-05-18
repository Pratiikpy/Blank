import { ethers } from "hardhat";

const PAYMASTERS: Record<string, string> = {
  "eth-sepolia": "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E",
  "base-sepolia": "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de",
};

async function main() {
  const networkName = (await import("hardhat")).default.network.name;
  const paymasterAddr = PAYMASTERS[networkName];
  if (!paymasterAddr) {
    throw new Error(`Unknown network ${networkName}`);
  }
  const [signer] = await ethers.getSigners();
  const paymaster = new ethers.Contract(
    paymasterAddr,
    [
      "function feeRateBps() view returns (uint256)",
      "function maxFeeCap() view returns (uint256)",
      "function setFeeConfig(uint256 feeRateBps, uint256 maxFeeCap) external",
      "function owner() view returns (address)",
    ],
    signer,
  );
  const owner = await paymaster.owner();
  console.log(`Network:   ${networkName}`);
  console.log(`Signer:    ${signer.address}`);
  console.log(`Owner:     ${owner}`);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer is not paymaster owner`);
  }
  const before = await paymaster.feeRateBps();
  console.log(`Before:    feeRateBps = ${before.toString()}`);
  if (before === 0n) {
    console.log(`Already zero. Nothing to do.`);
    return;
  }
  const tx = await paymaster.setFeeConfig(0, 0);
  console.log(`tx:        ${tx.hash}`);
  await tx.wait();
  const after = await paymaster.feeRateBps();
  console.log(`After:     feeRateBps = ${after.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
