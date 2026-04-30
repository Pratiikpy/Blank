import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// P1 priority test: Escrow dispute → arbiter decide.
//
// Setup: depositor = sender, beneficiary = recipient, arbiter = recipient.
// (Arbiter == beneficiary is odd but contract doesn't forbid it, and it lets
// us test with just two accounts. Arbiter path is the real target — the
// decision logic must work.)
//
// Flow:
//   1. Sender creates escrow with arbiter set
//   2. Sender (depositor) clicks Dispute → status = disputed
//   3. Recipient (arbiter) clicks "Release to Beneficiary" → status = resolved

test.describe("P1 — Escrow dispute + arbiter decide", () => {
  test.setTimeout(1_800_000); // 30 min — multi-step cross-account

  test("sender disputes → arbiter (recipient) releases to beneficiary → resolved", async ({ browser }) => {
    const setup = loadSetup();
    const [depCtx, arbiterCtx] = await Promise.all([
      openAccountPage(browser, setup.sender, setup.chainId, "D"),
      openAccountPage(browser, setup.recipient, setup.chainId, "A"),
    ]);

    try {
      const dep = depCtx.page;
      const arb = arbiterCtx.page;
      const depLower = setup.sender.address.toLowerCase();

      const createQuery = `activities?user_from=eq.${depLower}&activity_type=eq.escrow_created`;
      const createBaseline = await captureBaseline(dep, createQuery);

      // ─── Step 1 : Depositor creates escrow with recipient as
      // beneficiary AND arbiter
      await dep.goto("/app/business");
      await dep.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await dep.waitForTimeout(5_000);
      await dep.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^escrow$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await dep.waitForTimeout(2_000);
      await dep.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^new escrow$/i.test((b.textContent || "").trim()));
        if (target) (target as HTMLButtonElement).click();
      });
      await dep.waitForTimeout(1_000);

      // Form: beneficiary (placeholder "0x..."), amount, description, arbiter
      // (placeholder "0x... (leave empty for no arbiter)"). The arbiter
      // placeholder is distinct — use it explicitly so nth-selection by
      // generic "0x..." doesn't miss it.
      await dep.locator('input[placeholder="0x..."]').first().fill(setup.recipient.address);
      await dep.locator('input[placeholder="0.00"]').first().fill("1");
      await dep.locator('input[placeholder*="milestone"]').first().fill("Dispute test escrow");
      await dep.locator('input[placeholder*="leave empty for no arbiter"]').first().fill(setup.recipient.address);
      await dep.waitForTimeout(500);

      await dep.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^create escrow$/i.test((b.textContent || "").trim()));
        if (target) (target as HTMLButtonElement).click();
      });
      await dep.waitForTimeout(2_000);
      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(dep, PASSPHRASE, 90_000); console.log(`  [D] ✅ create prompt #${i + 1}`); }
        catch { break; }
        await dep.waitForTimeout(2_000);
      }

      const created = await pollForNewActivityRow(dep, createQuery, {
        label: "escrow-created", baselineHashes: createBaseline,
      });
      expect(created.newRows.length).toBeGreaterThan(0);
      const createTx = created.newRows[0].tx_hash;

      let escrowId = -1;
      for (let attempt = 0; attempt < 15; attempt++) {
        const res = await dep.request.get(
          `${SUPABASE_URL}/rest/v1/escrows?tx_hash=eq.${createTx}&select=escrow_id,arbiter_address,status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows.length > 0) {
            escrowId = rows[0].escrow_id;
            console.log(`  [D] escrow #${escrowId} arbiter=${rows[0].arbiter_address}`);
            break;
          }
        }
        await dep.waitForTimeout(1_500);
      }
      expect(escrowId).toBeGreaterThanOrEqual(0);

      // ─── Step 2 : Depositor disputes ───────────────────────────────
      await dep.reload();
      await dep.waitForTimeout(6_000);
      await dep.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^escrow$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await dep.waitForTimeout(2_000);

      // Click Dispute button for our escrow (match by description)
      const disputeOk = await dep.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const b of buttons) {
          if (!/^dispute$/i.test((b.textContent || "").trim())) continue;
          let node: Element | null = b;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").includes("Dispute test escrow")) {
              (b as HTMLButtonElement).click();
              return { ok: true, matched: "by-desc" };
            }
            node = node.parentElement;
          }
        }
        const any = buttons.find((b) => /^dispute$/i.test((b.textContent || "").trim()));
        if (!any) return { ok: false };
        (any as HTMLButtonElement).click();
        return { ok: true, matched: "first" };
      });
      console.log(`  [D] dispute click: ${JSON.stringify(disputeOk)}`);
      expect(disputeOk.ok).toBe(true);
      await dep.waitForTimeout(1_500);

      // Dispute confirmation modal — the confirm button is exactly
      // "Confirm Dispute" (red, sibling of Cancel inside the modal).
      await dep.waitForTimeout(1_000); // let modal mount
      const confirmed = await dep.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) =>
          /^confirm dispute$/i.test((b.textContent || "").trim()),
        );
        if (!target) return { ok: false, available: btns.slice(0, 20).map((b) => (b.textContent || "").trim()).filter(Boolean) };
        (target as HTMLButtonElement).click();
        return { ok: true };
      });
      console.log(`  [D] confirm dispute: ${JSON.stringify(confirmed).slice(0, 300)}`);
      expect(confirmed.ok).toBe(true);
      await dep.waitForTimeout(2_000);

      for (let i = 0; i < 4; i++) {
        try { await answerPassphrasePrompt(dep, PASSPHRASE, 90_000); console.log(`  [D] ✅ dispute prompt #${i + 1}`); }
        catch { break; }
        await dep.waitForTimeout(2_000);
      }

      // Wait for status → disputed
      let disputedStatus = "active";
      for (let attempt = 0; attempt < 30; attempt++) {
        const res = await dep.request.get(
          `${SUPABASE_URL}/rest/v1/escrows?escrow_id=eq.${escrowId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows[0]?.status === "disputed") { disputedStatus = "disputed"; break; }
        }
        if (attempt % 5 === 0) console.log(`  [D] dispute poll[${attempt}] status=${disputedStatus}`);
        await dep.waitForTimeout(3_000);
      }
      expect(disputedStatus).toBe("disputed");
      console.log(`  ✓ escrow #${escrowId} is disputed — arbiter can now decide`);
      await dep.screenshot({ path: path.join(SCREENSHOT_DIR, "p1-dispute-01-disputed.png"), fullPage: true });

      // ─── Step 3 : Arbiter (recipient) decides for beneficiary ──────
      await arb.goto("/app/business");
      await arb.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await arb.waitForTimeout(6_000);
      await arb.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^escrow$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await arb.waitForTimeout(2_000);
      await arb.screenshot({ path: path.join(SCREENSHOT_DIR, "p1-dispute-02-arbiter-view.png"), fullPage: true });

      // Click "Release to Beneficiary" for our disputed escrow
      const arbitrateOk = await arb.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const b of buttons) {
          if (!/release to beneficiary/i.test((b.textContent || "").trim())) continue;
          let node: Element | null = b;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").includes("Dispute test escrow")) {
              (b as HTMLButtonElement).click();
              return { ok: true, matched: "by-desc" };
            }
            node = node.parentElement;
          }
        }
        const any = buttons.find((b) => /release to beneficiary/i.test((b.textContent || "").trim()));
        if (!any) {
          return {
            ok: false,
            visible: buttons.slice(0, 30).map((b) => (b.textContent || "").trim()).filter(Boolean),
          };
        }
        (any as HTMLButtonElement).click();
        return { ok: true, matched: "first" };
      });
      console.log(`  [A] release-to-beneficiary click: ${JSON.stringify(arbitrateOk).slice(0, 300)}`);
      expect(arbitrateOk.ok).toBe(true);
      await arb.waitForTimeout(1_500);

      // Arbiter confirmation modal — the inner confirm button is exactly "Confirm"
      // (the header says "Release to Beneficiary?" but button text is plain "Confirm").
      await arb.waitForTimeout(1_000);
      const arbiterConfirmed = await arb.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^confirm$/i.test((b.textContent || "").trim()));
        if (!target) return { ok: false, available: btns.slice(0, 20).map((b) => (b.textContent || "").trim()).filter(Boolean) };
        (target as HTMLButtonElement).click();
        return { ok: true };
      });
      console.log(`  [A] arbiter confirm: ${JSON.stringify(arbiterConfirmed).slice(0, 300)}`);
      expect(arbiterConfirmed.ok).toBe(true);
      await arb.waitForTimeout(2_000);

      for (let i = 0; i < 4; i++) {
        try { await answerPassphrasePrompt(arb, PASSPHRASE, 90_000); console.log(`  [A] ✅ arbiter prompt #${i + 1}`); }
        catch { break; }
        await arb.waitForTimeout(2_000);
      }

      // Wait for status → resolved (or released)
      let finalStatus = "disputed";
      for (let attempt = 0; attempt < 50; attempt++) {
        const res = await arb.request.get(
          `${SUPABASE_URL}/rest/v1/escrows?escrow_id=eq.${escrowId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          const s = rows[0]?.status;
          if (s === "released" || s === "resolved" || s === "returned") {
            finalStatus = s;
            break;
          }
        }
        if (attempt % 5 === 0) console.log(`  [A] arbitrate poll[${attempt}] status=${finalStatus}`);
        await arb.waitForTimeout(3_000);
      }
      await arb.screenshot({ path: path.join(SCREENSHOT_DIR, "p1-dispute-03-resolved.png"), fullPage: true });
      expect(
        ["released", "resolved", "returned"].includes(finalStatus),
        `final status must reflect resolution, got ${finalStatus}`,
      ).toBe(true);
      console.log(`  ✅ Escrow dispute + arbiter decide verified — final status: ${finalStatus}`);
    } finally {
      await depCtx.context.close();
      await arbiterCtx.context.close();
    }
  });
});
