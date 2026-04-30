import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Phase 7 #4 — PaymentHub payment request cross-account.
//
// Requester smart-account asks payer smart-account for an amount. Payer
// opens /app/requests, sees incoming pending request, clicks Pay, signs.
// Request status should transition pending → fulfilled.

test.describe("Phase 7 #4 — Payment request fulfill cross-account", () => {
  test.setTimeout(900_000);

  test("requester creates request → payer fulfills → status becomes fulfilled", async ({ browser }) => {
    const setup = loadSetup();
    const [requesterCtx, payerCtx] = await Promise.all([
      openAccountPage(browser, setup.sender, setup.chainId, "R"),
      openAccountPage(browser, setup.recipient, setup.chainId, "P"),
    ]);

    try {
      const r = requesterCtx.page;
      const requesterLower = setup.sender.address.toLowerCase();
      const payerLower = setup.recipient.address.toLowerCase();

      // ─── Requester creates a pending request to payer ─────────────
      const createQuery = `activities?user_from=eq.${requesterLower}&activity_type=eq.request_created`;
      const createBaseline = await captureBaseline(r, createQuery);

      await r.goto("/app/requests");
      await r.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await r.waitForTimeout(5_000);
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-4a-requester-requests.png"), fullPage: true });

      // Open "Request Payment" modal — "Request" button (top-right)
      const openedModal = await r.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^request$/i.test((b.textContent || "").trim()));
        if (target) { (target as HTMLButtonElement).click(); return true; }
        return false;
      });
      expect(openedModal, "Request button (top-right) must exist").toBe(true);
      await r.waitForTimeout(1_000);

      // Modal is open — fill payer address, amount, optional note
      await r.locator('input[placeholder*="0x" i]').first().fill(setup.recipient.address);
      await r.locator('input[placeholder="0.00"]').first().fill("2");
      // Note is optional — leave blank
      await r.waitForTimeout(500);

      // Click "Send Request"
      const submitted = await r.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /send request/i.test((b.textContent || "").trim()));
        if (target) { (target as HTMLButtonElement).click(); return true; }
        return false;
      });
      expect(submitted, "Send Request button must exist").toBe(true);
      await r.waitForTimeout(2_000);

      // Up to 2 prompts: CoFHE warmup (if fresh) + createRequest
      for (let i = 0; i < 4; i++) {
        try {
          await answerPassphrasePrompt(r, PASSPHRASE, 90_000);
          console.log(`  [R] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [R] no prompt #${i + 1}`);
          break;
        }
        await r.waitForTimeout(2_000);
      }

      const createResult = await pollForNewActivityRow(r, createQuery, {
        label: "request-created",
        baselineHashes: createBaseline,
      });
      expect(createResult.newRows.length, "requester must create request row").toBeGreaterThan(0);
      const createTxHash = createResult.newRows[0].tx_hash;
      console.log(`  [R] request created tx: ${createTxHash}`);

      // Look up request_id from payment_requests table
      let requestId = -1;
      for (let attempt = 0; attempt < 10; attempt++) {
        const reqRes = await r.request.get(
          `${SUPABASE_URL}/rest/v1/payment_requests?tx_hash=eq.${createTxHash}&select=request_id,status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (reqRes.status() === 200) {
          const rows = await reqRes.json();
          if (rows.length > 0) {
            requestId = rows[0].request_id;
            console.log(`  [R] payment_request id=${requestId} status=${rows[0].status}`);
            break;
          }
        }
        await r.waitForTimeout(1_500);
      }
      expect(requestId, "request row must appear in payment_requests table").toBeGreaterThanOrEqual(0);

      // ─── Payer fulfills the request ────────────────────────────────
      const p = payerCtx.page;
      const fulfillQuery = `activities?user_from=eq.${payerLower}&activity_type=eq.request_fulfilled`;
      const fulfillBaseline = await captureBaseline(p, fulfillQuery);

      await p.goto("/app/requests");
      await p.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(6_000);
      await p.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-4b-payer-requests.png"), fullPage: true });

      // Incoming tab is default — find the Pay button for a pending request
      const payClickOk = await p.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const payButtons = buttons.filter((b) => /^pay$/i.test((b.textContent || "").trim()));
        if (payButtons.length === 0) {
          return {
            ok: false,
            why: "no Pay button found",
            visible: buttons.slice(0, 30).map((b) => (b.textContent || "").trim()).filter(Boolean),
          };
        }
        (payButtons[0] as HTMLButtonElement).click();
        return { ok: true, count: payButtons.length };
      });
      console.log("  [P] pay click:", JSON.stringify(payClickOk).slice(0, 300));
      expect(payClickOk.ok, "payer must find Pay button in incoming tab").toBe(true);
      await p.waitForTimeout(1_500);

      // Fulfill modal opens — fill amount + click Pay Now
      const payInputs = p.locator('input[placeholder="0.00"]');
      const payInputCount = await payInputs.count();
      if (payInputCount > 0) {
        await payInputs.nth(payInputCount - 1).fill("2");
      }
      await p.waitForTimeout(500);

      const submittedPay = await p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /pay now/i.test((b.textContent || "").trim()));
        if (target) { (target as HTMLButtonElement).click(); return true; }
        return false;
      });
      expect(submittedPay, "Pay Now button must exist in fulfill modal").toBe(true);
      await p.waitForTimeout(2_000);

      // Up to 3 prompts: approve + CoFHE warmup + fulfillRequest
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(p, PASSPHRASE, 90_000);
          console.log(`  [P] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [P] no prompt #${i + 1}`);
          break;
        }
        await p.waitForTimeout(2_000);
      }

      const fulfillResult = await pollForNewActivityRow(p, fulfillQuery, {
        label: "request-fulfill",
        baselineHashes: fulfillBaseline,
      });
      await p.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-4c-payer-fulfilled.png"), fullPage: true });
      expect(fulfillResult.newRows.length, "payer must insert request_fulfilled activity").toBeGreaterThan(0);

      // Verify DB transition
      await p.waitForTimeout(3_000);
      const finalRes = await p.request.get(
        `${SUPABASE_URL}/rest/v1/payment_requests?request_id=eq.${requestId}&select=status`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      if (finalRes.status() === 200) {
        const rows = await finalRes.json();
        console.log(`  [P] final request DB status = ${rows[0]?.status ?? "NOT FOUND"}`);
        expect(rows[0]?.status).toBe("fulfilled");
      }
      console.log("  ✅ Payment request cross-account fulfill verified");
    } finally {
      await requesterCtx.context.close();
      await payerCtx.context.close();
    }
  });
});
