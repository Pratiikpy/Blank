const { ethers } = require("ethers");
const PAYMASTER = "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E";
const ABI = ["function approvedTargets(address) view returns (bool)", "function approvedTargetsCount() view returns (uint256)"];
const TARGETS = {
  ClaimLinks: "0x9E2189149deec5e78cB2976d8DF64CAec40B12Be",
  Storefront: "0x786C85880e0FCF123D726600D9784ee88B84695b",
  EncryptedCrowdfund: "0x383B58973f7e8DC3E47D1C2f55393E2ac48b24e1",
  PaymentHub: "0xB628719994C21A5CcAb190019b42750f092Fb5eB",
};
async function main() {
  const p = new ethers.JsonRpcProvider("https://ethereum-sepolia.publicnode.com");
  const c = new ethers.Contract(PAYMASTER, ABI, p);
  console.log("approvedTargetsCount:", (await c.approvedTargetsCount()).toString());
  for (const [name, addr] of Object.entries(TARGETS)) {
    const ok = await c.approvedTargets(addr);
    console.log(`${name.padEnd(22)} ${addr}  approved=${ok}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
