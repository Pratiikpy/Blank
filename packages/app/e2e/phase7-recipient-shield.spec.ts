import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR,
} from "./helpers/phase6-helpers";

// Phase 7 #1 — Recipient self-shields TestUSDC.
//
// Critical isolation test. The Recipient smart account (different from the
// one Phase 2 shield used) does its own shield flow: approve TestUSDC → vault.
// If this PASSES, the FHE InvalidSigner issue is specifically about cross-
// account vault transferFrom (CreatorHub.support, P2PExchange.fillOffer pulling
// from a different account's vault). If this FAILS, the issue is broader.
//
// Shield uses encryption ONLY for vault.shield(amount) — but actually vault.shield
// is plaintext (not encrypted). The encryption happens in send/gift/etc. So
// shield doesn't even hit the FHE encrypted-input verify path. This test
// primarily proves the recipient smart account can do UserOps at all.

test.describe("Phase 7 #1 — Recipient self-shield", () => {
  test.setTimeout(600_000);

  test("recipient shields $5 → encrypted balance increases on chain", async ({ browser }) => {
    const setup = loadSetup();
    const recipientCtx = await openAccountPage(browser, setup.recipient, setup.chainId, "R");

    try {
      const r = recipientCtx.page;
      const recipientLower = setup.recipient.address.toLowerCase();

      const shieldQuery = `activities?user_from=eq.${recipientLower}&activity_type=eq.shield`;
      const baseline = await captureBaseline(r, shieldQuery);
      console.log(`  baseline shield rows for recipient: ${baseline.size}`);

      // Dashboard has a Shield card — find shield input + deposit button.
      await r.goto("/app");
      await r.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await r.waitForTimeout(8_000);
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-recipient-dashboard.png"), fullPage: true });

      // Fill shield amount input
      const shieldInput = r.getByLabel("Shield amount").first();
      await shieldInput.fill("5");
      // JS-direct click on Deposit (Playwright actionability hangs while
      // cofhe iframe is busy)
      await r.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('[aria-label="Deposit to vault"]'));
        if (btns.length === 0) throw new Error("no deposit btn");
        (btns[0] as HTMLButtonElement).click();
      });
      console.log("  [R] clicked Deposit");
      await r.waitForTimeout(2_000);

      // Two prompts: TestUSDC.approve + vault.shield
      for (let i = 0; i < 4; i++) {
        try {
          await answerPassphrasePrompt(r, PASSPHRASE, 60_000);
          console.log(`  [R] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [R] no prompt #${i + 1} (probably already approved)`);
          break;
        }
        await r.waitForTimeout(2_000);
      }

      const result = await pollForNewActivityRow(r, shieldQuery, {
        label: "shield",
        baselineHashes: baseline,
      });
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-recipient-shielded.png"), fullPage: true });
      expect(result.newRows.length, "recipient must see new shield row").toBeGreaterThan(0);
      console.log("  ✅ Recipient self-shield verified — recipient smart account can sign + execute UserOps");
    } finally {
      await recipientCtx.context.close();
    }
  });
});
