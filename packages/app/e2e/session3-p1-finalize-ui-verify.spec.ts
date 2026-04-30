import { test, expect } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, SCREENSHOT_DIR,
} from "./helpers/phase6-helpers";

// UI verification of the Finalize fix:
//
// Preconditions (data-path test confirmed these):
//  - Supabase has >= 1 invoice with client_address = recipient.address (lowercased)
//    and status = "payment_pending" on chain 84532
//
// What this test verifies:
//  - When the CLIENT (recipient) opens /app/business, the Invoices tab renders
//    at least one row with a "Finalize" button
//  - Without the fetchClientInvoices + case-insensitive UI fixes, this row would
//    be hidden and the button would never render

test.describe("P1 — Finalize UI visibility", () => {
  test.setTimeout(180_000); // 3 min — UI-only, no tx

  test("client sees Finalize button on payment_pending invoice", async ({ browser }) => {
    const setup = loadSetup();
    const clientCtx = await openAccountPage(browser, setup.recipient, setup.chainId, "C");

    try {
      const c = clientCtx.page;
      await c.goto("/app/business");
      await c.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await c.waitForTimeout(8_000);
      await c.screenshot({ path: path.join(SCREENSHOT_DIR, "ui-verify-01-business.png"), fullPage: true });

      // Count buttons by text — we want at least one "Finalize" button visible
      const counts = await c.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        return {
          finalize: buttons.filter((b) => /^finalize$/i.test((b.textContent || "").trim())).length,
          pay: buttons.filter((b) => /^pay$/i.test((b.textContent || "").trim())).length,
          total: buttons.length,
        };
      });
      console.log(`  buttons visible: finalize=${counts.finalize} pay=${counts.pay} total=${counts.total}`);
      expect(counts.finalize, "at least one Finalize button should render for the client").toBeGreaterThan(0);
      console.log("  ✅ Finalize button visibility verified for client");
    } finally {
      await clientCtx.context.close();
    }
  });
});
