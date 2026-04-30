import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Session 3 — Batch B: cancel / finalize / deactivate flows.
//
// Each test creates FRESH state, then cancels/finalizes IT specifically —
// never relies on "most recent pending" queries because stale rows from
// prior runs cause wrong-id reverts ("BusinessHub: not pending" etc).

test.describe("Session 3 Batch B — cancel/finalize/deactivate", () => {
  test.setTimeout(900_000);

  // ─── Test 1 : Cancel P2P offer ─────────────────────────────────────
  test("cancel P2P offer — status transitions active → cancelled", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "M");
    try {
      const page = ctx.page;
      const senderLower = setup.sender.address.toLowerCase();

      // Accept window.confirm dialogs (Swap.tsx cancel uses native confirm)
      page.on("dialog", (d) => d.accept().catch(() => {}));

      // Baseline existing offer_ids to distinguish ours
      const baselineRes = await page.request.get(
        `${SUPABASE_URL}/rest/v1/exchange_offers?maker_address=eq.${senderLower}&select=offer_id`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      const baselineIds = new Set(
        (baselineRes.status() === 200 ? await baselineRes.json() : []).map(
          (r: { offer_id: number }) => r.offer_id,
        ),
      );

      await page.goto("/app/swap");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      await page.locator('input[placeholder="0.00"]').nth(0).fill("1");
      await page.locator('input[placeholder="0.00"]').nth(1).fill("2");

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) => /Create Swap Offer/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await page.waitForTimeout(2_000);
      for (let i = 0; i < 4; i++) {
        try { await answerPassphrasePrompt(page, PASSPHRASE, 60_000); console.log(`  [M] ✅ create prompt #${i + 1}`); }
        catch { break; }
        await page.waitForTimeout(2_000);
      }

      // Find OUR new offer_id (not in baseline)
      let newOfferId = -1;
      for (let attempt = 0; attempt < 30; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/exchange_offers?maker_address=eq.${senderLower}&status=eq.active&order=created_at.desc&limit=5&select=offer_id`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = (await res.json()) as Array<{ offer_id: number }>;
          const fresh = rows.find((r) => !baselineIds.has(r.offer_id));
          if (fresh) { newOfferId = fresh.offer_id; break; }
        }
        await page.waitForTimeout(2_000);
      }
      expect(newOfferId, "new offer must be created").toBeGreaterThanOrEqual(0);
      console.log(`  [M] FRESH offer #${newOfferId}, cancelling`);

      await page.reload();
      await page.waitForTimeout(6_000);

      // Click Cancel button INSIDE "My Open Offers" section (red, small)
      // To find OUR offer's button, match the offer_id in the card text.
      // Cards show "offer.id" via amount+maker. We match by the offer_id
      // being part of the offer amount display. Simpler: click the first
      // Cancel button since only our offer is in My Open Offers for this
      // maker (others are in Available Offers for other makers).
      const cancelOk = await page.evaluate((offerIdStr) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const cancelBtns = buttons.filter((b) => /^cancel$/i.test((b.textContent || "").trim()));
        if (cancelBtns.length === 0) return { ok: false };
        (cancelBtns[0] as HTMLButtonElement).click();
        return { ok: true, count: cancelBtns.length, offerIdStr };
      }, String(newOfferId));
      console.log("  [M] cancel click:", JSON.stringify(cancelOk));
      expect(cancelOk.ok).toBe(true);
      // window.confirm auto-accepts via the dialog handler above
      await page.waitForTimeout(2_500);

      try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log("  [M] ✅ cancel prompt"); }
      catch { console.log("  [M] no cancel prompt"); }

      let finalStatus = "active";
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/exchange_offers?offer_id=eq.${newOfferId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows[0]?.status === "cancelled") { finalStatus = "cancelled"; break; }
        }
        if (attempt % 5 === 0) console.log(`  [M] poll[${attempt}] status=${finalStatus}`);
        await page.waitForTimeout(3_000);
      }
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-b-offer-cancelled.png"), fullPage: true });
      expect(finalStatus).toBe("cancelled");
      console.log("  ✅ P2P offer cancel verified");
    } finally {
      await ctx.context.close();
    }
  });

  // ─── Test 2 : Cancel invoice ──────────────────────────────────────
  test("cancel invoice — vendor clicks Cancel → status becomes cancelled", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "V");
    try {
      const page = ctx.page;
      const vendorLower = setup.sender.address.toLowerCase();

      // Track activity rows — use tx_hash from create activity to look up OUR invoice_id
      const createQuery = `activities?user_from=eq.${vendorLower}&activity_type=eq.invoice_created`;
      const createBaseline = await captureBaseline(page, createQuery);

      await page.goto("/app/business");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /^new invoice$/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await page.waitForTimeout(1_000);

      await page.locator('input[placeholder="0x..."]').first().fill(setup.recipient.address);
      await page.locator('input[placeholder="0.00"]').first().fill("1");
      await page.locator('input[placeholder*="Services"]').first().fill("Cancel test invoice");
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /create invoice/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await page.waitForTimeout(2_000);

      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(page, PASSPHRASE, 60_000); console.log(`  [V] ✅ create prompt #${i + 1}`); }
        catch { break; }
        await page.waitForTimeout(2_000);
      }

      const created = await pollForNewActivityRow(page, createQuery, {
        label: "invoice-created", baselineHashes: createBaseline,
      });
      expect(created.newRows.length, "create invoice activity row must appear").toBeGreaterThan(0);
      const createTxHash = created.newRows[0].tx_hash;

      // Look up OUR invoice_id by tx_hash (guaranteed fresh, not stale)
      let newInvoiceId = -1;
      for (let attempt = 0; attempt < 15; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/invoices?tx_hash=eq.${createTxHash}&select=invoice_id,status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows.length > 0) {
            newInvoiceId = rows[0].invoice_id;
            console.log(`  [V] FRESH invoice_id=${newInvoiceId} status=${rows[0].status}`);
            break;
          }
        }
        await page.waitForTimeout(1_500);
      }
      expect(newInvoiceId, "invoice row by tx_hash must appear").toBeGreaterThanOrEqual(0);

      await page.reload();
      await page.waitForTimeout(6_000);

      // Click the red Cancel button next to our pending invoice row.
      // There may be multiple "Cancel" buttons (nav etc) — find the one
      // in a row containing our invoice description.
      const cancelOk = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        // Find a button whose enclosing invoice row has our description
        for (const b of buttons) {
          if (!/^cancel$/i.test((b.textContent || "").trim())) continue;
          let node: Element | null = b;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").toLowerCase().includes("cancel test invoice")) {
              (b as HTMLButtonElement).click();
              return { ok: true, matched: "by description" };
            }
            node = node.parentElement;
          }
        }
        // Fallback: any Cancel button
        const any = buttons.find((b) => /^cancel$/i.test((b.textContent || "").trim()));
        if (!any) return { ok: false };
        (any as HTMLButtonElement).click();
        return { ok: true, matched: "first" };
      });
      console.log("  [V] cancel click:", JSON.stringify(cancelOk));
      expect(cancelOk.ok).toBe(true);
      await page.waitForTimeout(1_500);

      // Confirm modal — click "Cancel Invoice" (red confirm button)
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^cancel invoice$/i.test((b.textContent || "").trim()));
        if (target) (target as HTMLButtonElement).click();
      });
      await page.waitForTimeout(2_000);

      try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log("  [V] ✅ cancelInvoice prompt"); }
      catch { console.log("  [V] no cancelInvoice prompt"); }

      let finalStatus = "pending";
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/invoices?invoice_id=eq.${newInvoiceId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows[0]?.status === "cancelled") { finalStatus = "cancelled"; break; }
        }
        if (attempt % 5 === 0) console.log(`  [V] poll[${attempt}] status=${finalStatus}`);
        await page.waitForTimeout(3_000);
      }
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-b-invoice-cancelled.png"), fullPage: true });
      expect(finalStatus).toBe("cancelled");
      console.log("  ✅ Invoice cancel verified");
    } finally {
      await ctx.context.close();
    }
  });

  // ─── Test 3 : Cancel payment request ──────────────────────────────
  test("cancel payment request — status becomes cancelled", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "R");
    try {
      const page = ctx.page;
      const requesterLower = setup.sender.address.toLowerCase();

      // Requests.tsx cancel uses window.confirm
      page.on("dialog", (d) => d.accept().catch(() => {}));

      const createQuery = `activities?user_from=eq.${requesterLower}&activity_type=eq.request_created`;
      const createBaseline = await captureBaseline(page, createQuery);

      await page.goto("/app/requests");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /^request$/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await page.waitForTimeout(1_000);

      await page.locator('input[placeholder*="0x" i]').first().fill(setup.recipient.address);
      await page.locator('input[placeholder="0.00"]').first().fill("1");
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /send request/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await page.waitForTimeout(2_000);
      for (let i = 0; i < 4; i++) {
        try { await answerPassphrasePrompt(page, PASSPHRASE, 60_000); console.log(`  [R] ✅ create prompt #${i + 1}`); }
        catch { break; }
        await page.waitForTimeout(2_000);
      }

      const created = await pollForNewActivityRow(page, createQuery, {
        label: "request-created", baselineHashes: createBaseline,
      });
      expect(created.newRows.length).toBeGreaterThan(0);
      const createTx = created.newRows[0].tx_hash;

      // Resolve OUR request_id by tx_hash
      let newReqId = -1;
      for (let attempt = 0; attempt < 15; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/payment_requests?tx_hash=eq.${createTx}&select=request_id,status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows.length > 0) { newReqId = rows[0].request_id; console.log(`  [R] FRESH request_id=${newReqId}`); break; }
        }
        await page.waitForTimeout(1_500);
      }
      expect(newReqId, "request row by tx_hash must appear").toBeGreaterThanOrEqual(0);

      await page.reload();
      await page.waitForTimeout(6_000);

      // Switch to Outgoing tab
      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^outgoing$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await page.waitForTimeout(2_000);

      const cancelOk = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const cancelBtns = buttons.filter((b) => /^cancel$/i.test((b.textContent || "").trim()));
        if (cancelBtns.length === 0) return { ok: false };
        (cancelBtns[0] as HTMLButtonElement).click();
        return { ok: true, count: cancelBtns.length };
      });
      console.log("  [R] cancel click:", JSON.stringify(cancelOk));
      expect(cancelOk.ok).toBe(true);
      await page.waitForTimeout(2_000); // allow window.confirm to be handled

      try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log("  [R] ✅ cancelRequest prompt"); }
      catch { console.log("  [R] no prompt"); }

      let finalStatus = "pending";
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/payment_requests?request_id=eq.${newReqId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows[0]?.status === "cancelled") { finalStatus = "cancelled"; break; }
        }
        if (attempt % 5 === 0) console.log(`  [R] poll[${attempt}] status=${finalStatus}`);
        await page.waitForTimeout(3_000);
      }
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-b-request-cancelled.png"), fullPage: true });
      expect(finalStatus).toBe("cancelled");
      console.log("  ✅ Request cancel verified");
    } finally {
      await ctx.context.close();
    }
  });

  // ─── Test 4 : Gift envelope deactivation ──────────────────────────
  test("gift deactivation — sender reclaims unclaimed envelope", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "S");
    try {
      const page = ctx.page;
      const senderLower = setup.sender.address.toLowerCase();

      // Gifts.tsx deactivation uses window.confirm
      page.on("dialog", (d) => d.accept().catch(() => {}));

      const createdQuery = `activities?user_from=eq.${senderLower}&activity_type=eq.gift_created`;
      const createdBaseline = await captureBaseline(page, createdQuery);

      const deactivatedQuery = `activities?user_from=eq.${senderLower}&activity_type=eq.gift_deactivated`;
      const deactivatedBaseline = await captureBaseline(page, deactivatedQuery);

      await page.goto("/app/gifts");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      await page.locator('input[placeholder="0.00"]').first().fill("1");
      await page.locator('input[placeholder*="0x"]').first().fill(setup.recipient.address);
      await page.getByRole("button", { name: /Select Birthday theme/i }).click();
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /send gift envelope/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await page.waitForTimeout(2_000);
      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log(`  [S] ✅ create prompt #${i + 1}`); }
        catch { break; }
        await page.waitForTimeout(2_000);
      }

      const created = await pollForNewActivityRow(page, createdQuery, {
        label: "gift-created", baselineHashes: createdBaseline,
      });
      expect(created.newRows.length).toBeGreaterThan(0);
      const m = (created.newRows[0].note ?? "").match(/\[envelope:(\d+)\]/);
      expect(m, "envelope id must be in note").toBeTruthy();
      const envelopeId = parseInt(m![1], 10);
      console.log(`  [S] FRESH envelope #${envelopeId}`);

      // Navigate to Sent tab
      await page.reload();
      await page.waitForTimeout(6_000);
      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^sent$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-b-gift-sent-tab.png"), fullPage: true });

      // Click Deactivate button for our envelope. Match by envelope_id text
      // if shown, else fall back to first Deactivate.
      const deactivateOk = await page.evaluate((envId) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const deactivateBtns = buttons.filter((b) =>
          /deactivate|reclaim|revoke/i.test((b.textContent || "").trim()),
        );
        if (deactivateBtns.length === 0) {
          return {
            ok: false,
            visible: buttons.slice(0, 30).map((b) => (b.textContent || "").trim()).filter(Boolean),
          };
        }
        // Prefer the one in a card containing our envelope id
        for (const b of deactivateBtns) {
          let node: Element | null = b;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").includes(`#${envId}`)) {
              (b as HTMLButtonElement).click();
              return { ok: true, matched: "by-env-id" };
            }
            node = node.parentElement;
          }
        }
        (deactivateBtns[0] as HTMLButtonElement).click();
        return { ok: true, matched: "first" };
      }, envelopeId);
      console.log("  [S] deactivate click:", JSON.stringify(deactivateOk).slice(0, 300));
      expect(deactivateOk.ok).toBe(true);
      // window.confirm is auto-accepted by the dialog handler
      await page.waitForTimeout(2_500);

      try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log("  [S] ✅ deactivate prompt"); }
      catch { console.log("  [S] no deactivate prompt"); }

      const deactivated = await pollForNewActivityRow(page, deactivatedQuery, {
        label: "gift-deactivated", baselineHashes: deactivatedBaseline,
      });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-b-gift-deactivated.png"), fullPage: true });
      expect(deactivated.newRows.length).toBeGreaterThan(0);
      console.log("  ✅ Gift deactivation verified");
    } finally {
      await ctx.context.close();
    }
  });
});
