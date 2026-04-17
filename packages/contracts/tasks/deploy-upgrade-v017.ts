import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── v0.1.7 upgrade task ──────────────────────────────────────────────
// Five storage-safe UUPS in-place upgrades that finish wiring every payment
// flow into PaymentReceipts so (a) the landing-page encrypted volume counter
// reflects ALL on-platform value movement and (b) every recipient flow lands
// in someone's per-user `_totalReceived` counter for proveIncomeAbove —
// PLUS BusinessHub concurrency / access-control hardening (#212/#213/#214).
//
//   - PaymentHub (#207):       sendPayment / batchSend / fulfillRequest /
//                              sendPaymentAsAgent now call
//                              paymentReceipts.bumpUserReceived(recipient)
//                              in addition to the existing global volume bump.
//                              Refactored `_bumpAggregate(amount)` to
//                              `_bumpAggregate(recipient, amount)`. Internal
//                              fn — signature change is upgrade-safe. NO
//                              storage change.
//
//   - PaymentReceipts (#199):  Adds `decrementGlobalVolume(euint64)` which
//                              clamps at zero via FHE.select so a refund
//                              larger than current volume can't underflow
//                              the encrypted counter to 2^64-1. NO storage
//                              change (function-only addition).
//
//   - GiftMoney (#204):        createEnvelope now bumps both the per-recipient
//                              `_totalReceived` counter AND the global volume
//                              for every share transferred. Adds `address
//                              public paymentReceipts` storage at the end
//                              (slot 10 — was slot 9 `_sentEnvelopes`). One
//                              new state slot, fully append-only.
//
//   - StealthPayments (#199):  sendStealth now bumps the global encrypted
//                              volume; refund decrements the same. Without
//                              this, refunded stealth value would
//                              permanently over-count the landing counter.
//                              Adds `address public paymentReceipts` storage
//                              at the end. One new state slot, append-only.
//
//   - BusinessHub (#212/#213/#214):
//                              #213 — payInvoiceFinalize now requires
//                              msg.sender == inv.client (was: anyone with the
//                              decryption signature could finalize).
//                              #212 — markDelivered now mirrors approveRelease's
//                              release-check, so the (approve-then-deliver)
//                              ordering also auto-releases instead of stranding
//                              funds. Refactored to call shared internal
//                              `_releaseEscrow` helper. Adds an EscrowDelivered
//                              activity event for symmetry.
//                              #214 — Adds `mapping(uint256 => address)
//                              public invoicePaymentStartedBy` (slot 11,
//                              append-only). payInvoice locks first payer in;
//                              payInvoiceFinalize re-asserts payment-starter ==
//                              msg.sender. cancelInvoice resets the slot.
//                              One new state slot, fully append-only.
//
// CreatorHub (#202): NO upgrade. Verified `supporterCount` already only
//   increments on the FIRST tip from a given supporter (dedup'd via
//   `_hasContributed[creator][msg.sender]`), so the counter stays correct in
//   the existing model. Refunds aren't supported for tips and adding them
//   would require recipient cooperation + a redesigned flow — deferred.
//
// Storage layouts: GiftMoney + StealthPayments + BusinessHub must be
// re-snapshotted via `pnpm storage:write`, then committed and verified by CI
// via `pnpm storage:check`. Expect:
//   GiftMoney:        +1 slot (paymentReceipts at slot 10)
//   StealthPayments:  +1 slot (paymentReceipts at the end)
//   BusinessHub:      +1 slot (invoicePaymentStartedBy at slot 11)
//   PaymentReceipts:  no storage change (function-only)
//   PaymentHub:       no storage change (internal signature only)
//
// Post-upgrade — run setup-receipts so the new wiring is active:
//   npx hardhat setup-receipts --network <network>
//
// Run (human step — NOT part of this task-creation commit):
//   npx hardhat deploy-upgrade-v017 --network eth-sepolia
//   npx hardhat deploy-upgrade-v017 --network base-sepolia
//   npx hardhat setup-receipts        --network eth-sepolia
//   npx hardhat setup-receipts        --network base-sepolia

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const dir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(dir, `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2));
  console.log(`\nDeployment updated: ${filePath}`);
}

async function upgradeInPlace(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  proxyAddress: string,
): Promise<string> {
  console.log(`     proxy:`, proxyAddress);
  const Factory = await hre.ethers.getContractFactory(contractName);
  const newImpl = await Factory.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddress = await newImpl.getAddress();
  console.log(`     new impl:`, newImplAddress);

  const proxy = Factory.attach(proxyAddress);
  // upgradeToAndCall("0x") — empty calldata = no re-init, just swap impl
  const tx = await (proxy as any).upgradeToAndCall(newImplAddress, "0x");
  await tx.wait(2);
  console.log(`     ✓ upgraded`);
  return newImplAddress;
}

task(
  "deploy-upgrade-v017",
  "Upgrade contracts in place for v0.1.7 (#207 PaymentHub per-user receipts, #199 PaymentReceipts decrement + StealthPayments refund decrement, #204 GiftMoney receipts wiring, #212/#213/#214 BusinessHub concurrency + access-control hardening)",
).setAction(async (_, hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const addresses = loadDeployment(hre.network.name);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Blank — v0.1.7 Receipts-Wiring Upgrade");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Deployer:", deployer.address);
  console.log("  Network: ", hre.network.name);
  console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("1/5  PaymentHub upgrade (#207 — per-user receipts on every flow)...");
  const paymentHubImpl = await upgradeInPlace(hre, "PaymentHub", addresses.PaymentHub);
  addresses.PaymentHub_Impl = paymentHubImpl;

  console.log("\n2/5  PaymentReceipts upgrade (#199 — decrementGlobalVolume)...");
  const receiptsImpl = await upgradeInPlace(hre, "PaymentReceipts", addresses.PaymentReceipts);
  addresses.PaymentReceipts_Impl = receiptsImpl;

  if (!addresses.GiftMoney) {
    console.log("\n3/5  GiftMoney — SKIP (not deployed on this network)");
  } else {
    console.log("\n3/5  GiftMoney upgrade (#204 — receipts wiring on createEnvelope)...");
    const giftImpl = await upgradeInPlace(hre, "GiftMoney", addresses.GiftMoney);
    addresses.GiftMoney_Impl = giftImpl;
  }

  if (!addresses.StealthPayments) {
    console.log("\n4/5  StealthPayments — SKIP (not deployed on this network)");
  } else {
    console.log("\n4/5  StealthPayments upgrade (#199 — refund decrements global volume)...");
    const stealthImpl = await upgradeInPlace(hre, "StealthPayments", addresses.StealthPayments);
    addresses.StealthPayments_Impl = stealthImpl;
  }

  if (!addresses.BusinessHub) {
    console.log("\n5/5  BusinessHub — SKIP (not deployed on this network)");
  } else {
    console.log("\n5/5  BusinessHub upgrade (#212/#213/#214 — escrow/invoice hardening)...");
    const businessImpl = await upgradeInPlace(hre, "BusinessHub", addresses.BusinessHub);
    addresses.BusinessHub_Impl = businessImpl;
  }

  saveDeployment(hre.network.name, addresses);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  v0.1.7 Upgrade Complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\n  Next: run `npx hardhat setup-receipts --network", hre.network.name + "`");
  console.log("  to authorize GiftMoney + StealthPayments on PaymentReceipts and");
  console.log("  point them at the receipts contract.");
  console.log();
  console.log("  Then verify: storage layouts should match the committed snapshots");
  console.log("  (pnpm storage:check). Expect +1 slot on GiftMoney, StealthPayments,");
  console.log("  and BusinessHub (paymentReceipts/invoicePaymentStartedBy at the end).");
  console.log();
});
