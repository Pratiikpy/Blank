import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Phase 7 #1 — Gift envelope + recipient CLAIMS it.
//
// Sender creates a $1 gift envelope to recipient. Recipient opens /app/gifts,
// their "Received" tab shows the envelope, clicks Claim, signs UserOp. Supabase
// gets a new gift_claimed row for the recipient.

test.describe("Phase 7 #1 — Gift claim cross-account", () => {
  test.setTimeout(900_000);

  test("sender creates gift → recipient claims → gift_claimed row written", async ({ browser }) => {
    const setup = loadSetup();
    const [senderCtx, recipientCtx] = await Promise.all([
      openAccountPage(browser, setup.sender, setup.chainId, "S"),
      openAccountPage(browser, setup.recipient, setup.chainId, "R"),
    ]);

    try {
      // ─── Sender creates a $1 gift envelope to recipient ──────────────
      const s = senderCtx.page;
      const recipientLower = setup.recipient.address.toLowerCase();
      const createdQuery = `activities?user_to=eq.${recipientLower}&activity_type=eq.gift_created`;
      const createBaseline = await captureBaseline(s, createdQuery);

      await s.goto("/app/gifts");
      await s.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await s.waitForTimeout(8_000);

      await s.locator('input[placeholder="0.00"]').first().fill("1");
      await s.locator('input[placeholder*="0x"]').first().fill(setup.recipient.address);
      // Pick Birthday theme (button is required for submit to render)
      await s.getByRole("button", { name: /Select Birthday theme/i }).click();
      await s.waitForTimeout(500);

      await s.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => b.textContent?.includes("Send Gift Envelope"));
        if (target) (target as HTMLButtonElement).click();
      });
      console.log("  [S] clicked Send Gift Envelope");
      await s.waitForTimeout(2_000);
      // Up to 3 prompts: warmup + vault approve + createEnvelope
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(s, PASSPHRASE, 60_000);
          console.log(`  [S] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [S] no prompt #${i + 1}`);
          break;
        }
        await s.waitForTimeout(2_000);
      }
      const createdResult = await pollForNewActivityRow(s, createdQuery, {
        label: "gift-created",
        baselineHashes: createBaseline,
      });
      expect(createdResult.newRows.length, "sender must create gift row").toBeGreaterThan(0);
      const newGiftRow = createdResult.newRows[0];
      console.log(`  [S] new gift row: ${newGiftRow.tx_hash} note=${newGiftRow.note?.slice(0, 60)}`);
      // Extract envelope ID from the note — shape: "[envelope:42] Birthday: ..."
      const envelopeIdMatch = (newGiftRow.note ?? "").match(/\[envelope:(\d+)\]/);
      expect(envelopeIdMatch, "gift note must carry envelope ID").toBeTruthy();
      const envelopeId = parseInt(envelopeIdMatch![1], 10);
      console.log(`  [S] envelope id: ${envelopeId}`);

      await s.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-1a-sender-created.png"), fullPage: true });

      // ─── Recipient claims the gift ───────────────────────────────────
      const r = recipientCtx.page;
      const claimedQuery = `activities?user_to=eq.${recipientLower}&activity_type=eq.gift_claimed`;
      const claimBaseline = await captureBaseline(r, claimedQuery);

      await r.goto("/app/gifts");
      await r.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      // Recipient's received tab is the default; wait for the envelope row to render.
      await r.waitForTimeout(10_000);
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-1b-recipient-received.png"), fullPage: true });

      // Click Claim button — the gift row has an "Open" or "Claim" button
      const claimClickOk = await r.evaluate((envId) => {
        // Look for buttons with claim-ish text; the actual text varies by UI
        // version — "Open", "Claim", etc.
        const candidates = Array.from(document.querySelectorAll("button")).filter((b) =>
          /^(open|claim|accept)$/i.test((b.textContent || "").trim()),
        );
        if (candidates.length === 0) {
          return { ok: false, why: "no claim button found", available: Array.from(document.querySelectorAll("button")).slice(0, 15).map((b) => (b.textContent || "").trim()).filter(Boolean) };
        }
        // Click the first claim button (if multiple envelopes, would need ID match)
        (candidates[0] as HTMLButtonElement).click();
        return { ok: true, clicked: candidates[0].textContent?.trim(), envelopeId: envId };
      }, envelopeId);
      console.log("  [R] claim click:", JSON.stringify(claimClickOk).slice(0, 300));
      expect(claimClickOk.ok, "recipient must find claim button for gift").toBe(true);
      await r.waitForTimeout(2_000);

      console.log("  [R] waiting for claimGift prompts (up to 2 — warmup + claim)...");
      for (let i = 0; i < 4; i++) {
        try {
          await answerPassphrasePrompt(r, PASSPHRASE, 120_000);
          console.log(`  [R] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [R] no prompt #${i + 1} — signed from unlock cache`);
          break;
        }
      }

      const claimed = await pollForNewActivityRow(r, claimedQuery, {
        label: "gift-claimed",
        baselineHashes: claimBaseline,
      });
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-1c-recipient-claimed.png"), fullPage: true });
      expect(claimed.newRows.length, "recipient must see new gift_claimed row").toBeGreaterThan(0);
      console.log("  ✅ Gift claim cross-account verified");
    } finally {
      await Promise.race([
        senderCtx.context.close().catch(() => {}),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
      await Promise.race([
        recipientCtx.context.close().catch(() => {}),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
    }
  });
});
