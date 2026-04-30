import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR,
} from "./helpers/phase6-helpers";

// Phase 7 #4 — Sender creates gift to recipient + recipient claims (split into
// two sequential contexts so the dev server doesn't get overwhelmed).
//
// Critical because gift claim is a recipient-side UserOp that does NOT need
// encryption from the recipient. The sender's encrypted share is already
// stored in the contract; the recipient just calls claimGift(envelopeId).
//
// If this passes, we've proven that recipient smart account works fine for
// any flow that doesn't require recipient-side encryption — which is the
// crucial product capability for "I send to you, you receive."

test.describe("Phase 7 #4 — Sender creates gift, recipient claims", () => {
  test.setTimeout(900_000);

  test("create + claim cross-account", async ({ browser }) => {
    const setup = loadSetup();
    const recipientLower = setup.recipient.address.toLowerCase();

    // ─── Step 1: Sender creates gift envelope to recipient ───────────
    let envelopeId: number | null = null;
    {
      const senderCtx = await openAccountPage(browser, setup.sender, setup.chainId, "S");
      try {
        const s = senderCtx.page;
        const createdQuery = `activities?user_to=eq.${recipientLower}&activity_type=eq.gift_created`;
        const baseline = await captureBaseline(s, createdQuery);

        await s.goto("/app/gifts");
        await s.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await s.waitForTimeout(8_000);

        // JS-fill bypass — Playwright's actionability check hangs on
        // these forms. Same workaround as phase4-business / phase4-groups.
        await s.evaluate((recipient) => {
          const setVal = (sel: string, value: string) => {
            const inp = document.querySelector(sel) as HTMLInputElement | null;
            if (!inp) return;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
            setter.call(inp, value);
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
          };
          setVal('input[placeholder="0.00"]', "1");
          setVal('input[placeholder*="0x"]', recipient);
        }, setup.recipient.address);
        await s.getByRole("button", { name: /Select Birthday theme/i }).click();
        await s.waitForTimeout(500);

        await s.evaluate(() => {
          const target = Array.from(document.querySelectorAll("button")).find((b) =>
            b.textContent?.includes("Send Gift Envelope"),
          );
          if (target) (target as HTMLButtonElement).click();
        });
        await s.waitForTimeout(2_000);

        for (let i = 0; i < 4; i++) {
          try {
            await answerPassphrasePrompt(s, PASSPHRASE, 60_000);
            console.log(`  [S] ✅ filled prompt #${i + 1}`);
          } catch {
            console.log(`  [S] no prompt #${i + 1}`);
            break;
          }
          await s.waitForTimeout(2_000);
        }

        const created = await pollForNewActivityRow(s, createdQuery, {
          label: "create",
          baselineHashes: baseline,
          attempts: 80,
        });
        expect(created.newRows.length, "sender must create a new gift").toBeGreaterThan(0);
        const m = (created.newRows[0].note ?? "").match(/\[envelope:(\d+)\]/);
        expect(m, "gift note must include envelope ID").toBeTruthy();
        envelopeId = parseInt(m![1], 10);
        console.log(`  [S] created envelope ID ${envelopeId}`);
      } finally {
        // Playwright's close() hangs when the page has runaway request
        // loops (RPC retries flood the socket pool). Race with a 5s
        // timeout — cleanup is best-effort, the context will be GC'd
        // when the test process exits anyway.
        await Promise.race([
          senderCtx.context.close().catch(() => {}),
          new Promise((res) => setTimeout(res, 5000)),
        ]);
      }
    }

    // ─── Step 2: Recipient claims it ─────────────────────────────────
    {
      const recipientCtx = await openAccountPage(browser, setup.recipient, setup.chainId, "R");
      try {
        const r = recipientCtx.page;
        const claimQuery = `activities?user_from=eq.${recipientLower}&activity_type=eq.gift_claimed`;
        const baseline = await captureBaseline(r, claimQuery);

        await r.goto("/app/gifts");
        await r.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await r.waitForTimeout(8_000);
        await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-4a-recipient-gifts.png"), fullPage: true });

        const clickOk = await r.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll("button")).filter((b) =>
            /^(Claim|Open|Accept)$/i.test((b.textContent || "").trim()),
          );
          if (candidates.length === 0) {
            const allText = Array.from(document.querySelectorAll("button"))
              .slice(0, 20).map((b) => (b.textContent || "").trim()).filter(Boolean);
            return { ok: false, why: "no Claim btn", available: allText };
          }
          (candidates[0] as HTMLButtonElement).click();
          return { ok: true };
        });
        console.log("  [R] click claim:", JSON.stringify(clickOk).slice(0, 500));
        expect(clickOk.ok, "recipient must find Claim button").toBe(true);
        await r.waitForTimeout(2_000);

        await answerPassphrasePrompt(r, PASSPHRASE, 180_000);
        console.log("  [R] ✅ filled claim prompt");

        const claimed = await pollForNewActivityRow(r, claimQuery, {
          label: "claim",
          baselineHashes: baseline,
        });
        await r.screenshot({ path: path.join(SCREENSHOT_DIR, "p7-4b-recipient-claimed.png"), fullPage: true });
        expect(claimed.newRows.length, "recipient must see new gift_claimed row").toBeGreaterThan(0);
        console.log(`  ✅ Cross-account create + claim verified — envelope ${envelopeId}`);
      } finally {
        await Promise.race([
          recipientCtx.context.close().catch(() => {}),
          new Promise((res) => setTimeout(res, 5000)),
        ]);
      }
    }
  });
});
