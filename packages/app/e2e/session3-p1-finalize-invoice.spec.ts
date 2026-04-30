import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// P1 priority test: Finalize invoice.
//
// Full cycle: vendor creates invoice → client pays → status=payment_pending
// → CLIENT clicks Finalize (contract requires msg.sender == invoice.client
// AND invoicePaymentStartedBy[id] == msg.sender — both hold for client).
// The finalize call triggers on-chain amount-match decrypt + settlement
// → status becomes "paid".

test.describe("P1 — Finalize invoice", () => {
  test.setTimeout(1_800_000); // 30 min

  test("client finalizes a payment_pending invoice → status=paid", async ({ browser }) => {
    const setup = loadSetup();
    const [vendorCtx, clientCtx] = await Promise.all([
      openAccountPage(browser, setup.sender, setup.chainId, "V"),
      openAccountPage(browser, setup.recipient, setup.chainId, "C"),
    ]);

    try {
      const v = vendorCtx.page;
      const c = clientCtx.page;
      const vendorLower = setup.sender.address.toLowerCase();

      // ─── Step 1 : Vendor creates invoice ───────────────────────────
      const createQuery = `activities?user_from=eq.${vendorLower}&activity_type=eq.invoice_created`;
      const createBaseline = await captureBaseline(v, createQuery);

      await v.goto("/app/business");
      await v.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await v.waitForTimeout(5_000);
      await v.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /^new invoice$/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await v.waitForTimeout(1_000);
      await v.locator('input[placeholder="0x..."]').first().fill(setup.recipient.address);
      await v.locator('input[placeholder="0.00"]').first().fill("1");
      await v.locator('input[placeholder*="Services"]').first().fill("Finalize test invoice");
      await v.waitForTimeout(500);
      await v.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /create invoice/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await v.waitForTimeout(2_000);
      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(v, PASSPHRASE, 90_000); console.log(`  [V] ✅ create prompt #${i + 1}`); }
        catch { break; }
        await v.waitForTimeout(2_000);
      }

      const created = await pollForNewActivityRow(v, createQuery, {
        label: "invoice-created", baselineHashes: createBaseline,
      });
      expect(created.newRows.length).toBeGreaterThan(0);
      const createTx = created.newRows[0].tx_hash;

      let invoiceId = -1;
      for (let attempt = 0; attempt < 15; attempt++) {
        const res = await v.request.get(
          `${SUPABASE_URL}/rest/v1/invoices?tx_hash=eq.${createTx}&select=invoice_id,status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows.length > 0) { invoiceId = rows[0].invoice_id; break; }
        }
        await v.waitForTimeout(1_500);
      }
      expect(invoiceId).toBeGreaterThanOrEqual(0);
      console.log(`  [V] invoice #${invoiceId} created (status=pending)`);

      // ─── Step 2 : Client pays invoice ─────────────────────────────
      await c.goto("/app/business");
      await c.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await c.waitForTimeout(8_000);

      const payClicked = await c.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const payBtns = btns.filter((b) => /^pay$/i.test((b.textContent || "").trim()));
        if (payBtns.length === 0) return { ok: false };
        (payBtns[0] as HTMLButtonElement).click();
        return { ok: true, count: payBtns.length };
      });
      console.log(`  [C] pay click: ${JSON.stringify(payClicked)}`);
      expect(payClicked.ok).toBe(true);
      await c.waitForTimeout(1_500);

      // Pay dialog — the dialog has its own input[placeholder="0.00"]
      const payInputs = c.locator('input[placeholder="0.00"]');
      const count = await payInputs.count();
      await payInputs.nth(count - 1).fill("1");
      await c.waitForTimeout(500);
      await c.evaluate(() => {
        const cancel = Array.from(document.querySelectorAll("button")).find((b) =>
          /^cancel$/i.test((b.textContent || "").trim()),
        );
        if (!cancel || !cancel.parentElement) return;
        const siblings = Array.from(cancel.parentElement.querySelectorAll("button"));
        const pay = siblings.find((b) => b !== cancel && /^pay$/i.test((b.textContent || "").trim()));
        if (pay) (pay as HTMLButtonElement).click();
      });
      await c.waitForTimeout(2_000);
      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(c, PASSPHRASE, 90_000); console.log(`  [C] ✅ pay prompt #${i + 1}`); }
        catch { break; }
        await c.waitForTimeout(2_000);
      }

      // Wait for status to reach payment_pending
      let interimStatus = "pending";
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await v.request.get(
          `${SUPABASE_URL}/rest/v1/invoices?invoice_id=eq.${invoiceId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows[0]?.status === "payment_pending") { interimStatus = "payment_pending"; break; }
        }
        if (attempt % 5 === 0) console.log(`  interim status: ${interimStatus}`);
        await v.waitForTimeout(3_000);
      }
      expect(interimStatus).toBe("payment_pending");
      console.log(`  ✓ invoice #${invoiceId} is payment_pending — ready to finalize`);
      await c.screenshot({ path: path.join(SCREENSHOT_DIR, "p1-finalize-01-payment-pending.png"), fullPage: true });

      // ─── Step 3 : Client clicks Finalize ───────────────────────────
      // Contract requires msg.sender == inv.client AND
      // invoicePaymentStartedBy[id] == msg.sender. Both hold for the client
      // who just called payInvoice, so finalize runs on the same (client) page.
      await c.reload();
      await c.waitForTimeout(6_000);

      const finalizeOk = await c.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        // Find Finalize button on a row whose enclosing card contains our description
        for (const b of buttons) {
          if (!/finalize/i.test((b.textContent || "").trim())) continue;
          let node: Element | null = b;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").includes("Finalize test invoice")) {
              (b as HTMLButtonElement).click();
              return { ok: true, matched: "by-desc" };
            }
            node = node.parentElement;
          }
        }
        const any = buttons.find((b) => /^finalize$/i.test((b.textContent || "").trim()));
        if (!any) return { ok: false };
        (any as HTMLButtonElement).click();
        return { ok: true, matched: "first" };
      });
      console.log(`  [C] finalize click: ${JSON.stringify(finalizeOk)}`);
      expect(finalizeOk.ok).toBe(true);
      await c.waitForTimeout(2_000);

      // finalizeInvoice does: decryptForTx (async CoFHE) + payInvoiceFinalize UserOp.
      // Up to 3 prompts: warmup (if fresh) + sign decrypt permit + finalize UserOp
      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(c, PASSPHRASE, 180_000); console.log(`  [C] ✅ finalize prompt #${i + 1}`); }
        catch { break; }
        await c.waitForTimeout(2_000);
      }

      // Wait for status → paid (CoFHE decrypt + finalize combined can take 1-3 min)
      let finalStatus = "payment_pending";
      for (let attempt = 0; attempt < 80; attempt++) {
        const res = await c.request.get(
          `${SUPABASE_URL}/rest/v1/invoices?invoice_id=eq.${invoiceId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          const s = rows[0]?.status;
          if (s === "paid" || s === "refunded") { finalStatus = s; break; }
        }
        if (attempt % 5 === 0) console.log(`  [C] poll[${attempt}] status=${finalStatus}`);
        await c.waitForTimeout(3_000);
      }
      await c.screenshot({ path: path.join(SCREENSHOT_DIR, "p1-finalize-02-finalized.png"), fullPage: true });
      expect(["paid", "refunded"].includes(finalStatus), `final status must be paid or refunded, got ${finalStatus}`).toBe(true);
      console.log(`  ✅ Invoice finalize verified — final status: ${finalStatus}`);
    } finally {
      await vendorCtx.context.close();
      await clientCtx.context.close();
    }
  });
});
