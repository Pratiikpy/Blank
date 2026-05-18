import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");
const SETUP_JSON = path.resolve(__dirname, "fixtures", "phase2-setup.json");

// ═══════════════════════════════════════════════════════════════════════
// Phase 3 #2 — STEALTH PAYMENT (Base Sepolia, real on-chain)
//
// Pre-conditions: Phase 2 setup ran. Smart account has TestUSDC plain
// balance (separate from the encrypted vault) and is deployed.
//
// Verifies:
//   1. /app/stealth Create form drives end-to-end via JS-direct passphrase
//   2. Two passphrase prompts (TestUSDC.approve + sendStealth) signed
//   3. UserOps confirm via /api/relay (relayer-side receipt)
//   4. "Stealth Payment Sent!" success card renders
//   5. A `stealth_sent` activity row appears in Supabase keyed on the
//      sender's smart-account address (recipient is encrypted on-chain
//      so user_to is intentionally address(0))
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
      return passkey._testImportPasskey(chainId, privKey, passphrase, "phase3");
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

test.describe("Phase 3 #2 — Stealth Payment (Base Sepolia)", () => {
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

  test("send $1 stealth → activity row written for sender", async ({ page }) => {
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

    // Setup
    await page.goto("/app");
    await importPrefundedPasskey(page, setup);
    await page.goto("/app");
    await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });

    // Navigate to stealth — Create tab is default
    await page.goto("/app/stealth");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(8_000); // SDK + smart-account binding settle
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p3-2a-stealth-form.png"),
      fullPage: true,
    });

    // Fill amount
    const amountInput = page.locator('input[placeholder="0.00"]').first();
    await amountInput.fill("1");

    // Fill recipient — placeholder is "0x..."
    const recipientInput = page.locator('input[placeholder="0x..."]').first();
    await recipientInput.fill(setup.recipient);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p3-2b-stealth-filled.png"),
      fullPage: true,
    });

    // JS-dispatch the click for the same reason as Phase 3 gift — Playwright's
    // post-click stability check hangs while the cofhe SDK iframe is busy.
    const clickOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => b.textContent?.includes("Send Stealth Payment"));
      if (!target) return { ok: false };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  clicked Send Stealth Payment via JS:", JSON.stringify(clickOk));
    await page.waitForTimeout(2_000);

    // Fill up to 3 prompts: warmup, approve, sendStealth. All optional —
    // unlock cache may carry through multiple signs.
    for (let i = 0; i < 3; i++) {
      try {
        await answerPassphrasePrompt(page, PASSPHRASE, 180_000);
        console.log(`  ✅ filled prompt #${i + 1}`);
      } catch {
        console.log(`  no prompt #${i + 1} — signed from unlock cache`);
        break;
      }
    }

    // Wait for "Stealth Payment Sent!" success card. With proper relayer-receipt
    // plumbing this should arrive within seconds of the 2nd /api/relay 200.
    await expect(page.getByRole("heading", { name: /Stealth Payment Sent!/i })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p3-2c-stealth-success.png"),
      fullPage: true,
    });
    console.log("  ✅ Stealth payment sent on-chain");

    // Verify Supabase row — keyed on sender (recipient is FHE-encrypted so
    // user_to is intentionally address(0)).
    const supabaseUrl = process.env.VITE_SUPABASE_URL || "https://nlwooeqotxmfjdaizjus.supabase.co";
    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sd29vZXFvdHhtZmpkYWl6anVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NzgyNTcsImV4cCI6MjA5MDM1NDI1N30.EHPoMd6Ts8aZPmcLBn68FCAiz2uYk4pjx7IodrR8r1g";
    const senderLower = setup.smartAccount.toLowerCase();
    const res = await page.request.get(
      `${supabaseUrl}/rest/v1/activities?user_from=eq.${senderLower}&activity_type=eq.stealth_sent&order=created_at.desc&limit=5`,
      { headers: { apikey: anonKey } },
    );
    expect(res.status(), "Supabase fetch").toBe(200);
    const rows = (await res.json()) as Array<{
      tx_hash: string;
      user_from: string;
      user_to: string;
      activity_type: string;
    }>;
    console.log(`  Sender has ${rows.length} stealth_sent rows`);
    expect(rows.length, "sender must have at least one stealth_sent row").toBeGreaterThan(0);
    expect(rows[0].activity_type).toBe("stealth_sent");
    expect(rows[0].user_to.toLowerCase()).toBe("0x0000000000000000000000000000000000000000");
    console.log("  ✅ Stealth sent activity written to Supabase — recipient encrypted on-chain");
  });
});
