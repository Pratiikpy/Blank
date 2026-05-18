const { ethers } = require("ethers");
const PAYMASTER = "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E";
const ABI = [
  "function feeToken() view returns (address)",
  "function feeRateBps() view returns (uint256)",
  "function maxFeeCap() view returns (uint256)",
  "function whitelistEnabled() view returns (bool)",
  "function approvedFactory() view returns (address)",
  "function approvedTargetsCount() view returns (uint256)",
  "function owner() view returns (address)",
];
async function main() {
  const p = new ethers.JsonRpcProvider("https://ethereum-sepolia.publicnode.com");
  const c = new ethers.Contract(PAYMASTER, ABI, p);
  console.log("paymaster:                ", PAYMASTER);
  console.log("owner:                    ", await c.owner());
  console.log("feeToken:                 ", await c.feeToken());
  console.log("feeRateBps:               ", (await c.feeRateBps()).toString());
  console.log("maxFeeCap:                ", (await c.maxFeeCap()).toString());
  console.log("whitelistEnabled:         ", await c.whitelistEnabled());
  console.log("approvedFactory:          ", await c.approvedFactory());
  console.log("approvedTargetsCount:     ", (await c.approvedTargetsCount()).toString());
}
main().catch((e) => { console.error(e); process.exit(1); });
