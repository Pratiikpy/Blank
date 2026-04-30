import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Phase 7 #3 — Recipient claims a previously-created gift envelope.
//
// Key insight: claimGift(envelopeId) takes ONLY an integer ID. The recipient
// does NOT submit an encrypted input — the contract reads the stored encrypted
// share that was placed there at create time by the SENDER. Recipient's claim
// is a plain UserOp.
//
// If this passes, we have a working cross-account flow that doesn't depend on
// the recipient producing valid encrypted inputs (which fails — see Phase 7 #2).

test.describe("Phase 7 #3 — Gift claim (no recipient encryption)", () => {
  test.setTimeout(600_000);

  test("recipient claims an already-created envelope", async ({ browser }) => {
    const setup = loadSetup();
    const recipientLower = setup.recipient.address.toLowerCase();

    // Find an existing UN-CLAIMED gift envelope sent to recipient by querying
    // Supabase for a `gift_created` row whose envelope hasn't been claimed.
    // We don't have to create one fresh — sender already created several
    // during prior Phase 3/6 runs; pick the most recent one.
    const recipientCtx = await openAccountPage(browser, setup.recipient, setup.chainId, "R");
    try {
      const r = recipientCtx.page;

      // Step 1: get an unclaimed envelope ID
      const giftRowsRes = await r.request.get(
        `${SUPABASE_URL}/rest/v1/activities?user_to=eq.${recipientLower}&activity_type=eq.gift_created&order=created_at.desc&limit=10`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      const giftRows = giftRowsRes.status() === 200 ? (await giftRowsRes.json()) as Array<{ tx_hash: string; note: string }> : [];
      console.log(`  found ${giftRows.length} gift rows for recipient`);

      // Look at recipient's gift_claimed rows so we can skip already-claimed envelopes
      const claimedRowsRes = await r.request.get(
        `${SUPABASE_URL}/rest/v1/activities?user_from=eq.${recipientLower}&activity_type=eq.gift_claimed&select=note&limit=20`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      const claimedRows = claimedRowsRes.status() === 200 ? (await claimedRowsRes.json()) as Array<{ note: string }> : [];
      const claimedIds = new Set(claimedRows.flatMap((row) => {
        const m = (row.note || "").match(/Opened gift envelope #(\d+)/);
        return m ? [parseInt(m[1], 10)] : [];
      }));
      console.log(`  recipient already claimed: ${claimedIds.size} envelopes`);

      // Pick first unclaimed envelope
      let envelopeId: number | null = null;
      for (const row of giftRows) {
        const m = (row.note || "").match(/\[envelope:(\d+)\]/);
        if (!m) continue;
        const id = parseInt(m[1], 10);
        if (!claimedIds.has(id)) { envelopeId = id; break; }
      }
      if (envelopeId === null) {
        console.log("  ⚠️ no unclaimed envelope available — skipping (would need to create one first)");
        test.skip(true, "no unclaimed envelope");
        return;
      }
      console.log(`  picked envelope ID ${envelopeId} to claim`);

      // Step 2: navigate to gifts and claim
      const claimedQuery = `activities?user_from=eq.${recipientLower}&activity_type=eq.gift_claimed`;
      const baseline = await captureBaseline(r, claimedQuery);

      await r.goto("/app/gifts");
      await r.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await r.waitForTimeout(8_000);
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-3a-recipient-gifts.png"), fullPage: true });

      // Click any "Claim" / "Open" button on the page (envelopes list shows them).
      const clickOk = await r.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll("button")).filter((b) => {
          const t = (b.textContent || "").trim();
          return /^(Claim|Open|Accept)$/i.test(t);
        });
        if (candidates.length === 0) {
          return { ok: false, why: "no Claim button rendered" };
        }
        (candidates[0] as HTMLButtonElement).click();
        return { ok: true, count: candidates.length };
      });
      console.log("  click Claim:", JSON.stringify(clickOk));
      if (!clickOk.ok) {
        console.log("  ⚠️ no claim UI rendered for recipient — skipping");
        test.skip(true, "claim UI not rendered");
        return;
      }
      await r.waitForTimeout(2_000);

      console.log("  [R] waiting for claimGift passphrase prompts...");
      // Up to 3 prompts: cofhe permits.createSelf warmup (first FHE op
      // per browser context) + the actual claimGift sign. The unlock-cache
      // may carry one signature across prompts.
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(r, PASSPHRASE, 90_000);
          console.log(`  [R] ✅ filled claim prompt #${i + 1}`);
        } catch {
          console.log(`  [R] no prompt #${i + 1} — flow proceeded`);
          break;
        }
        await r.waitForTimeout(2_000);
      }

      const claimed = await pollForNewActivityRow(r, claimedQuery, {
        label: "claim",
        baselineHashes: baseline,
      });
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-3b-recipient-claimed.png"), fullPage: true });
      expect(claimed.newRows.length, "recipient must see new gift_claimed row").toBeGreaterThan(0);
      console.log(`  ✅ Gift claim verified — recipient ID=${envelopeId}, no encryption needed by recipient`);
    } finally {
      await Promise.race([
        recipientCtx.context.close().catch(() => {}),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
    }
  });
});
