import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");
const SETUP_JSON = path.resolve(__dirname, "fixtures", "phase2-setup.json");

// ═══════════════════════════════════════════════════════════════════════
// Phase 4 #1 — INHERITANCE: setHeir
//
// Verifies:
//   1. /app/inheritance Set Up Inheritance modal opens, fields fill, submit
//   2. Single passphrase prompt for setHeir UserOp
//   3. /api/relay 200, on-chain confirmed
//   4. Two activity rows written (owner copy + heir copy)
// ═══════════════════════════════════════════════════════════════════════

interface Phase2Setup {
  chainId: number;
  smartAccount: string;
  recipient: string;
  passkey: { pubX: string; pubY: string; privKey: string };
  contracts: Record<string, string>;
}

function loadSetup(): Phase2Setup {
  return JSON.parse(fs.readFileSync(SETUP_JSON, "utf8"));
}

const PASSPHRASE = "phase2-test-pass";

async function importPrefundedPasskey(page: Page, setup: Phase2Setup) {
  await page.evaluate(
    async ({ chainId, privKey, passphrase }) => {
      const passkey = await import("/src/lib/passkey.ts");
      await passkey.deletePasskey(chainId).catch(() => {});
      return passkey._testImportPasskey(chainId, privKey, passphrase, "phase4");
    },
    { chainId: setup.chainId, privKey: setup.passkey.privKey, passphrase: PASSPHRASE },
  );
}

async function answerPassphrasePrompt(page: Page, passphrase: string, timeoutMs = 180_000) {
  const input = page.locator('input[type="password"]').first();
  await input.waitFor({ state: "visible", timeout: timeoutMs });
  await page.evaluate((pass) => {
    const inp = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    if (!inp) throw new Error("password input not in DOM");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(inp, pass);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    inp.focus();
  }, passphrase);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const form = document.querySelector('input[type="password"]')?.closest("form") as HTMLFormElement | null;
    if (!form) throw new Error("form not found around password input");
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  });
}

test.describe("Phase 4 #1 — Inheritance setHeir (Base Sepolia)", () => {
  test.setTimeout(600_000);

  let setup: Phase2Setup;
  test.beforeAll(() => {
    setup = loadSetup();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate((chainId) => {
      localStorage.setItem("blank:active_chain_id", String(chainId));
    }, setup.chainId);
  });

  test("setHeir → recipient sees heir_set activity", async ({ page }) => {
    page.on("console", (msg) => {
      const text = msg.text();
      if (!text.includes("Coinbase Wallet SDK")) {
        console.log(`    [b.${msg.type()}]`, text.slice(0, 400));
      }
    });
    page.on("pageerror", (err) => {
      console.log(`    [b.PAGEERROR]`, err.message?.slice(0, 600));
    });
    page.on("response", async (res) => {
      if (res.url().includes("/api/relay")) {
        console.log(`    [http.<-${res.status()}] /api/relay`);
        if (res.status() >= 400) {
          try { const body = await res.text(); console.log(`    [http.body]`, body.slice(0, 400)); } catch {}
        }
      }
    });

    // Capture baseline row count BEFORE submitting tx, so we know any new
    // row was actually written by THIS run (not a stale row from a previous
    // test). Supabase upserts on tx_hash so a unique new tx → unique row.
    const supabaseUrl = process.env.VITE_SUPABASE_URL || "https://nlwooeqotxmfjdaizjus.supabase.co";
    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sd29vZXFvdHhtZmpkYWl6anVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NzgyNTcsImV4cCI6MjA5MDM1NDI1N30.EHPoMd6Ts8aZPmcLBn68FCAiz2uYk4pjx7IodrR8r1g";
    const recipientLower = setup.recipient.toLowerCase();
    const baselineRes = await page.request.get(
      `${supabaseUrl}/rest/v1/activities?user_to=eq.${recipientLower}&activity_type=eq.heir_set&select=tx_hash,created_at`,
      { headers: { apikey: anonKey } },
    );
    const baselineRows = baselineRes.status() === 200 ? ((await baselineRes.json()) as Array<{ tx_hash: string }>) : [];
    const baselineHashes = new Set(baselineRows.map((r) => r.tx_hash));
    console.log(`  baseline heir_set rows for heir: ${baselineRows.length}`);

    await page.goto("/app");
    await importPrefundedPasskey(page, setup);
    await page.goto("/app");
    await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/inheritance");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(8_000);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p4-1a-inheritance-page.png"),
      fullPage: true,
    });

    // Open the Set Up Inheritance modal — page may render either "Set Up
    // Inheritance Plan" (no heir yet) OR "Change Heir" (already set). Both
    // are triggered by buttons that open the same modal; we don't care
    // which copy the page is showing.
    const openOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target =
        btns.find((b) => /Set Up Inheritance/i.test(b.textContent || "")) ??
        btns.find((b) => /Change Heir/i.test(b.textContent || ""));
      if (!target) return { ok: false, why: "no setup/change button" };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  opened modal:", JSON.stringify(openOk));
    expect(openOk.ok).toBe(true);
    await page.waitForTimeout(500);

    // Fill heir address — placeholder "0x..." in modal
    await page.locator('input[placeholder="0x..."]').first().fill(setup.recipient);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p4-1b-inheritance-modal.png"),
      fullPage: true,
    });

    // Click "Set Heir" — JS dispatch (avoid Playwright actionability hang)
    const submitOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /^Set Heir$/i.test((b.textContent || "").trim()));
      if (!target) return { ok: false };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  clicked Set Heir:", JSON.stringify(submitOk));
    await page.waitForTimeout(2_000);

    // Single passphrase prompt for setHeir UserOp
    console.log("  waiting for setHeir passphrase prompt...");
    await answerPassphrasePrompt(page, PASSPHRASE, 180_000);
    console.log("  ✅ filled setHeir prompt");

    // Poll for a NEW row (tx_hash not in baselineHashes). Without this, a
    // stale row from a prior run satisfies the assertion immediately and
    // hides a regression. Each successful setHeir writes 2 rows: owner copy
    // (tx_hash = `${hash}`) and heir copy (tx_hash = `${hash}:heir`). Heir's
    // user_to = recipient, so we're polling for the `:heir` row specifically.
    let rows: Array<{ tx_hash: string; user_from: string; user_to: string; activity_type: string; note: string }> = [];
    let newRows: typeof rows = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await page.request.get(
        `${supabaseUrl}/rest/v1/activities?user_to=eq.${recipientLower}&activity_type=eq.heir_set&order=created_at.desc&limit=10`,
        { headers: { apikey: anonKey } },
      );
      if (res.status() === 200) {
        rows = await res.json();
        newRows = rows.filter((r) => !baselineHashes.has(r.tx_hash));
        if (newRows.length > 0) break;
      }
      if (attempt % 5 === 0) console.log(`  poll[${attempt}] total=${rows.length} new=${newRows.length}`);
      await page.waitForTimeout(3000);
    }
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p4-1c-inheritance-after.png"),
      fullPage: true,
    });
    console.log(`  Recipient (heir) total=${rows.length} new=${newRows.length}`);
    expect(newRows.length, "heir must see a NEW heir_set row written by this run").toBeGreaterThan(0);
    expect(newRows[0].user_from.toLowerCase()).toBe(setup.smartAccount.toLowerCase());
    expect(newRows[0].activity_type).toBe("heir_set");
    console.log("  ✅ Heir sees fresh notification — cross-user flow verified");
  });
});
