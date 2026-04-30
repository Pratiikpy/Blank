import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  const addr = JSON.parse(fs.readFileSync("deployments/base-sepolia.json", "utf8"));
  const accounts = [
    { name: "sender (smart)", address: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f" },
    { name: "recipient (smart)", address: "0x135694d9578e6f355B80C3D259e4F7D5e2c76DE3" },
  ];
  const testUsdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    addr.TestUSDC,
  );
  for (const a of accounts) {
    const bal = await testUsdc.balanceOf(a.address);
    console.log(`${a.name} (${a.address}): ${Number(bal) / 1e6} USDC (raw)`);
  }
}
main().catch(console.error);
