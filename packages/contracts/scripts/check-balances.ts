import { ethers } from "hardhat";

async function main() {
  const provider = ethers.provider;
  const deployer = "0xb860513A3C5348C46cF52a573Fd743bA03c2c53F";
  const paymaster = "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E";
  const ep = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
  const eth = await provider.getBalance(deployer);
  console.log("Deployer ETH:    ", ethers.formatEther(eth));
  const pmEth = await provider.getBalance(paymaster);
  console.log("Paymaster wallet:", ethers.formatEther(pmEth));
  const epContract = new ethers.Contract(
    ep,
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  );
  const dep = await epContract.balanceOf(paymaster);
  console.log("EP deposit:      ", ethers.formatEther(dep));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
