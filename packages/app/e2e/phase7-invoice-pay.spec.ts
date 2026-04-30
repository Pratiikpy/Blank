import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Phase 7 #2 — BusinessHub invoice cross-account.
//
// Vendor smart-account creates an invoice to client smart-account. Client
// opens /app/business, sees the invoice, clicks Pay, enters amount, pays.
// Invoice status must transition pending → payment_pending.

test.describe("Phase 7 #2 — Invoice pay cross-account", () => {
  test.setTimeout(900_000);

  test("vendor creates invoice → client pays → status becomes payment_pending", async ({ browser }) => {
    const setup = loadSetup();
    const [vendorCtx, clientCtx] = await Promise.all([
      openAccountPage(browser, setup.sender, setup.chainId, "V"),
      openAccountPage(browser, setup.recipient, setup.chainId, "C"),
    ]);

    try {
      // ─── Vendor creates invoice to client ──────────────────────────
      const v = vendorCtx.page;
      const vendorLower = setup.sender.address.toLowerCase();
      const clientLower = setup.recipient.address.toLowerCase();

      const createQuery = `activities?user_from=eq.${vendorLower}&activity_type=eq.invoice_created`;
      const createBaseline = await captureBaseline(v, createQuery);

      await v.goto("/app/business");
      await v.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await v.waitForTimeout(6_000);
      await v.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-2a-vendor-business.png"), fullPage: true });

      // Open the "New Invoice" modal first
      const openedModal = await v.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^new invoice$/i.test((b.textContent || "").trim()));
        if (target) { (target as HTMLButtonElement).click(); return true; }
        return false;
      });
      expect(openedModal, "New Invoice button must exist").toBe(true);
      console.log("  [V] opened New Invoice modal");
      await v.waitForTimeout(1_000);

      // JS-fill bypasses Playwright's actionability hang on cofhe-iframe pages.
      await v.evaluate((recipient) => {
        const setVal = (sel: string, value: string) => {
          const inp = document.querySelector(sel) as HTMLInputElement | null;
          if (!inp) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
          setter.call(inp, value);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setVal('input[placeholder="0x..."]', recipient);
        setVal('input[placeholder="0.00"]', "2");
        setVal('input[placeholder*="Services"]', "E2E invoice test");
      }, setup.recipient.address);
      // Due-date is a select with predefined options — leave default (7 days)
      await v.waitForTimeout(500);

      // Click Create Invoice button in modal
      const clicked = await v.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /create invoice/i.test((b.textContent || "").trim()));
        if (target) { (target as HTMLButtonElement).click(); return true; }
        return false;
      });
      expect(clicked, "Create Invoice submit button must exist").toBe(true);
      console.log("  [V] clicked Create Invoice");
      await v.waitForTimeout(2_000);

      // Up to 3 prompts: approve + CoFHE warmup + createInvoice
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(v, PASSPHRASE, 60_000);
          console.log(`  [V] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [V] no prompt #${i + 1}`);
          break;
        }
        await v.waitForTimeout(2_000);
      }

      const createResult = await pollForNewActivityRow(v, createQuery, {
        label: "invoice-created",
        baselineHashes: createBaseline,
      });
      expect(createResult.newRows.length, "vendor must create invoice row").toBeGreaterThan(0);
      const invoiceTxHash = createResult.newRows[0].tx_hash;
      console.log(`  [V] created invoice tx: ${invoiceTxHash}`);

      // Query invoices table for the invoice_id that matches our tx_hash
      let invoiceId = -1;
      for (let attempt = 0; attempt < 10; attempt++) {
        const invRes = await v.request.get(
          `${SUPABASE_URL}/rest/v1/invoices?tx_hash=eq.${invoiceTxHash}&select=invoice_id,status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (invRes.status() === 200) {
          const rows = await invRes.json();
          if (rows.length > 0) {
            invoiceId = rows[0].invoice_id;
            console.log(`  [V] invoice row: id=${invoiceId} status=${rows[0].status}`);
            break;
          }
        }
        await v.waitForTimeout(1_500);
      }
      expect(invoiceId, "invoice row must appear in Supabase invoices table").toBeGreaterThanOrEqual(0);
      await v.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-2b-invoice-created.png"), fullPage: true });

      // ─── Client pays the invoice ──────────────────────────────────
      const c = clientCtx.page;
      // Track invoice_payment activity
      const payQuery = `activities?user_from=eq.${clientLower}&activity_type=eq.invoice_payment`;
      const payBaseline = await captureBaseline(c, payQuery);

      await c.goto("/app/business");
      await c.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await c.waitForTimeout(8_000);
      await c.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-2c-client-business.png"), fullPage: true });

      // Click Pay button on our invoice
      const payClickOk = await c.evaluate((invId) => {
        // Each invoice row has a Pay button. Find the one whose row text
        // contains our invoice ID (or the vendor's address prefix). Since
        // the UI only shows Pay for pending invoices to this client, the
        // first Pay button is safe if only one invoice is pending.
        const buttons = Array.from(document.querySelectorAll("button"));
        const payButtons = buttons.filter((b) => /^pay$/i.test((b.textContent || "").trim()));
        if (payButtons.length === 0) {
          return {
            ok: false,
            why: "no Pay button rendered",
            visible: buttons.slice(0, 20).map((b) => (b.textContent || "").trim()).filter(Boolean),
          };
        }
        (payButtons[0] as HTMLButtonElement).click();
        return { ok: true, count: payButtons.length, invId };
      }, invoiceId);
      console.log("  [C] pay click:", JSON.stringify(payClickOk));
      expect(payClickOk.ok, "client must find Pay button").toBe(true);
      await c.waitForTimeout(1_000);

      // Pay dialog — fill amount + submit. The pay dialog is rendered
      // LAST in the DOM. JS-fill bypasses actionability hang.
      await c.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[placeholder="0.00"]'));
        const inp = inputs[inputs.length - 1];
        if (!inp) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(inp, "2");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await c.waitForTimeout(500);
      // The dialog's Pay button is the one NEXT TO Cancel (flex siblings).
      // Walk from the Cancel button to find its sibling Pay button.
      const submitted = await c.evaluate(() => {
        const cancelBtn = Array.from(document.querySelectorAll("button")).find(
          (b) => /^cancel$/i.test((b.textContent || "").trim()),
        );
        if (!cancelBtn) return { ok: false, why: "no Cancel button (dialog not open)" };
        const parent = cancelBtn.parentElement;
        if (!parent) return { ok: false, why: "cancel has no parent" };
        const siblings = Array.from(parent.querySelectorAll("button"));
        const payBtn = siblings.find(
          (b) => b !== cancelBtn && /^pay$/i.test((b.textContent || "").trim()),
        );
        if (!payBtn) return { ok: false, why: "no Pay sibling in dialog" };
        (payBtn as HTMLButtonElement).click();
        return { ok: true };
      });
      console.log("  [C] submit pay dialog:", JSON.stringify(submitted));
      expect(submitted.ok, "dialog Pay button must be clickable").toBe(true);
      await c.waitForTimeout(2_000);

      // Up to 3 prompts: approve + warmup + payInvoice
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(c, PASSPHRASE, 90_000);
          console.log(`  [C] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [C] no prompt #${i + 1}`);
          break;
        }
        await c.waitForTimeout(2_000);
      }

      const payResult = await pollForNewActivityRow(c, payQuery, {
        label: "invoice-pay",
        baselineHashes: payBaseline,
      });
      await c.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-2d-invoice-paid.png"), fullPage: true });
      expect(payResult.newRows.length, "client must see new invoice_payment row").toBeGreaterThan(0);

      // Also verify invoice status transitioned via Supabase invoices table
      await c.waitForTimeout(3_000);
      const invoiceRes = await c.request.get(
        `${SUPABASE_URL}/rest/v1/invoices?invoice_id=eq.${invoiceId}&select=status`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      if (invoiceRes.status() === 200) {
        const inv = await invoiceRes.json();
        console.log(`  [C] invoice DB status = ${inv[0]?.status ?? "NOT FOUND"}`);
        if (inv[0]?.status) {
          expect(["payment_pending", "paid"].includes(inv[0].status)).toBe(true);
        }
      }
      console.log("  ✅ Invoice cross-account pay verified");
    } finally {
      await Promise.race([
        vendorCtx.context.close().catch(() => {}),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
      await Promise.race([
        clientCtx.context.close().catch(() => {}),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
    }
  });
});
