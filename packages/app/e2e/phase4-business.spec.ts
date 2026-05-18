import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");
const SETUP_JSON = path.resolve(__dirname, "fixtures", "phase2-setup.json");

// Phase 4 #3 — BUSINESS TOOLS createInvoice (encrypted amount, single tx).

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

test.describe("Phase 4 #3 — Business createInvoice (Base Sepolia)", () => {
  test.setTimeout(600_000);

  let setup: Phase2Setup;
  test.beforeAll(() => { setup = loadSetup(); });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate((chainId) => {
      localStorage.setItem("blank:active_chain_id", String(chainId));
    }, setup.chainId);
  });

  test("createInvoice → client sees invoice_created activity", async ({ page }) => {
    page.on("console", (msg) => {
      const text = msg.text();
      if (!text.includes("Coinbase Wallet SDK")) console.log(`    [b.${msg.type()}]`, text.slice(0, 400));
    });
    page.on("pageerror", (err) => console.log(`    [b.PAGEERROR]`, err.message?.slice(0, 600)));
    page.on("response", async (res) => {
      if (res.url().includes("/api/relay")) {
        console.log(`    [http.<-${res.status()}] /api/relay`);
        if (res.status() >= 400) {
          try { const body = await res.text(); console.log(`    [http.body]`, body.slice(0, 400)); } catch {}
        }
      }
    });

    const supabaseUrl = process.env.VITE_SUPABASE_URL || "https://nlwooeqotxmfjdaizjus.supabase.co";
    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sd29vZXFvdHhtZmpkYWl6anVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NzgyNTcsImV4cCI6MjA5MDM1NDI1N30.EHPoMd6Ts8aZPmcLBn68FCAiz2uYk4pjx7IodrR8r1g";
    const recipientLower = setup.recipient.toLowerCase();
    const baselineRes = await page.request.get(
      `${supabaseUrl}/rest/v1/activities?user_to=eq.${recipientLower}&activity_type=eq.invoice_created&select=tx_hash`,
      { headers: { apikey: anonKey } },
    );
    const baselineRows = baselineRes.status() === 200 ? ((await baselineRes.json()) as Array<{ tx_hash: string }>) : [];
    const baselineHashes = new Set(baselineRows.map((r) => r.tx_hash));
    console.log(`  baseline invoice_created rows for client: ${baselineRows.length}`);

    await page.goto("/app");
    await importPrefundedPasskey(page, setup);
    await page.goto("/app");
    await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/business");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-3a-business-page.png"), fullPage: true });

    // Click "New Invoice" button to open modal
    const openOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /New Invoice/i.test((b.textContent || "").trim()));
      if (!target) return { ok: false };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  opened invoice modal:", JSON.stringify(openOk));
    expect(openOk.ok).toBe(true);
    await page.waitForTimeout(500);

    // Fill client / amount / description via JS to bypass Playwright's
    // actionability check (which hangs on this modal — input never
    // becomes "actionable" even though it's visible). Fires React's
    // onChange via the native input setter + dispatchEvent.
    await page.evaluate(({ recipient }) => {
      const setVal = (sel: string, value: string) => {
        const inp = document.querySelector(sel) as HTMLInputElement | null;
        if (!inp) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(inp, value);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      setVal('input[placeholder="0x..."]', recipient);
      setVal('input[placeholder="0.00"]', "3");
      setVal('input[placeholder="Services rendered"]', "e2e invoice");
    }, { recipient: setup.recipient });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-3b-business-filled.png"), fullPage: true });

    // Click submit "Create Invoice"
    const submitOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /^Create Invoice$/i.test((b.textContent || "").trim()));
      if (!target) return { ok: false };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  clicked Create Invoice:", JSON.stringify(submitOk));
    await page.waitForTimeout(2_000);

    // Up to 3 prompts on a fresh context: (1) CoFHE permits.createSelf
    // warmup, (2) vault approve (skipped if BusinessHub already approved),
    // (3) createInvoice. Loop breaks early when no further prompt appears.
    for (let i = 0; i < 3; i++) {
      try {
        await answerPassphrasePrompt(page, PASSPHRASE, 60_000);
        console.log(`  ✅ filled prompt #${i + 1}`);
      } catch {
        console.log(`  no prompt #${i + 1} within timeout (likely vault already approved)`);
        break;
      }
      await page.waitForTimeout(2_000);
    }

    // Poll for new invoice_created row
    let allRows: Array<{ tx_hash: string; user_from: string; user_to: string; activity_type: string; note: string }> = [];
    let newRows: typeof allRows = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await page.request.get(
        `${supabaseUrl}/rest/v1/activities?user_to=eq.${recipientLower}&activity_type=eq.invoice_created&order=created_at.desc&limit=10`,
        { headers: { apikey: anonKey } },
      );
      if (res.status() === 200) {
        allRows = await res.json();
        newRows = allRows.filter((r) => !baselineHashes.has(r.tx_hash));
        if (newRows.length > 0) break;
      }
      if (attempt % 5 === 0) console.log(`  poll[${attempt}] total=${allRows.length} new=${newRows.length}`);
      await page.waitForTimeout(3000);
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-3c-business-after.png"), fullPage: true });
    console.log(`  client has total=${allRows.length} new=${newRows.length}`);
    expect(newRows.length, "client must see fresh invoice_created row").toBeGreaterThan(0);
    expect(newRows[0].user_from.toLowerCase()).toBe(setup.smartAccount.toLowerCase());
    expect(newRows[0].activity_type).toBe("invoice_created");
    console.log("  ✅ Invoice activity verified — cross-user flow works");
  });
});
