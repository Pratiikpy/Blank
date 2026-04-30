import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Session 3 — Batch C: escrow + payroll + group secondary flows.

test.describe("Session 3 Batch C — escrow + payroll + group", () => {
  test.setTimeout(900_000);

  // ─── Test 1 : Escrow happy path — create + markDelivered + approveRelease
  // Two actors: depositor (sender) creates; beneficiary (recipient) marks
  // delivered; depositor approves release.
  test("escrow happy path: create → markDelivered (beneficiary) → approveRelease (depositor)", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "D");
    const beneficiaryCtx = await openAccountPage(browser, setup.recipient, setup.chainId, "B");
    try {
      const page = ctx.page;
      const depositorLower = setup.sender.address.toLowerCase();

      const createQuery = `activities?user_from=eq.${depositorLower}&activity_type=eq.escrow_created`;
      const createBaseline = await captureBaseline(page, createQuery);

      await page.goto("/app/business");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      // Switch to Escrow tab
      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^escrow$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await page.waitForTimeout(2_000);

      // Click "New Escrow"
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^new escrow$/i.test((b.textContent || "").trim()));
        if (target) (target as HTMLButtonElement).click();
      });
      await page.waitForTimeout(1_000);

      // JS-fill bypass — actionability hangs on cofhe-iframe pages.
      await page.evaluate((recipient) => {
        const setVal = (sel: string, value: string) => {
          const inp = document.querySelector(sel) as HTMLInputElement | null;
          if (!inp) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
          setter.call(inp, value);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setVal('input[placeholder="0x..."]', recipient);
        setVal('input[placeholder="0.00"]', "1");
        setVal('input[placeholder*="milestone"]', "E2E escrow test");
      }, setup.recipient.address);
      await page.waitForTimeout(500);

      // Submit "Create Escrow"
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^create escrow$/i.test((b.textContent || "").trim()));
        if (target) (target as HTMLButtonElement).click();
      });
      await page.waitForTimeout(2_000);

      // Up to 3 prompts: approve + warmup (cached) + createEscrow
      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log(`  [D] ✅ create prompt #${i + 1}`); }
        catch { break; }
        await page.waitForTimeout(2_000);
      }

      const created = await pollForNewActivityRow(page, createQuery, {
        label: "escrow-created", baselineHashes: createBaseline,
      });
      expect(created.newRows.length, "escrow_created row must appear").toBeGreaterThan(0);
      const createTx = created.newRows[0].tx_hash;
      console.log(`  [D] escrow_created tx: ${createTx}`);

      // Resolve escrow_id from the escrows table via tx_hash
      let escrowId = -1;
      for (let attempt = 0; attempt < 15; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/escrows?tx_hash=eq.${createTx}&select=escrow_id,status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows.length > 0) { escrowId = rows[0].escrow_id; console.log(`  [D] escrow_id=${escrowId} status=${rows[0].status}`); break; }
        }
        await page.waitForTimeout(1_500);
      }
      expect(escrowId, "escrow row must appear").toBeGreaterThanOrEqual(0);

      // ─── Step 2: Beneficiary (recipient) opens their Business tab and
      // clicks Release Funds → UI branches by role → markDelivered.
      const bene = beneficiaryCtx.page;
      await bene.goto("/app/business");
      await bene.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await bene.waitForTimeout(6_000);
      await bene.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^escrow$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await bene.waitForTimeout(2_000);

      const beneClick = await bene.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const b of buttons) {
          if (!/release funds/i.test((b.textContent || "").trim())) continue;
          let node: Element | null = b;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").includes("E2E escrow test")) {
              (b as HTMLButtonElement).click();
              return { ok: true, matched: "by-desc" };
            }
            node = node.parentElement;
          }
        }
        const any = buttons.find((b) => /release funds/i.test((b.textContent || "").trim()));
        if (!any) return { ok: false };
        (any as HTMLButtonElement).click();
        return { ok: true, matched: "first" };
      });
      console.log("  [B] release click:", JSON.stringify(beneClick));
      expect(beneClick.ok).toBe(true);
      await bene.waitForTimeout(2_000);
      for (let i = 0; i < 4; i++) {
        try { await answerPassphrasePrompt(bene, PASSPHRASE, 90_000); console.log(`  [B] ✅ markDelivered prompt #${i + 1}`); }
        catch { break; }
        await bene.waitForTimeout(2_000);
      }
      // Wait for markDelivered tx to reflect
      await bene.waitForTimeout(8_000);

      // ─── Step 3: Depositor clicks Release Funds → approveRelease
      await page.reload();
      await page.waitForTimeout(6_000);
      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^escrow$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await page.waitForTimeout(2_000);

      const depClick = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const b of buttons) {
          if (!/release funds/i.test((b.textContent || "").trim())) continue;
          let node: Element | null = b;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").includes("E2E escrow test")) {
              (b as HTMLButtonElement).click();
              return { ok: true, matched: "by-desc" };
            }
            node = node.parentElement;
          }
        }
        const any = buttons.find((b) => /release funds/i.test((b.textContent || "").trim()));
        if (!any) return { ok: false };
        (any as HTMLButtonElement).click();
        return { ok: true, matched: "first" };
      });
      console.log("  [D] release click:", JSON.stringify(depClick));
      expect(depClick.ok).toBe(true);
      await page.waitForTimeout(2_000);
      for (let i = 0; i < 4; i++) {
        try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log(`  [D] ✅ approveRelease prompt #${i + 1}`); }
        catch { break; }
        await page.waitForTimeout(2_000);
      }

      // Poll escrow status → released
      let finalStatus = "active";
      for (let attempt = 0; attempt < 50; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/escrows?escrow_id=eq.${escrowId}&select=status`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows[0]?.status === "released") { finalStatus = "released"; break; }
        }
        if (attempt % 5 === 0) console.log(`  [D] poll[${attempt}] status=${finalStatus}`);
        await page.waitForTimeout(3_000);
      }
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-c-escrow-released.png"), fullPage: true });
      expect(finalStatus).toBe("released");
      console.log("  ✅ Escrow happy path verified");
    } finally {
      await Promise.race([ctx.context.close().catch(() => {}), new Promise((res) => setTimeout(res, 5000))]);
      await Promise.race([beneficiaryCtx.context.close().catch(() => {}), new Promise((res) => setTimeout(res, 5000))]);
    }
  });

  // ─── Test 2 : Payroll with 2 recipients ───────────────────────────
  test("payroll — 2-recipient encrypted batch payment", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "P");
    try {
      const page = ctx.page;
      const senderLower = setup.sender.address.toLowerCase();

      const payrollQuery = `activities?user_from=eq.${senderLower}&activity_type=eq.payroll`;
      const payrollBaseline = await captureBaseline(page, payrollQuery);

      await page.goto("/app/business");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("button, [role=tab]"));
        const t = tabs.find((b) => /^payroll$/i.test((b.textContent || "").trim()));
        if (t) (t as HTMLElement).click();
      });
      await page.waitForTimeout(2_000);

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /run payroll/i.test((b.textContent || "").trim()));
        if (target) (target as HTMLButtonElement).click();
      });
      await page.waitForTimeout(1_500);

      // JS-fill bypass — Playwright actionability hangs on cofhe-iframe pages.
      const r2 = "0x000000000000000000000000000000000000dEaD";
      await page.evaluate(({ recipient, r2 }) => {
        const setVal = (sel: string, value: string) => {
          const el = document.querySelector(sel) as HTMLTextAreaElement | HTMLInputElement | null;
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
          setter.call(el, value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setVal('textarea[placeholder*="0xabc"]', `${recipient}, ${r2}`);
        setVal('textarea[placeholder*="5000"]', "1, 1");
      }, { recipient: setup.recipient.address, r2 });
      await page.waitForTimeout(500);

      // Click "Run Payroll" SUBMIT (modal). Two buttons share that text —
      // the page-level opener (first in DOM) and the modal submit (last).
      // Picking the last avoids re-toggling the modal closed.
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"))
          .filter((b) => /^run payroll$/i.test((b.textContent || "").trim()) && !b.disabled);
        const target = btns[btns.length - 1];
        if (target) (target as HTMLButtonElement).click();
      });
      await page.waitForTimeout(2_000);

      // Up to 3 prompts: approve + warmup + runPayroll
      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log(`  [P] ✅ payroll prompt #${i + 1}`); }
        catch { break; }
        await page.waitForTimeout(2_000);
      }

      const payrollResult = await pollForNewActivityRow(page, payrollQuery, {
        label: "payroll", baselineHashes: payrollBaseline,
      });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-c-payroll.png"), fullPage: true });
      expect(payrollResult.newRows.length, "payroll activity row must appear").toBeGreaterThan(0);
      console.log("  ✅ Payroll 2-recipient verified");
    } finally {
      await Promise.race([ctx.context.close().catch(() => {}), new Promise((res) => setTimeout(res, 5000))]);
    }
  });

  // ─── Test 3 : Group archive (admin) ───────────────────────────────
  test("group archive — admin archives an existing group", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "S");
    try {
      const page = ctx.page;
      const senderLower = setup.sender.address.toLowerCase();

      // Gifts / Groups may use window.confirm
      page.on("dialog", (d) => d.accept().catch(() => {}));

      const archivedQuery = `activities?user_from=eq.${senderLower}&activity_type=eq.group_archived`;
      const baseline = await captureBaseline(page, archivedQuery);

      // Create a throwaway group first (so we don't archive anything we care about)
      await page.goto("/app/groups");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /create group/i.test((b.textContent || "").trim()) && !/cancel/i.test((b.textContent || "").trim()));
        if (target) (target as HTMLButtonElement).click();
      });
      await page.waitForTimeout(1_500);

      // JS-fill bypass.
      const groupName = `Archive Test ${Date.now()}`;
      await page.evaluate(({ name, recipient }) => {
        const setVal = (sel: string, value: string) => {
          const inp = document.querySelector(sel) as HTMLInputElement | null;
          if (!inp) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
          setter.call(inp, value);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setVal('input[placeholder="Weekend getaway"]', name);
        setVal('input[placeholder="0x..."]', recipient);
        const addBtn = document.querySelector('button[aria-label="Add member"]') as HTMLButtonElement | null;
        if (addBtn) addBtn.click();
      }, { name: groupName, recipient: setup.recipient.address });
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const cancel = Array.from(document.querySelectorAll("button")).find((b) => /^cancel$/i.test((b.textContent || "").trim()));
        if (!cancel || !cancel.parentElement) return;
        const sibs = Array.from(cancel.parentElement.querySelectorAll("button"));
        const createBtn = sibs.find((b) => b !== cancel && /create group/i.test((b.textContent || "").trim()));
        if (createBtn) (createBtn as HTMLButtonElement).click();
      });
      await page.waitForTimeout(2_000);
      try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log("  [S] ✅ createGroup prompt"); }
      catch {}
      await page.waitForTimeout(8_000);

      // Find our fresh group
      let newGroupId = -1;
      for (let attempt = 0; attempt < 15; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/group_memberships?member_address=eq.${senderLower}&is_admin=eq.true&order=created_at.desc&limit=1&select=group_id,group_name`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = await res.json();
          if (rows.length > 0) { newGroupId = rows[0].group_id; console.log(`  [S] new group #${newGroupId} (${rows[0].group_name})`); break; }
        }
        await page.waitForTimeout(2_000);
      }
      expect(newGroupId).toBeGreaterThanOrEqual(0);

      // Reload & click Archive for our group
      await page.reload();
      await page.waitForTimeout(6_000);

      const archiveOk = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const archiveBtns = buttons.filter((b) => /^archive$/i.test((b.textContent || "").trim()));
        if (archiveBtns.length === 0) {
          return {
            ok: false,
            visible: buttons.slice(0, 30).map((b) => (b.textContent || "").trim()).filter(Boolean),
          };
        }
        (archiveBtns[0] as HTMLButtonElement).click();
        return { ok: true };
      });
      console.log("  [S] archive click:", JSON.stringify(archiveOk).slice(0, 300));
      expect(archiveOk.ok).toBe(true);
      await page.waitForTimeout(2_000);

      try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log("  [S] ✅ archive prompt"); }
      catch { console.log("  [S] no archive prompt"); }

      const archived = await pollForNewActivityRow(page, archivedQuery, {
        label: "group-archived", baselineHashes: baseline,
      });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-c-group-archived.png"), fullPage: true });
      expect(archived.newRows.length).toBeGreaterThan(0);
      console.log("  ✅ Group archive verified");
    } finally {
      await Promise.race([ctx.context.close().catch(() => {}), new Promise((res) => setTimeout(res, 5000))]);
    }
  });

  // ─── Test 4 : Group leave (non-admin member) ──────────────────────
  test("group leave — member leaves a group", async ({ browser }) => {
    const setup = loadSetup();
    // Recipient is non-admin in group #6 from session 2. Leave it.
    const ctx = await openAccountPage(browser, setup.recipient, setup.chainId, "L");
    try {
      const page = ctx.page;
      const recipientLower = setup.recipient.address.toLowerCase();

      page.on("dialog", (d) => d.accept().catch(() => {}));

      const leftQuery = `activities?user_from=eq.${recipientLower}&activity_type=eq.group_left`;
      const baseline = await captureBaseline(page, leftQuery);

      await page.goto("/app/groups");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(6_000);

      // Click any "Leave" button. If none appears, skip (no groups to leave).
      const leaveOk = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const leaveBtns = buttons.filter((b) => /^leave$/i.test((b.textContent || "").trim()));
        if (leaveBtns.length === 0) {
          return {
            ok: false,
            visible: buttons.slice(0, 30).map((b) => (b.textContent || "").trim()).filter(Boolean),
          };
        }
        (leaveBtns[0] as HTMLButtonElement).click();
        return { ok: true };
      });
      console.log("  [L] leave click:", JSON.stringify(leaveOk).slice(0, 300));
      if (!leaveOk.ok) {
        console.log("  ⚠️ No Leave button — recipient has no groups to leave");
        test.skip(true, "no groups to leave");
        return;
      }
      await page.waitForTimeout(2_500); // window.confirm

      try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log("  [L] ✅ leave prompt"); }
      catch { console.log("  [L] no leave prompt"); }

      const left = await pollForNewActivityRow(page, leftQuery, {
        label: "group-left", baselineHashes: baseline,
      });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-c-group-left.png"), fullPage: true });
      expect(left.newRows.length).toBeGreaterThan(0);
      console.log("  ✅ Group leave verified");
    } finally {
      await Promise.race([ctx.context.close().catch(() => {}), new Promise((res) => setTimeout(res, 5000))]);
    }
  });
});
