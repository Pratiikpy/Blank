const { ethers } = require("ethers");
const ALICE_AA = "0xA7970e919DE5270266EcA67432F5D17cF1De26b1";
const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
async function check(url, label) {
  const p = new ethers.JsonRpcProvider(url);
  const ep = new ethers.Contract(EP, ["function getNonce(address,uint192) view returns (uint256)"], p);
  const latest = await p.send("eth_call", [{ to: EP, data: ep.interface.encodeFunctionData("getNonce", [ALICE_AA, 0]) }, "latest"]);
  const pending = await p.send("eth_call", [{ to: EP, data: ep.interface.encodeFunctionData("getNonce", [ALICE_AA, 0]) }, "pending"]);
  console.log(`${label}: latest=${BigInt(latest).toString().padEnd(6)} pending=${BigInt(pending).toString().padEnd(6)}`);
}
async function main() {
  await check("https://eth-sepolia.g.alchemy.com/v2/TyCbYb1lvu4L9oEPnE6ah", "alchemy-private");
  await check("https://ethereum-sepolia.publicnode.com", "publicnode  ");
}
main();
