import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── setup-receipts — wire all hubs ↔ PaymentReceipts ────────────────────
//
// After the hub upgrades land, cross-references must be set so the
// global aggregate counter actually receives data AND every recipient flow
// (payment, payroll, gift, stealth send, claim-link, escrow, crowdfund,
// storefront) lands in someone's per-user _totalReceived counter for
// proveIncomeAbove:
//
//   Pre-Wave-4 hubs (1-8): PaymentHub, BusinessHub, GiftMoney, StealthPayments.
//   Wave 4 hubs (9-16):    ClaimLinks, EncryptedEscrow, EncryptedCrowdfund,
//                          Storefront. §2.7 of BEST_VERSION_FULL_PLAN closes
//                          the auth-gap: wire-*.js scripts set the hub-side
//                          paymentReceipts pointer, but the reverse
//                          paymentReceipts.setAuthorizedCaller(hub, true)
//                          step was missing, so receipt bumps reverted
//                          silently (caught by §2.6 ReceiptsBumpFailed).
//
// All ops are idempotent. Run on both chains. Missing optional contracts
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
    // GiftMoney + StealthPayments + the 4 Wave 4 contracts are optional;
    // warn but don't fail if absent.
    const hasGift = !!addresses.GiftMoney;
    const hasStealth = !!addresses.StealthPayments;
    const hasClaimLinks = !!addresses.ClaimLinks;
    const hasEscrow = !!addresses.EncryptedEscrow;
    const hasCrowdfund = !!addresses.EncryptedCrowdfund;
    const hasStorefront = !!addresses.Storefront;

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — Receipts wiring");
    console.log("═══════════════════════════════════════════");
    console.log("  Network:        ", hre.network.name);
    console.log("  PaymentHub:     ", addresses.PaymentHub);
    console.log("  BusinessHub:    ", addresses.BusinessHub);
    console.log("  GiftMoney:      ", hasGift ? addresses.GiftMoney : "(not deployed — skipping)");
    console.log("  StealthPayments:", hasStealth ? addresses.StealthPayments : "(not deployed — skipping)");
    console.log("  PaymentReceipts:", addresses.PaymentReceipts);
    console.log("  ─── Wave 4 hubs ────");
    console.log("  ClaimLinks:        ", hasClaimLinks ? addresses.ClaimLinks : "(not deployed)");
    console.log("  EncryptedEscrow:   ", hasEscrow ? addresses.EncryptedEscrow : "(not deployed)");
    console.log("  EncryptedCrowdfund:", hasCrowdfund ? addresses.EncryptedCrowdfund : "(not deployed)");
    console.log("  Storefront:        ", hasStorefront ? addresses.Storefront : "(not deployed)");
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

    // Wave 4 hubs are wired both directions (auth on PR + setPaymentReceipts
    // on hub) just like the pre-Wave-4 ones. Each pair = 2 steps.
    const wave4Hubs = [
      { name: "ClaimLinks", addr: addresses.ClaimLinks, present: hasClaimLinks },
      { name: "EncryptedEscrow", addr: addresses.EncryptedEscrow, present: hasEscrow },
      { name: "EncryptedCrowdfund", addr: addresses.EncryptedCrowdfund, present: hasCrowdfund },
      { name: "Storefront", addr: addresses.Storefront, present: hasStorefront },
    ];

    const wave4Contracts = wave4Hubs
      .filter((h) => h.present)
      .map((h) => ({
        name: h.name,
        addr: h.addr,
        contract: new hre.ethers.Contract(
          h.addr,
          [
            "function setPaymentReceipts(address)",
            "function paymentReceipts() view returns (address)",
          ],
          deployer,
        ),
      }));

    let stepNum = 0;
    const wave4Steps = wave4Contracts.length * 2;
    const totalSteps = 4 + (hasGift ? 2 : 0) + (hasStealth ? 2 : 0) + wave4Steps;
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

    // 9-16. Wave 4 hub wiring (§2.7).
    for (const hub of wave4Contracts) {
      const authed = await receipts.authorizedCallers(hub.addr);
      if (authed) {
        console.log(tag(`${hub.name} already authorized on PaymentReceipts ✓`));
      } else {
        console.log(tag(`Authorizing ${hub.name} on PaymentReceipts...`));
        const tx = await receipts.setAuthorizedCaller(hub.addr, true);
        await tx.wait(2);
        console.log("     ✓ tx:", tx.hash);
      }
      const currentReceipts = (await hub.contract.paymentReceipts()) as string;
      if (currentReceipts.toLowerCase() === addresses.PaymentReceipts.toLowerCase()) {
        console.log(tag(`${hub.name} already pointed at PaymentReceipts ✓`));
      } else {
        console.log(tag(`Setting paymentReceipts on ${hub.name}...`));
        const tx = await hub.contract.setPaymentReceipts(addresses.PaymentReceipts);
        await tx.wait(2);
        console.log("     ✓ tx:", tx.hash);
      }
    }

    // §2.7 final assertion: verify every wired hub is authorized on PR
    // AND points back to PR. Exit non-zero if any pair is half-wired so
    // a misconfigured deploy fails loudly instead of silently emitting
    // ReceiptsBumpFailed events forever.
    const verifyPairs: { name: string; addr: string; hubReceipts: () => Promise<string> }[] = [
      { name: "PaymentHub", addr: addresses.PaymentHub, hubReceipts: async () => (await paymentHub.paymentReceipts()) as string },
      { name: "BusinessHub", addr: addresses.BusinessHub, hubReceipts: async () => (await businessHub.paymentReceipts()) as string },
    ];
    if (giftMoney) verifyPairs.push({ name: "GiftMoney", addr: addresses.GiftMoney, hubReceipts: async () => (await giftMoney.paymentReceipts()) as string });
    if (stealthPayments) verifyPairs.push({ name: "StealthPayments", addr: addresses.StealthPayments, hubReceipts: async () => (await stealthPayments.paymentReceipts()) as string });
    for (const w of wave4Contracts) {
      verifyPairs.push({ name: w.name, addr: w.addr, hubReceipts: async () => (await w.contract.paymentReceipts()) as string });
    }
    let allOk = true;
    for (const p of verifyPairs) {
      const authed = (await receipts.authorizedCallers(p.addr)) as boolean;
      const pointer = (await p.hubReceipts()).toLowerCase();
      const expected = addresses.PaymentReceipts.toLowerCase();
      const ok = authed && pointer === expected;
      if (!ok) {
        allOk = false;
        console.error(`  ✗ ${p.name}: authed=${authed} pointer=${pointer} expected=${expected}`);
      }
    }
    if (!allOk) {
      throw new Error("setup-receipts: one or more hubs are half-wired; see errors above");
    }
    console.log("\n  ✓ All hubs verified bidirectionally wired (§2.7).");

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  Receipts wiring complete. Landing counter increments on every");
    console.log("  sendPayment / batchSend / sendPaymentAsAgent / fulfillRequest /");
    console.log("  runPayroll / createEnvelope / sendStealth (and decrements on");
    console.log("  stealth refund). Recipients across all flows can prove income");
    console.log("  via proveIncomeAbove.");
    console.log("═══════════════════════════════════════════════════════════════\n");
  }
);
