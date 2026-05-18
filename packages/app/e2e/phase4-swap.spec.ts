import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");
const SETUP_JSON = path.resolve(__dirname, "fixtures", "phase2-setup.json");

// Phase 4 #4 — P2P Exchange createOffer.

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

test.describe("Phase 4 #4 — Swap createOffer (Base Sepolia)", () => {
  test.setTimeout(600_000);

  let setup: Phase2Setup;
  test.beforeAll(() => { setup = loadSetup(); });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate((chainId) => {
      localStorage.setItem("blank:active_chain_id", String(chainId));
    }, setup.chainId);
  });

  test("createOffer → exchange_offers row written", async ({ page }) => {
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
    const senderLower = setup.smartAccount.toLowerCase();
    const baselineRes = await page.request.get(
      `${supabaseUrl}/rest/v1/exchange_offers?maker_address=eq.${senderLower}&select=offer_id`,
      { headers: { apikey: anonKey } },
    );
    const baselineRows = baselineRes.status() === 200 ? ((await baselineRes.json()) as Array<{ offer_id: number }>) : [];
    const baselineIds = new Set(baselineRows.map((r) => r.offer_id));
    console.log(`  baseline exchange_offers for maker: ${baselineRows.length}`);

    await page.goto("/app");
    await importPrefundedPasskey(page, setup);
    await page.goto("/app");
    await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/swap");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-4a-swap-page.png"), fullPage: true });

    // Fill give + want amounts (both placeholder "0.00")
    const amountInputs = page.locator('input[placeholder="0.00"]');
    await amountInputs.nth(0).fill("1");
    await amountInputs.nth(1).fill("2");

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-4b-swap-filled.png"), fullPage: true });

    // Click Create Offer
    const submitOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /Create Swap Offer/i.test((b.textContent || "").trim()));
      if (!target) return { ok: false };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  clicked Create Offer:", JSON.stringify(submitOk));
    await page.waitForTimeout(2_000);

    // Approve (vault → P2PExchange) prompt + createOffer prompt. P2PExchange
    // approval may already be cached, so loop through up to 2 prompts.
    for (let i = 0; i < 4; i++) {
      try {
        await answerPassphrasePrompt(page, PASSPHRASE, 60_000);
        console.log(`  ✅ filled prompt #${i + 1}`);
      } catch {
        console.log(`  no prompt #${i + 1} (vault probably already approved)`);
        break;
      }
      await page.waitForTimeout(2_000);
    }

    // Poll for new offer
    let allRows: Array<{ offer_id: number; maker_address: string; amount_give: number; amount_want: number; status: string }> = [];
    let newRows: typeof allRows = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await page.request.get(
        `${supabaseUrl}/rest/v1/exchange_offers?maker_address=eq.${senderLower}&order=created_at.desc&limit=10`,
        { headers: { apikey: anonKey } },
      );
      if (res.status() === 200) {
        allRows = await res.json();
        newRows = allRows.filter((r) => !baselineIds.has(r.offer_id));
        if (newRows.length > 0) break;
      }
      if (attempt % 5 === 0) console.log(`  poll[${attempt}] total=${allRows.length} new=${newRows.length}`);
      await page.waitForTimeout(3000);
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-4c-swap-after.png"), fullPage: true });
    console.log(`  maker has total=${allRows.length} new=${newRows.length}`);
    expect(newRows.length, "maker must see fresh exchange_offer row").toBeGreaterThan(0);
    expect(newRows[0].maker_address.toLowerCase()).toBe(senderLower);
    expect(newRows[0].amount_give).toBe(1);
    expect(newRows[0].amount_want).toBe(2);
    console.log("  ✅ Swap offer verified — flow works");
  });
});
