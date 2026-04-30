import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── setup-receipts — wire all hubs ↔ PaymentReceipts ────────────────────
//
// After the hub upgrades land, eight cross-references must be set so the
// global aggregate counter actually receives data AND every recipient flow
// (payment, payroll, gift, stealth send) lands in someone's per-user
// _totalReceived counter for proveIncomeAbove:
//
//   1. paymentReceipts.setAuthorizedCaller(paymentHub, true)
//      Otherwise PaymentHub's bumpGlobalVolume / bumpUserReceived calls revert
//      with "unauthorized" — symptom is silent counter no-op (try/catch).
//   2. paymentHub.setPaymentReceipts(paymentReceipts)
//      Tells PaymentHub where to fire the bump calls. Default address(0) =
//      feature off.
//   3. paymentReceipts.setAuthorizedCaller(businessHub, true)              [#92]
//      runPayroll → bumpUserReceived / bumpGlobal.
//   4. businessHub.setPaymentReceipts(paymentReceipts)                     [#92]
//      Tells BusinessHub where to bump.
//   5. paymentReceipts.setAuthorizedCaller(giftMoney, true)                [#204]
//      createEnvelope → bumpUserReceived / bumpGlobal per recipient.
//   6. giftMoney.setPaymentReceipts(paymentReceipts)                       [#204]
//      Tells GiftMoney where to bump.
//   7. paymentReceipts.setAuthorizedCaller(stealthPayments, true)          [#199]
//      sendStealth → bumpGlobal; refund → decrementGlobalVolume.
//   8. stealthPayments.setPaymentReceipts(paymentReceipts)                 [#199]
//      Tells StealthPayments where to bump/decrement.
//
// All eight ops are idempotent. Run on both chains. Missing optional contracts
// (e.g. GiftMoney not deployed yet on a chain) are skipped with a warning.

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

task("setup-receipts", "Wire PaymentHub / BusinessHub / GiftMoney / StealthPayments ↔ PaymentReceipts").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const addresses = loadDeployment(hre.network.name);

    if (!addresses.PaymentHub || !addresses.PaymentReceipts || !addresses.BusinessHub) {
      throw new Error("PaymentHub, BusinessHub, or PaymentReceipts missing from deployment file");
    }
    // GiftMoney + StealthPayments are optional — warn but don't fail if absent.
    const hasGift = !!addresses.GiftMoney;
    const hasStealth = !!addresses.StealthPayments;

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — Receipts wiring");
    console.log("═══════════════════════════════════════════");
    console.log("  Network:        ", hre.network.name);
    console.log("  PaymentHub:     ", addresses.PaymentHub);
    console.log("  BusinessHub:    ", addresses.BusinessHub);
    console.log("  GiftMoney:      ", hasGift ? addresses.GiftMoney : "(not deployed — skipping)");
    console.log("  StealthPayments:", hasStealth ? addresses.StealthPayments : "(not deployed — skipping)");
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
    const businessHub = new hre.ethers.Contract(
      addresses.BusinessHub,
      [
        "function setPaymentReceipts(address)",
        "function paymentReceipts() view returns (address)",
      ],
      deployer,
    );
    const giftMoney = hasGift
      ? new hre.ethers.Contract(
          addresses.GiftMoney,
          [
            "function setPaymentReceipts(address)",
            "function paymentReceipts() view returns (address)",
          ],
          deployer,
        )
      : null;
    const stealthPayments = hasStealth
      ? new hre.ethers.Contract(
          addresses.StealthPayments,
          [
            "function setPaymentReceipts(address)",
            "function paymentReceipts() view returns (address)",
          ],
          deployer,
        )
      : null;

    let stepNum = 0;
    const totalSteps = 4 + (hasGift ? 2 : 0) + (hasStealth ? 2 : 0);
    const tag = (label: string) => `${++stepNum}/${totalSteps}  ${label}`;

    // 1. Authorize PaymentHub on PaymentReceipts
    const paymentHubAuthed = await receipts.authorizedCallers(addresses.PaymentHub);
    if (paymentHubAuthed) {
      console.log(tag("PaymentHub already authorized on PaymentReceipts ✓"));
    } else {
      console.log(tag("Authorizing PaymentHub on PaymentReceipts..."));
      const tx = await receipts.setAuthorizedCaller(addresses.PaymentHub, true);
      await tx.wait(2);
      console.log("     ✓ tx:", tx.hash);
    }

    // 2. Tell PaymentHub where PaymentReceipts lives
    const currentHubReceipts = (await paymentHub.paymentReceipts()) as string;
    if (currentHubReceipts.toLowerCase() === addresses.PaymentReceipts.toLowerCase()) {
      console.log(tag("PaymentHub already pointed at PaymentReceipts ✓"));
    } else {
      console.log(tag("Setting paymentReceipts on PaymentHub..."));
      const tx = await paymentHub.setPaymentReceipts(addresses.PaymentReceipts);
      await tx.wait(2);
      console.log("     ✓ tx:", tx.hash);
    }

    // 3. Authorize BusinessHub on PaymentReceipts (#92)
    const businessHubAuthed = await receipts.authorizedCallers(addresses.BusinessHub);
    if (businessHubAuthed) {
      console.log(tag("BusinessHub already authorized on PaymentReceipts ✓"));
    } else {
      console.log(tag("Authorizing BusinessHub on PaymentReceipts..."));
      const tx = await receipts.setAuthorizedCaller(addresses.BusinessHub, true);
      await tx.wait(2);
      console.log("     ✓ tx:", tx.hash);
    }

    // 4. Tell BusinessHub where PaymentReceipts lives (#92)
    const currentBizReceipts = (await businessHub.paymentReceipts()) as string;
    if (currentBizReceipts.toLowerCase() === addresses.PaymentReceipts.toLowerCase()) {
      console.log(tag("BusinessHub already pointed at PaymentReceipts ✓"));
    } else {
      console.log(tag("Setting paymentReceipts on BusinessHub..."));
      const tx = await businessHub.setPaymentReceipts(addresses.PaymentReceipts);
      await tx.wait(2);
      console.log("     ✓ tx:", tx.hash);
    }

    // 5+6. GiftMoney wiring (#204)
    if (giftMoney) {
      const giftAuthed = await receipts.authorizedCallers(addresses.GiftMoney);
      if (giftAuthed) {
        console.log(tag("GiftMoney already authorized on PaymentReceipts ✓"));
      } else {
        console.log(tag("Authorizing GiftMoney on PaymentReceipts..."));
        const tx = await receipts.setAuthorizedCaller(addresses.GiftMoney, true);
        await tx.wait(2);
        console.log("     ✓ tx:", tx.hash);
      }
      const currentGiftReceipts = (await giftMoney.paymentReceipts()) as string;
      if (currentGiftReceipts.toLowerCase() === addresses.PaymentReceipts.toLowerCase()) {
        console.log(tag("GiftMoney already pointed at PaymentReceipts ✓"));
      } else {
        console.log(tag("Setting paymentReceipts on GiftMoney..."));
        const tx = await giftMoney.setPaymentReceipts(addresses.PaymentReceipts);
        await tx.wait(2);
        console.log("     ✓ tx:", tx.hash);
      }
    }

    // 7+8. StealthPayments wiring (#199)
    if (stealthPayments) {
      const stealthAuthed = await receipts.authorizedCallers(addresses.StealthPayments);
      if (stealthAuthed) {
        console.log(tag("StealthPayments already authorized on PaymentReceipts ✓"));
      } else {
        console.log(tag("Authorizing StealthPayments on PaymentReceipts..."));
        const tx = await receipts.setAuthorizedCaller(addresses.StealthPayments, true);
        await tx.wait(2);
        console.log("     ✓ tx:", tx.hash);
      }
      const currentStealthReceipts = (await stealthPayments.paymentReceipts()) as string;
      if (currentStealthReceipts.toLowerCase() === addresses.PaymentReceipts.toLowerCase()) {
        console.log(tag("StealthPayments already pointed at PaymentReceipts ✓"));
      } else {
        console.log(tag("Setting paymentReceipts on StealthPayments..."));
        const tx = await stealthPayments.setPaymentReceipts(addresses.PaymentReceipts);
        await tx.wait(2);
        console.log("     ✓ tx:", tx.hash);
      }
    }

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  Receipts wiring complete. Landing counter increments on every");
    console.log("  sendPayment / batchSend / sendPaymentAsAgent / fulfillRequest /");
    console.log("  runPayroll / createEnvelope / sendStealth (and decrements on");
    console.log("  stealth refund). Recipients across all flows can prove income");
    console.log("  via proveIncomeAbove.");
    console.log("═══════════════════════════════════════════════════════════════\n");
  }
);
