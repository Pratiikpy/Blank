import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  const addr = JSON.parse(fs.readFileSync("deployments/base-sepolia.json", "utf8"));
  const SMART_ACCOUNT = "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f";

  const vault_usdc = await ethers.getContractAt(
    ["function allowance(address,address) view returns (uint64)"],
    addr.FHERC20Vault_USDC,
  );
  const allowance = await vault_usdc.allowance(SMART_ACCOUNT, addr.P2PExchange);
  console.log("Vault_USDC approval: smartAccount -> P2PExchange =", allowance.toString());

  const p2p = await ethers.getContractAt(
    ["function offers(uint256) view returns (address maker, address tokenGive, address tokenWant, uint256 amountGive, uint256 amountWant, uint256 expiry, bool active, bool filled)"],
    addr.P2PExchange,
  );
  const offer = await p2p.offers(1);
  console.log("Offer #1:", {
    maker: offer.maker,
    active: offer.active,
    filled: offer.filled,
    amountGive: offer.amountGive.toString(),
    amountWant: offer.amountWant.toString(),
    expiry: new Date(Number(offer.expiry) * 1000).toISOString(),
  });
}
main().catch(console.error);
