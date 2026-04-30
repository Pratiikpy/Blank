// Throwaway helper: print deployer address + ETH balance on the active network.
// Used as a pre-flight check before running deploy-upgrade tasks.
import hre from "hardhat";

async function main() {
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("no signer configured for this network");
  const addr = await signer.getAddress();
  const balance = await hre.ethers.provider.getBalance(addr);
  console.log(`Network:  ${hre.network.name}`);
  console.log(`Deployer: ${addr}`);
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} ETH`);
}

main().catch((err) => { console.error(err); process.exit(1); });
