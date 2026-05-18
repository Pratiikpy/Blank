const { ethers } = require("ethers");
const ALICE_AA = "0xA7970e919DE5270266EcA67432F5D17cF1De26b1";
const ENTRY_POINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
async function main() {
  const p = new ethers.JsonRpcProvider("https://ethereum-sepolia.publicnode.com");
  const ep = new ethers.Contract(
    ENTRY_POINT,
    ["function getNonce(address sender, uint192 key) view returns (uint256)"],
    p,
  );
  const nonce = await ep.getNonce(ALICE_AA, 0);
  console.log(`Alice AA on-chain nonce (key=0): ${nonce.toString()}`);
}
main();
