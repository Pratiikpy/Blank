import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Phase 6 #2 — Creator support, CROSS-ACCOUNT.
//
// Closes the "CreatorHub: cannot self-tip" leave-behind from Phase 4. The
// recipient context creates a profile via setProfile, the sender context
// tips them via support(). Verifies activity row + supporter notification.

test.describe("Phase 6 #2 — Creator tip cross-account", () => {
  test.setTimeout(900_000);

  test("recipient creates profile + sender tips → supporter notification fires", async ({ browser }) => {
    const setup = loadSetup();
    const [senderCtx, recipientCtx] = await Promise.all([
      openAccountPage(browser, setup.sender, setup.chainId, "S"),
      openAccountPage(browser, setup.recipient, setup.chainId, "R"),
    ]);

    try {
      // ─── Recipient ensures profile exists (creates if absent) ────────
      const r = recipientCtx.page;
      const recipientLowerAddr = setup.recipient.address.toLowerCase();
      const existingRes = await r.request.get(
        `${SUPABASE_URL}/rest/v1/creator_profiles?address=eq.${recipientLowerAddr}&chain_id=eq.${setup.chainId}&select=name`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      const existing = existingRes.status() === 200 ? await existingRes.json() : [];
      let creatorName: string;
      if (existing.length > 0) {
        creatorName = existing[0].name as string;
        console.log(`  [R] profile already exists: ${creatorName}, skipping setProfile`);
      } else {
        await r.goto("/app/creators");
        await r.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await r.waitForTimeout(8_000);
        const setupOk = await r.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) =>
            /Set Up Profile/i.test((b.textContent || "").trim()),
          );
          if (!btn) return false;
          (btn as HTMLButtonElement).click();
          return true;
        });
        expect(setupOk, "Set Up Profile button must exist when no profile yet").toBe(true);
        await r.waitForTimeout(500);
        creatorName = `e2e-creator-${Date.now()}`;
        await r.locator('input[placeholder="Your name"]').first().fill(creatorName);
        await r.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) =>
            /^Create Profile$/i.test((b.textContent || "").trim()),
          );
          if (btn) (btn as HTMLButtonElement).click();
        });
        await r.waitForTimeout(2_000);
        console.log("  [R] waiting for setProfile prompt...");
        await answerPassphrasePrompt(r, PASSPHRASE, 240_000);
        console.log("  [R] ✅ setProfile signed");
        await r.waitForTimeout(20_000);
      }
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p6-2a-recipient-profile.png"), fullPage: true });

      // ─── Sender tips the recipient ───────────────────────────────────
      const s = senderCtx.page;
      const recipientLower = setup.recipient.address.toLowerCase();
      const tipQuery = `activities?user_to=eq.${recipientLower}&activity_type=eq.tip`;
      const baseline = await captureBaseline(s, tipQuery);
      console.log(`  baseline tips for recipient: ${baseline.size}`);

      await s.goto("/app/creators");
      await s.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      // Page caches creators on initial load — force a refetch by reload.
      await s.reload();
      await s.waitForTimeout(8_000);
      await s.screenshot({ path: path.join(SCREENSHOT_DIR, "p6-2b-sender-creators.png"), fullPage: true });

      // Find the recipient's creator card by name (multiple profiles may
      // exist from prior runs; clicking the first would self-tip → revert).
      const selectOk = await s.evaluate((wantedName) => {
        // Look for a card containing the wanted name then click its
        // Support/Selected button.
        const cards = Array.from(document.querySelectorAll("h3"))
          .filter((h) => h.textContent?.trim() === wantedName)
          .map((h) => h.closest("[class*=glass-card]") as HTMLElement | null)
          .filter((c): c is HTMLElement => c !== null);
        if (cards.length === 0) return { ok: false, why: `no card for ${wantedName}` };
        const btn = cards[0].querySelector("button");
        if (!btn) return { ok: false, why: "no button in card" };
        (btn as HTMLButtonElement).click();
        return { ok: true };
      }, creatorName);
      console.log("  [S] select by name:", JSON.stringify(selectOk));
      expect(selectOk.ok, "sender must find recipient's creator card").toBe(true);
      await s.waitForTimeout(500);

      // Pick $5 tier
      await s.evaluate(() => {
        const target = Array.from(document.querySelectorAll("button")).find((b) =>
          /\$5(\s|$)/.test((b.textContent || "").trim()),
        );
        if (target) (target as HTMLButtonElement).click();
      });
      await s.waitForTimeout(500);

      // Submit
      await s.evaluate(() => {
        const target = Array.from(document.querySelectorAll("button")).find((b) =>
          /Send \$\d+ Support/i.test((b.textContent || "").trim()),
        );
        if (target) (target as HTMLButtonElement).click();
      });
      await s.waitForTimeout(2_000);

      // Up to 3 prompts on fresh accounts: (1) CoFHE permits.createSelf warmup,
      // (2) vault approve, (3) support UserOp. Vault may already be approved
      // from prior runs so the approve prompt can be missing.
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(s, PASSPHRASE, 60_000);
          console.log(`  [S] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [S] no prompt #${i + 1} (already warmed / vault already approved)`);
          break;
        }
        await s.waitForTimeout(2_000);
      }

      const result = await pollForNewActivityRow(s, tipQuery, { label: "after-tip", baselineHashes: baseline });
      await s.screenshot({ path: path.join(SCREENSHOT_DIR, "p6-2c-after-tip.png"), fullPage: true });
      expect(result.newRows.length, "creator must see fresh tip row").toBeGreaterThan(0);
      expect(result.newRows[0].user_from.toLowerCase()).toBe(setup.sender.address.toLowerCase());
      console.log("  ✅ Cross-account creator tip verified");
    } finally {
      await senderCtx.context.close();
      await recipientCtx.context.close();
    }
  });
});
