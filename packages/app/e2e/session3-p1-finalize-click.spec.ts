import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Fast E2E for Finalize Invoice: skip create+pay, use an existing
// payment_pending row from a prior run (data-path test confirmed they exist).
// Flow:
//   1. Client opens /app/business
//   2. Clicks first Finalize button
//   3. Answers up to 3 prompts (warmup + decrypt sign + UserOp)
//   4. Polls Supabase for status=paid (async CoFHE decrypt takes 1-3 min)

test.describe("P1 — Finalize click → status=paid", () => {
  test.setTimeout(1_200_000); // 20 min

  test("client clicks Finalize on existing payment_pending invoice", async ({ browser }) => {
    const setup = loadSetup();
    const clientCtx = await openAccountPage(browser, setup.recipient, setup.chainId, "C");

    try {
      const c = clientCtx.page;
      const clientAddr = setup.recipient.address.toLowerCase();

      // Capture a snapshot of existing payment_pending invoice IDs before we click
      const preRes = await c.request.get(
        `${SUPABASE_URL}/rest/v1/invoices?client_address=eq.${clientAddr}` +
          `&status=eq.payment_pending&chain_id=eq.${setup.chainId}&select=invoice_id&order=invoice_id.desc`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      expect(preRes.status()).toBe(200);
      const pendingIds = ((await preRes.json()) as Array<{ invoice_id: number }>).map((r) => r.invoice_id);
      console.log(`  payment_pending invoice ids: [${pendingIds.join(", ")}]`);
      if (pendingIds.length === 0) {
        console.log("  ⏭  No payment_pending invoices — skipping click test");
        test.skip(true, "No payment_pending invoices in DB to exercise Finalize");
        return;
      }
      const targetId = pendingIds[0];

      await c.goto("/app/business");
      await c.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await c.waitForTimeout(8_000);
      await c.screenshot({ path: path.join(SCREENSHOT_DIR, "click-01-loaded.png"), fullPage: true });

      const click = await c.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const finalize = buttons.find((b) => /^finalize$/i.test((b.textContent || "").trim()));
        if (!finalize || (finalize as HTMLButtonElement).disabled) return { ok: false };
        (finalize as HTMLButtonElement).click();
        return { ok: true };
      });
      console.log(`  finalize click: ${JSON.stringify(click)}`);
      expect(click.ok).toBe(true);
      await c.waitForTimeout(2_000);

      // finalizeInvoice: decrypt permit warmup (if cold) + sign decrypt + UserOp
      for (let i = 0; i < 4; i++) {
        try {
          await answerPassphrasePrompt(c, PASSPHRASE, 180_000);
          console.log(`  ✅ finalize prompt #${i + 1}`);
        } catch {
          break;
        }
        await c.waitForTimeout(2_000);
      }

      // Poll DB for status change — allow up to 10 min for async decrypt+finalize
      let finalStatus = "payment_pending";
      for (let attempt = 0; attempt < 200; attempt++) {
        const res = await c.request.get(
          `${SUPABASE_URL}/rest/v1/invoices?invoice_id=eq.${targetId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          const s = rows[0]?.status;
          if (s === "paid" || s === "refunded") { finalStatus = s; break; }
        }
        if (attempt % 10 === 0) console.log(`  poll[${attempt}] status=${finalStatus}`);
        await c.waitForTimeout(3_000);
      }

      await c.screenshot({ path: path.join(SCREENSHOT_DIR, "click-02-after.png"), fullPage: true });
      console.log(`  invoice #${targetId} final status: ${finalStatus}`);
      expect(["paid", "refunded"]).toContain(finalStatus);
    } finally {
      await clientCtx.context.close();
    }
  });
});
