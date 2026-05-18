const { ethers } = require("ethers");
const CHAINS = [
  ["eth-sepolia", "https://ethereum-sepolia.publicnode.com", "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E"],
  ["base-sepolia", "https://sepolia.base.org", "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de"],
];
async function main() {
  for (const [name, rpc, paymaster] of CHAINS) {
    const p = new ethers.JsonRpcProvider(rpc);
    const c = new ethers.Contract(paymaster, ["function feeRateBps() view returns (uint256)", "function maxFeeCap() view returns (uint256)"], p);
    const fee = await c.feeRateBps();
    const cap = await c.maxFeeCap();
    console.log(`${name.padEnd(15)}  feeRateBps=${fee.toString().padEnd(5)}  maxFeeCap=${cap.toString()}`);
  }
}
main();
