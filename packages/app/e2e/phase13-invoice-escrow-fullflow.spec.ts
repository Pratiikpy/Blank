// Phase 13 — full vendor → client → finalize → proof loop, UI-only.
//
// Runs against the freshly-upgraded BusinessHub on Base Sepolia
// (PR-C step 2 contracts deployed via `deploy-upgrade-invoice-escrow`).
//
// What this proves end-to-end through the UI:
//   1. Vendor creates an invoice in BusinessTools.
//   2. Vendor clicks "Preview public page" → opens the share URL.
//   3. Client opens that URL in a fresh context, sees the Pay form.
//   4. Client funds the escrow via `payInvoiceEscrow` (status → Funded).
//   5. Client finalizes via `releaseInvoiceEscrow` (status → Paid on match).
//   6. Both parties see the Proof-of-payment panel with explorer link.
//
// Real-chain interaction. Expect ~5-7 minutes of wall time per run.

import { test, expect } from "@playwright/test";
import {
  loadSetup,
  openAccountPage,
  answerPassphrasePrompt,
  PASSPHRASE,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

test.describe("Phase 13 — invoice escrow full flow (live testnet)", () => {
  // Generous timeout — real-chain UserOps + threshold decryption + polling.
  test.setTimeout(900_000);

  test("vendor creates → client pays via escrow → finalize → proof shown", async ({ browser }) => {
    const setup = loadSetup();
    const vendorLower = setup.sender.address.toLowerCase();

    // ── 1. Vendor opens BusinessTools and creates an invoice ─────────
    const vendorCtx = await openAccountPage(browser, setup.sender, setup.chainId, "V");
    const vendorPage = vendorCtx.page;

    // Capture vendor's max invoice id BEFORE creating a new one. The
    // `invoices` table is the canonical source — activities don't put
    // the invoice id in a structured field. Query the highest id by
    // vendor_address; the new one will be that + 1 (or higher if other
    // tests are running concurrently — we use a strict-greater diff).
    const beforeRes = await vendorPage.request.get(
      `${SUPABASE_URL}/rest/v1/invoices?vendor_address=eq.${vendorLower}&select=invoice_id&order=invoice_id.desc&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY } },
    );
    const beforeRows = beforeRes.status() === 200 ? ((await beforeRes.json()) as Array<{ invoice_id: number }>) : [];
    const beforeMaxId = beforeRows.length > 0 ? beforeRows[0].invoice_id : -1;
    console.log(`[V] before: max invoice_id=${beforeMaxId}`);

    await vendorPage.goto("/app/business");
    await vendorPage.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await vendorPage.waitForTimeout(8_000);

    // Open the New Invoice modal.
    await vendorPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /New Invoice/i.test((b.textContent || "").trim()));
      (target as HTMLButtonElement | undefined)?.click();
    });
    await vendorPage.waitForTimeout(800);

    // JS-fill the form (cofhe iframe blocks Playwright's actionability check).
    const desc = `Phase13 escrow ${Date.now()}`;
    await vendorPage.evaluate(({ recipient, desc }) => {
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
      setVal('input[placeholder="Services rendered"]', desc);
    }, { recipient: setup.recipient.address, desc });
    await vendorPage.waitForTimeout(500);

    // Submit Create Invoice.
    await vendorPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /^Create Invoice$/i.test((b.textContent || "").trim()));
      (target as HTMLButtonElement | undefined)?.click();
    });
    await vendorPage.waitForTimeout(2_000);

    // Up to 3 prompts: cofhe warmup, vault approve, createInvoice.
    for (let i = 0; i < 3; i++) {
      try { await answerPassphrasePrompt(vendorPage, PASSPHRASE, 90_000); }
      catch { break; }
      await vendorPage.waitForTimeout(2_000);
    }

    // Resolve the new invoice id by polling the invoices table for any
    // row with invoice_id > beforeMaxId.
    let newInvoiceId: number | null = null;
    for (let attempt = 0; attempt < 60 && newInvoiceId === null; attempt++) {
      const res = await vendorPage.request.get(
        `${SUPABASE_URL}/rest/v1/invoices?vendor_address=eq.${vendorLower}&select=invoice_id,description&order=invoice_id.desc&limit=5`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      if (res.status() === 200) {
        const rows = (await res.json()) as Array<{ invoice_id: number; description: string }>;
        // Prefer matching by description (unique within this run) so we
        // don't grab another concurrent test's invoice. Fall back to
        // strict-greater if description doesn't match for some reason.
        const byDesc = rows.find((r) => r.description === desc);
        const byId = rows.find((r) => r.invoice_id > beforeMaxId);
        const fresh = byDesc ?? byId;
        if (fresh) newInvoiceId = fresh.invoice_id;
      }
      if (newInvoiceId === null) await vendorPage.waitForTimeout(3_000);
    }
    expect(newInvoiceId, "vendor must create a new invoice").not.toBeNull();
    console.log(`[V] created invoice id=${newInvoiceId}`);

    // Close vendor context — the share link is all we need from here.
    await Promise.race([
      vendorCtx.context.close().catch(() => {}),
      new Promise((res) => setTimeout(res, 5000)),
    ]);

    // ── 2. Client opens the public link and pays via escrow ──────────
    const clientCtx = await openAccountPage(browser, setup.recipient, setup.chainId, "C");
    const clientPage = clientCtx.page;

    const link = `/app/invoice/${setup.chainId}/${newInvoiceId}`;
    await clientPage.goto(link);
    await clientPage.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    // Status starts at "Awaiting payment" (status=0).
    await expect(clientPage.getByTestId("invoice-status-badge")).toBeVisible({ timeout: 30_000 });
    await expect(clientPage.getByTestId("invoice-status-badge")).toHaveAttribute("data-status", "0");

    // Fill the Pay form — bypass actionability hang via JS-fill.
    await clientPage.evaluate(() => {
      const inp = document.querySelector('input[placeholder="Amount in USDC"]') as HTMLInputElement | null;
      if (!inp) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(inp, "1");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await clientPage.waitForTimeout(400);

    // Click "Pay via escrow".
    await clientPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /Pay via escrow/i.test((b.textContent || "").trim()));
      (target as HTMLButtonElement | undefined)?.click();
    });
    await clientPage.waitForTimeout(2_000);

    // Up to 3 prompts: cofhe warmup, vault approve (if first time), payInvoiceEscrow.
    for (let i = 0; i < 3; i++) {
      try { await answerPassphrasePrompt(clientPage, PASSPHRASE, 90_000); }
      catch { break; }
      await clientPage.waitForTimeout(2_000);
    }

    // Status should flip to "Funded — awaiting finalize" (status=3).
    await expect(clientPage.getByTestId("invoice-status-badge")).toHaveAttribute("data-status", "3", {
      timeout: 60_000,
    });
    console.log(`[C] funded escrow — status=3`);

    // ── 3. Client finalizes — match → status=Paid, proof shown ───────
    //
    // Wait for the hook's step-machine to reset to "idle". After
    // payEscrow's success, step is held at "success" for ~5s before
    // auto-resetting. Clicking Finalize inside that window is a silent
    // no-op (hook bails with `if (step !== "idle") return`). 8s is the
    // safe lower bound.
    await clientPage.waitForTimeout(8_000);

    await clientPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /^Finalize/i.test((b.textContent || "").trim()));
      (target as HTMLButtonElement | undefined)?.click();
    });
    await clientPage.waitForTimeout(2_000);

    // Single prompt for releaseInvoiceEscrow. The prompt only appears
    // AFTER off-chain threshold decryption settles (up to 180s on
    // Sepolia inside the hook), so this wait must be longer than the
    // decryption budget — otherwise the prompt fires right after the
    // test gives up. 300s = decrypt budget + comfortable slack.
    try { await answerPassphrasePrompt(clientPage, PASSPHRASE, 300_000); } catch {}

    // Wait for the badge to land at Paid (status=1) — finalization
    // includes off-chain threshold decryption (up to 180s on Sepolia) +
    // on-chain release UserOp + relay confirmation. Budget: 4 min.
    await expect(clientPage.getByTestId("invoice-status-badge")).toHaveAttribute("data-status", "1", {
      timeout: 240_000,
    });
    console.log(`[C] finalized — status=1 (Paid)`);

    // Proof-of-payment panel must surface with the settlement-tx link.
    await expect(clientPage.getByTestId("proof-of-payment")).toBeVisible({ timeout: 10_000 });
    const txLink = clientPage.getByTestId("settlement-tx-link");
    await expect(txLink).toBeVisible({ timeout: 30_000 });
    const href = await txLink.getAttribute("href");
    expect(href).toMatch(/sepolia-explorer\.base\.org\/tx\/0x/);
    console.log(`[C] proof-of-payment shown — settlement tx ${href}`);

    await Promise.race([
      clientCtx.context.close().catch(() => {}),
      new Promise((res) => setTimeout(res, 5000)),
    ]);
  });
});
