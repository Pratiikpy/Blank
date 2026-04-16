import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── setup-receipts — wire PaymentHub ↔ PaymentReceipts ──────────────────
//
// After PaymentHub + PaymentReceipts upgrades land, two cross-references
// must be set so the global aggregate counter actually receives data:
//
//   1. paymentReceipts.setAuthorizedCaller(paymentHub, true)
//      Otherwise PaymentHub's bumpGlobalVolume call reverts with "unauthorized".
//      The PaymentHub catches that revert silently, so the only symptom is
//      "counter never increments" — easy to miss.
//
//   2. paymentHub.setPaymentReceipts(paymentReceipts)
//      Otherwise PaymentHub doesn't know where to fire the bump call.
//      Default is address(0) — feature off.
//
// Both ops are idempotent. Run on both chains.

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

task("setup-receipts", "Wire PaymentHub ↔ PaymentReceipts so the landing counter increments").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const addresses = loadDeployment(hre.network.name);

    if (!addresses.PaymentHub || !addresses.PaymentReceipts) {
      throw new Error("PaymentHub or PaymentReceipts missing from deployment file");
    }

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — Receipts wiring");
    console.log("═══════════════════════════════════════════");
    console.log("  Network:        ", hre.network.name);
    console.log("  PaymentHub:     ", addresses.PaymentHub);
    console.log("  PaymentReceipts:", addresses.PaymentReceipts);
    console.log("═══════════════════════════════════════════\n");

    const receipts = new hre.ethers.Contract(
      addresses.PaymentReceipts,
      [
        "function setAuthorizedCaller(address,bool)",
        "function authorizedCallers(address) view returns (bool)",
      ],
      deployer,
    );
    const paymentHub = new hre.ethers.Contract(
      addresses.PaymentHub,
      [
        "function setPaymentReceipts(address)",
        "function paymentReceipts() view returns (address)",
      ],
      deployer,
    );

    // 1. Authorize PaymentHub on PaymentReceipts
    const alreadyAuthorized = await receipts.authorizedCallers(addresses.PaymentHub);
    if (alreadyAuthorized) {
      console.log("1/2  PaymentHub already authorized on PaymentReceipts ✓");
    } else {
      console.log("1/2  Authorizing PaymentHub on PaymentReceipts...");
      const tx = await receipts.setAuthorizedCaller(addresses.PaymentHub, true);
      await tx.wait(2);
      console.log("     ✓ tx:", tx.hash);
    }

    // 2. Tell PaymentHub where PaymentReceipts lives
    const currentReceiptsAddr = (await paymentHub.paymentReceipts()) as string;
    if (currentReceiptsAddr.toLowerCase() === addresses.PaymentReceipts.toLowerCase()) {
      console.log("2/2  PaymentHub already pointed at PaymentReceipts ✓");
    } else {
      console.log("2/2  Setting paymentReceipts on PaymentHub...");
      const tx = await paymentHub.setPaymentReceipts(addresses.PaymentReceipts);
      await tx.wait(2);
      console.log("     ✓ tx:", tx.hash);
    }

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  Receipts wiring complete — landing counter will now increment");
    console.log("  on every sendPayment / batchSend / sendPaymentAsAgent call.");
    console.log("═══════════════════════════════════════════════════════════════\n");
  }
);
