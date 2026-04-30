import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  const addr = JSON.parse(fs.readFileSync("deployments/base-sepolia.json", "utf8"));
  const bh = await ethers.getContractAt(
    [
      "function getInvoiceValidationHandle(uint256) view returns (uint256)",
      "function getInvoice(uint256) view returns (address vendor, address client, address vault, uint256 amount, string description, uint256 dueDate, uint8 status, uint256 createdAt)",
    ],
    addr.BusinessHub,
  );
  for (const id of [10n, 11n]) {
    try {
      const inv = await bh.getInvoice(id);
      console.log(`Invoice #${id}: vendor=${inv.vendor.slice(0,12)} status=${inv.status} description="${inv.description}"`);
      const h = await bh.getInvoiceValidationHandle(id);
      console.log(`  validation handle: ${h.toString()} ${h === 0n ? "← MISSING" : ""}`);
    } catch (e) {
      console.log(`Invoice #${id}: error ${(e as Error).message.slice(0, 80)}`);
    }
  }
}
main().catch(console.error);
