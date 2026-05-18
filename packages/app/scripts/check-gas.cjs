const { ethers } = require("ethers");
async function main() {
  const rpcs = [
    ["eth-sepolia", "https://ethereum-sepolia.publicnode.com"],
    ["base-sepolia", "https://sepolia.base.org"],
  ];
  for (const [name, url] of rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      const fee = await p.getFeeData();
      console.log(`${name}: maxFeePerGas=${ethers.formatUnits(fee.maxFeePerGas ?? 0n, "gwei")} gwei  baseFee≈${ethers.formatUnits(fee.gasPrice ?? 0n, "gwei")} gwei`);
    } catch (e) {
      console.log(`${name}: ERR ${e.message.slice(0, 60)}`);
    }
  }
}
main();
