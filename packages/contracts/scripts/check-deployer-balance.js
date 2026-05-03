const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`network: ${hre.network.name}`);
  console.log(`deployer: ${signer.address}`);
  console.log(`balance: ${hre.ethers.formatEther(balance)} ETH`);
}

main().catch(e => { console.error(e); process.exit(1); });
