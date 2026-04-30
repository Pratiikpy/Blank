import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR,
} from "./helpers/phase6-helpers";

// Phase 7 #2 — Recipient sends $1 BACK to sender via PaymentHub.
//
// Critical isolation:
// - If this passes → recipient smart account can produce encrypted inputs that
//   verify on PaymentHub. So the InvalidSigner bug is CONTRACT-SPECIFIC
//   (CreatorHub/P2PExchange only) — likely something about their on-chain ABI
//   layout, custom struct verification, or upgrade proxy state.
// - If this fails → the InvalidSigner bug is broader: any smart-account
//   passkey-signed encryption is broken cross-contract somehow.

test.describe("Phase 7 #2 — Recipient sends back to sender via PaymentHub", () => {
  test.setTimeout(900_000);

  test("recipient sends $1 → sender activity row appears", async ({ browser }) => {
    const setup = loadSetup();
    const recipientCtx = await openAccountPage(browser, setup.recipient, setup.chainId, "R");

    try {
      const r = recipientCtx.page;
      // For this test, recipient is the SENDER and the original sender is the
      // recipient.
      const newRecipientLower = setup.sender.address.toLowerCase();
      const senderLower = setup.recipient.address.toLowerCase();

      const sentQuery = `activities?user_to=eq.${newRecipientLower}&user_from=eq.${senderLower}&activity_type=eq.payment`;
      const baseline = await captureBaseline(r, sentQuery);
      console.log(`  baseline payment rows for sender→original-sender: ${baseline.size}`);

      // Drive the send flow as recipient
      await r.goto("/app/send");
      await r.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await r.waitForTimeout(2_000);

      const recipientInput = r.locator('input[placeholder*="0x"], input[aria-label*="address" i], input[name*="recipient" i]').first();
      if (await recipientInput.isVisible().catch(() => false)) {
        await recipientInput.fill(setup.sender.address);
      } else {
        await r.locator('input[type="text"]:not([placeholder*="search" i])').first().fill(setup.sender.address);
      }
      await r.getByRole("button", { name: /^continue$/i }).first().click();

      await r.waitForURL(/\/app\/send\/amount/, { timeout: 10_000 });
      await r.getByRole("button", { name: /^1$/ }).first().click();
      await r.getByRole("button", { name: /continue/i }).first().click();

      await r.waitForURL(/\/app\/send\/confirm/, { timeout: 10_000 });
      await r.waitForTimeout(8_000); // SmartAccountCofheBinder

      await r.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) =>
          /Confirm & Send/i.test((x.textContent || "").trim()),
        );
        if (!b) throw new Error("no Confirm & Send btn");
        (b as HTMLButtonElement).click();
      });

      // Up to 3 prompts on fresh accounts: (1) permits.createSelf warmup for
      // CoFHE zkVerify backend, (2) vault approve, (3) sendPayment UserOp.
      // The 3rd may not appear if the account is already warmed (localStorage
      // cache hit), so swallow its timeout.
      console.log("  [R] waiting for prompts...");
      await answerPassphrasePrompt(r, PASSPHRASE, 240_000);
      console.log("  [R] ✅ filled prompt #1 (warmup or approve)");
      await answerPassphrasePrompt(r, PASSPHRASE, 240_000);
      console.log("  [R] ✅ filled prompt #2 (approve or send)");
      try {
        await answerPassphrasePrompt(r, PASSPHRASE, 30_000);
        console.log("  [R] ✅ filled prompt #3 (send)");
      } catch {
        console.log("  [R] no 3rd prompt — account already warmed");
      }

      await r.waitForURL(/\/app\/send\/success/, { timeout: 240_000 });
      console.log("  [R] ✅ Send succeeded — recipient smart account can encrypt + submit via PaymentHub");
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-recipient-send-back.png"), fullPage: true });

      const result = await pollForNewActivityRow(r, sentQuery, {
        label: "send-back",
        baselineHashes: baseline,
      });
      expect(result.newRows.length, "must see new payment row").toBeGreaterThan(0);
      expect(result.newRows[0].user_from.toLowerCase()).toBe(senderLower);
      console.log("  ✅ Recipient encrypts + PaymentHub accepts — InvalidSigner is CONTRACT-SPECIFIC, not account-wide");
    } finally {
      await recipientCtx.context.close();
    }
  });
});
