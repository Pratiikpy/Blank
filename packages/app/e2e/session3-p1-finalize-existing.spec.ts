import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Debug test: finalize existing payment_pending invoice.
// Skips create+pay setup; assumes invoice #10 exists in payment_pending state.

test.describe("Debug — Finalize existing payment_pending invoice", () => {
  test.setTimeout(900_000);

  test("click Finalize button on existing payment_pending invoice → status paid", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "V");
    try {
      const v = ctx.page;
      const vendorLower = setup.sender.address.toLowerCase();

      // Find ANY payment_pending invoice owned by vendor
      const res = await v.request.get(
        `${SUPABASE_URL}/rest/v1/invoices?vendor_address=eq.${vendorLower}&status=eq.payment_pending&order=created_at.desc&limit=1&select=invoice_id,description`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      const rows = await res.json();
      expect(rows.length, "at least one payment_pending invoice must exist").toBeGreaterThan(0);
      const invoiceId = rows[0].invoice_id;
      const desc = rows[0].description;
      console.log(`  [V] targeting invoice #${invoiceId} (${desc})`);

      await v.goto("/app/business");
      await v.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await v.waitForTimeout(8_000);
      await v.screenshot({ path: path.join(SCREENSHOT_DIR, "debug-finalize-01-loaded.png"), fullPage: true });

      // Capture what the DOM looks like around Finalize buttons
      const domInspection = await v.evaluate((descText) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const finalizeBtns = buttons.filter((b) => /^finalize$/i.test((b.textContent || "").trim()));
        const details = finalizeBtns.map((b) => {
          const card = b.closest("[class*=glass-card], [class*=card], div.flex") as HTMLElement | null;
          return {
            text: b.textContent?.trim(),
            disabled: b.disabled,
            cardText: card?.innerText?.slice(0, 200),
          };
        });
        return { count: finalizeBtns.length, details, descText };
      }, desc);
      console.log("  [V] finalize buttons in DOM:", JSON.stringify(domInspection, null, 2));

      // Click the first non-disabled Finalize button
      const clicked = await v.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const target = buttons.find((b) => /^finalize$/i.test((b.textContent || "").trim()) && !b.disabled);
        if (!target) return { ok: false };
        target.click();
        return { ok: true };
      });
      console.log(`  [V] click result: ${JSON.stringify(clicked)}`);
      expect(clicked.ok).toBe(true);
      await v.waitForTimeout(3_000);

      // Up to 2 prompts (finalizeInvoice uses decrypt without permit + 1 UserOp)
      for (let i = 0; i < 2; i++) {
        try { await answerPassphrasePrompt(v, PASSPHRASE, 180_000); console.log(`  [V] ✅ prompt #${i + 1}`); }
        catch { break; }
        await v.waitForTimeout(2_000);
      }

      // Poll for status change
      let finalStatus = "payment_pending";
      for (let attempt = 0; attempt < 80; attempt++) {
        const r = await v.request.get(
          `${SUPABASE_URL}/rest/v1/invoices?invoice_id=eq.${invoiceId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (r.status() === 200) {
          const rs = await r.json();
          const s = rs[0]?.status;
          if (s === "paid" || s === "refunded") { finalStatus = s; break; }
        }
        if (attempt % 5 === 0) console.log(`  [V] poll[${attempt}] status=${finalStatus}`);
        await v.waitForTimeout(3_000);
      }
      await v.screenshot({ path: path.join(SCREENSHOT_DIR, "debug-finalize-02-done.png"), fullPage: true });
      expect(["paid", "refunded"]).toContain(finalStatus);
      console.log(`  ✅ Finalize verified — status: ${finalStatus}`);
    } finally {
      await ctx.context.close();
    }
  });
});
