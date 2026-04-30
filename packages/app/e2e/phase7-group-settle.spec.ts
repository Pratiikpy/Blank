import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Phase 7 #5 — GroupManager cross-account: create group → add expense → settle debt.
//
// Sender creates a group containing [recipient], adds a $2 expense split
// evenly, then recipient settles their $1 share. Verifies group_expense +
// group_settlement rows land in Supabase.

test.describe("Phase 7 #5 — Group expense + settle cross-account", () => {
  test.setTimeout(900_000);

  test("sender creates group + expense → recipient settles → both activity rows exist", async ({ browser }) => {
    const setup = loadSetup();
    const [senderCtx, recipientCtx] = await Promise.all([
      openAccountPage(browser, setup.sender, setup.chainId, "S"),
      openAccountPage(browser, setup.recipient, setup.chainId, "R"),
    ]);

    try {
      const s = senderCtx.page;
      const senderLower = setup.sender.address.toLowerCase();
      const recipientLower = setup.recipient.address.toLowerCase();

      // ─── Step 1 : sender creates group with recipient as member ────
      await s.goto("/app/groups");
      await s.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await s.waitForTimeout(5_000);

      const openedCreate = await s.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        // Top-right button contains "Create Group" (+ Plus icon). Both the
        // desktop and mobile spans are in DOM even when one is hidden by
        // Tailwind's sm:hidden / hidden sm:inline — so textContent reads
        // "Create GroupCreate" or similar. Match substring.
        const target = btns.find((b) => {
          const txt = (b.textContent || "").trim();
          return /create group/i.test(txt) && !/cancel/i.test(txt);
        });
        if (target) { (target as HTMLButtonElement).click(); return true; }
        return false;
      });
      expect(openedCreate, "Create Group button must exist").toBe(true);
      await s.waitForTimeout(1_000);

      // JS-fill bypass — Playwright actionability hangs on cofhe-iframe pages.
      const groupName = `E2E Group ${Date.now()}`;
      await s.evaluate(({ name, recipient }) => {
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
        // Trigger the Add-member click (handler reads memberInput state).
        const addBtn = document.querySelector('button[aria-label="Add member"]') as HTMLButtonElement | null;
        if (addBtn) addBtn.click();
      }, { name: groupName, recipient: setup.recipient.address });
      await s.waitForTimeout(500);

      // Click "Create Group" in modal
      await s.evaluate(() => {
        // Find a Create Group button INSIDE the modal (sibling of Cancel)
        const cancel = Array.from(document.querySelectorAll("button")).find(
          (b) => /^cancel$/i.test((b.textContent || "").trim()),
        );
        if (!cancel || !cancel.parentElement) throw new Error("modal not open");
        const siblings = Array.from(cancel.parentElement.querySelectorAll("button"));
        const createBtn = siblings.find(
          (b) => b !== cancel && /create group/i.test((b.textContent || "").trim()),
        );
        if (createBtn) (createBtn as HTMLButtonElement).click();
      });
      console.log("  [S] submitted Create Group");
      await s.waitForTimeout(2_000);

      // Single prompt for createGroup (no encryption)
      try {
        await answerPassphrasePrompt(s, PASSPHRASE, 90_000);
        console.log("  [S] ✅ filled createGroup prompt");
      } catch {
        console.log("  [S] no createGroup prompt (maybe cached)");
      }
      await s.waitForTimeout(8_000);

      // Find the new group_id via Supabase
      let groupId = -1;
      for (let attempt = 0; attempt < 10; attempt++) {
        const res = await s.request.get(
          `${SUPABASE_URL}/rest/v1/group_memberships?member_address=eq.${senderLower}&is_admin=eq.true&order=created_at.desc&limit=5&select=group_id,group_name`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = (await res.json()) as Array<{ group_id: number; group_name: string }>;
          if (rows.length > 0) {
            groupId = rows[0].group_id;
            console.log(`  [S] new group: id=${groupId} name=${rows[0].group_name}`);
            break;
          }
        }
        await s.waitForTimeout(2_000);
      }
      expect(groupId, "group must appear in Supabase").toBeGreaterThanOrEqual(0);
      await s.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-5a-group-created.png"), fullPage: true });

      // ─── Step 2 : sender adds a $2 expense split evenly ────────────
      await s.reload();
      await s.waitForTimeout(5_000);

      const expenseQuery = `activities?user_to=eq.${recipientLower}&activity_type=eq.group_expense`;
      const expenseBaseline = await captureBaseline(s, expenseQuery);

      // Click "Add Expense" button for our group
      const addExpenseOk = await s.evaluate((gid) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        // Find Add Expense buttons; pick the one nearest our group's row
        const addBtns = buttons.filter((b) => /^add expense$/i.test((b.textContent || "").trim()));
        if (addBtns.length === 0) return { ok: false, why: "no Add Expense buttons" };
        // Try to find the one associated with our groupId by checking
        // enclosing card text
        for (const btn of addBtns) {
          let node: Element | null = btn;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").includes(`#${gid}`) ||
                (node.textContent || "").includes(`Group ${gid}`)) {
              (btn as HTMLButtonElement).click();
              return { ok: true, matched: "group-id" };
            }
            node = node.parentElement;
          }
        }
        // Fallback: click the first Add Expense button (assumes new group is
        // rendered first due to recency order).
        (addBtns[0] as HTMLButtonElement).click();
        return { ok: true, matched: "first" };
      }, groupId);
      console.log("  [S] add expense click:", JSON.stringify(addExpenseOk));
      expect(addExpenseOk.ok, "Add Expense button must be clickable").toBe(true);
      await s.waitForTimeout(1_500);

      // JS-fill bypass. NOTE the AddExpense modal uses
      // aria-label="Add member to expense" (NOT "Add member" which is
      // the CreateGroup modal). Selecting the wrong one leaves
      // expenseMembers empty → activity fan-out skips the recipient.
      await s.evaluate((recipient) => {
        const setVal = (sel: string, value: string) => {
          const inp = document.querySelector(sel) as HTMLInputElement | null;
          if (!inp) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
          setter.call(inp, value);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setVal('input[placeholder="What was this expense for?"]', "E2E test expense");
        setVal('input[placeholder="0.00"]', "2");
        setVal('input[placeholder="0x..."]', recipient);
        const addBtn = document.querySelector('button[aria-label="Add member to expense"]') as HTMLButtonElement | null;
        if (addBtn) addBtn.click();
      }, setup.recipient.address);
      await s.waitForTimeout(500);

      // Click "Add Expense" inside modal
      await s.evaluate(() => {
        const cancel = Array.from(document.querySelectorAll("button")).find(
          (b) => /^cancel$/i.test((b.textContent || "").trim()),
        );
        if (!cancel || !cancel.parentElement) throw new Error("modal not open");
        const siblings = Array.from(cancel.parentElement.querySelectorAll("button"));
        const addBtn = siblings.find(
          (b) => b !== cancel && /add expense/i.test((b.textContent || "").trim()),
        );
        if (addBtn) (addBtn as HTMLButtonElement).click();
      });
      console.log("  [S] submitted Add Expense modal");
      await s.waitForTimeout(2_000);

      // Up to 3 prompts: approve + warmup + addExpense
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(s, PASSPHRASE, 90_000);
          console.log(`  [S] ✅ filled addExpense prompt #${i + 1}`);
        } catch {
          console.log(`  [S] no addExpense prompt #${i + 1}`);
          break;
        }
        await s.waitForTimeout(2_000);
      }

      const expenseResult = await pollForNewActivityRow(s, expenseQuery, {
        label: "group-expense",
        baselineHashes: expenseBaseline,
      });
      expect(expenseResult.newRows.length, "recipient must receive group_expense activity").toBeGreaterThan(0);
      await s.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-5b-expense-added.png"), fullPage: true });
      console.log(`  [S] expense row: ${expenseResult.newRows[0].tx_hash}`);

      // ─── Step 3 : recipient settles their share ────────────────────
      const r = recipientCtx.page;
      // settleDebt inserts activity_type = "debt_settled" (not "group_settlement")
      const settleQuery = `activities?user_from=eq.${recipientLower}&activity_type=eq.debt_settled`;
      const settleBaseline = await captureBaseline(r, settleQuery);

      await r.goto("/app/groups");
      await r.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await r.waitForTimeout(8_000);
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-5c-recipient-groups.png"), fullPage: true });

      // Click Settle for our group
      const settleClickOk = await r.evaluate((gid) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const settleBtns = buttons.filter((b) => /^settle$/i.test((b.textContent || "").trim()));
        if (settleBtns.length === 0) {
          return {
            ok: false,
            why: "no Settle button",
            visible: buttons.slice(0, 20).map((b) => (b.textContent || "").trim()).filter(Boolean),
          };
        }
        (settleBtns[0] as HTMLButtonElement).click();
        return { ok: true, count: settleBtns.length, gid };
      }, groupId);
      console.log("  [R] settle click:", JSON.stringify(settleClickOk).slice(0, 300));
      expect(settleClickOk.ok, "Settle button must exist").toBe(true);
      await r.waitForTimeout(1_500);

      // JS-fill bypass.
      await r.evaluate((sender) => {
        const setVal = (sel: string, value: string) => {
          const inp = document.querySelector(sel) as HTMLInputElement | null;
          if (!inp) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
          setter.call(inp, value);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setVal('input[placeholder="0x..."]', sender);
        setVal('input[placeholder="0.00"]', "1");
      }, setup.sender.address);
      await r.waitForTimeout(500);

      // Click Settle button in modal
      await r.evaluate(() => {
        const cancel = Array.from(document.querySelectorAll("button")).find(
          (b) => /^cancel$/i.test((b.textContent || "").trim()),
        );
        if (!cancel || !cancel.parentElement) throw new Error("modal not open");
        const siblings = Array.from(cancel.parentElement.querySelectorAll("button"));
        const settleBtn = siblings.find(
          (b) => b !== cancel && /^settle(\s|$)/i.test((b.textContent || "").trim()),
        );
        if (settleBtn) (settleBtn as HTMLButtonElement).click();
      });
      console.log("  [R] submitted Settle modal");
      await r.waitForTimeout(2_000);

      // Up to 3 prompts: approve + warmup + settleDebt
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(r, PASSPHRASE, 90_000);
          console.log(`  [R] ✅ filled settleDebt prompt #${i + 1}`);
        } catch {
          console.log(`  [R] no settleDebt prompt #${i + 1}`);
          break;
        }
        await r.waitForTimeout(2_000);
      }

      const settleResult = await pollForNewActivityRow(r, settleQuery, {
        label: "group-settle",
        baselineHashes: settleBaseline,
      });
      await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-5d-recipient-settled.png"), fullPage: true });
      expect(settleResult.newRows.length, "recipient must insert group_settlement activity").toBeGreaterThan(0);
      console.log("  ✅ Group expense + settle cross-account verified");
    } finally {
      await Promise.race([
        senderCtx.context.close().catch(() => {}),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
      await Promise.race([
        recipientCtx.context.close().catch(() => {}),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
    }
  });
});
