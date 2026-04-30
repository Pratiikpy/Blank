import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");
const SETUP_JSON = path.resolve(__dirname, "fixtures", "phase2-setup.json");

// ═══════════════════════════════════════════════════════════════════════
// Phase 3 #1 — GIFT ENVELOPE (Base Sepolia, real on-chain)
//
// Pre-conditions: Phase 2 setup ran. Smart account has encrypted USDC in
// the FHERC20Vault. We create a $5 gift envelope to a single recipient
// (the same one used in Phase 2 send tests).
//
// Verifies:
//   1. Sender can navigate to /app/gifts and submit the form
//   2. Two passphrase prompts (approve + createEnvelope) are signed via JS
//      bypass — the real-fill blocker we hit in Phase 2 affects this too
//   3. UserOps confirm on-chain via /api/relay
//   4. Recipient row appears in Supabase activities with type=gift_created
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

// Same JS-direct fill we proved works in phase2-send. Playwright's normal
// fill() hangs on actionability checks while the cofhe SDK iframe is active,
// even though the input is functionally interactable. Skip Playwright's
// machinery and drive the controlled component directly.
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

test.describe("Phase 3 #1 — Gift Envelope (Base Sepolia)", () => {
  test.setTimeout(600_000);

  let setup: Phase2Setup;
  test.beforeAll(() => {
    setup = loadSetup();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate((chainId) => {
      localStorage.setItem("blank_active_chain_id", String(chainId));
    }, setup.chainId);
  });

  test("create $5 gift envelope → recipient sees gift_created activity", async ({ page }) => {
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

    // ─── Setup ─────────────────────────────────────────────────────────
    await page.goto("/app");
    await importPrefundedPasskey(page, setup);
    await page.goto("/app");
    await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });

    // ─── Navigate to /app/gifts ────────────────────────────────────────
    await page.goto("/app/gifts");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    // Wait for SmartAccountCofheBinder to bind the SDK to the smart wallet
    // (encryptInputsAsync below depends on that binding). Same ~8s the
    // SendConfirm screen needs.
    await page.waitForTimeout(8_000);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p3-1a-gifts-form.png"),
      fullPage: true,
    });

    // ─── Fill form ─────────────────────────────────────────────────────
    // Amount
    const amountInput = page.locator('input[placeholder="0.00"]').first();
    await amountInput.fill("5");

    // Recipient — the placeholder is "0x... (address)"
    const recipientInput = page.locator('input[placeholder*="0x"]').first();
    await recipientInput.fill(setup.recipient);

    // Select a theme — the "Send Gift Envelope" button is gated behind
    // `{selectedTheme && (...)}` in Gifts.tsx. Without a theme, the button
    // simply doesn't render.
    await page.getByRole("button", { name: /Select Birthday theme/i }).click();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p3-1b-gifts-filled.png"),
      fullPage: true,
    });

    // ─── Submit ────────────────────────────────────────────────────────
    // Use JS dispatch — same reason as answerPassphrasePrompt: cofhe SDK
    // iframe churn makes Playwright's post-click stability wait hang, even
    // though the click handler did fire and the flow is progressing.
    const clickOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => b.textContent?.includes("Send Gift Envelope"));
      if (!target) return { ok: false, why: "button not found" };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  clicked Send Gift Envelope via JS:", JSON.stringify(clickOk));
    await page.waitForTimeout(2_000);

    // Fill up to 3 prompts: warmup, approve, createEnvelope. All optional —
    // the passphrase unlock cache may carry through multiple signs.
    for (let i = 0; i < 3; i++) {
      try {
        await answerPassphrasePrompt(page, PASSPHRASE, 180_000);
        console.log(`  ✅ filled prompt #${i + 1}`);
      } catch {
        console.log(`  no prompt #${i + 1} — signed from unlock cache`);
        break;
      }
    }

    // Debug: snapshot UI every 15s until either success or timeout, so we can
    // see whether the UI actually stalled mid-flow.
    for (let i = 0; i < 20; i++) {
      const state = await page.evaluate(() => {
        const h = document.body.innerText;
        const toastEls = Array.from(document.querySelectorAll("[role=status], [class*=toast]")).map((e) => e.textContent?.slice(0, 150) ?? "").filter(Boolean);
        return {
          hasSuccess: /Gift Sent!/i.test(h),
          stepLabel: (h.match(/(Approving|Encrypting|Sending|Processing)[^\n]*/i) || [])[0] ?? null,
          anyError: (h.match(/(Failed|error|revert|insufficient)[^\n]*/i) || [])[0]?.slice(0, 150) ?? null,
          toasts: toastEls,
          url: location.href,
        };
      });
      console.log(`  [snap ${i}@${i*15}s]`, JSON.stringify(state).slice(0, 400));
      if (state.hasSuccess) break;
      await page.waitForTimeout(15_000);
    }
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "p3-1c-gift-success.png"),
      fullPage: true,
    });
    await expect(page.getByText(/Gift Sent!/i)).toBeVisible({ timeout: 5_000 });
    console.log("  ✅ Gift envelope created on-chain");

    // ─── Verify recipient sees the gift_created activity in Supabase ───
    const recipientLower = setup.recipient.toLowerCase();
    const supabaseUrl = process.env.VITE_SUPABASE_URL || "https://nlwooeqotxmfjdaizjus.supabase.co";
    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sd29vZXFvdHhtZmpkYWl6anVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NzgyNTcsImV4cCI6MjA5MDM1NDI1N30.EHPoMd6Ts8aZPmcLBn68FCAiz2uYk4pjx7IodrR8r1g";
    const res = await page.request.get(
      `${supabaseUrl}/rest/v1/activities?user_to=eq.${recipientLower}&activity_type=eq.gift_created&order=created_at.desc&limit=5`,
      { headers: { apikey: anonKey } },
    );
    expect(res.status(), "Supabase fetch").toBe(200);
    const rows = (await res.json()) as Array<{
      tx_hash: string;
      user_from: string;
      user_to: string;
      activity_type: string;
      note: string;
    }>;
    console.log(`  Recipient has ${rows.length} gift_created rows`);
    expect(rows.length, "recipient must have at least one gift_created row").toBeGreaterThan(0);
    const recent = rows[0];
    expect(recent.user_from.toLowerCase(), "from = smart account").toBe(setup.smartAccount.toLowerCase());
    expect(recent.activity_type, "activity_type").toBe("gift_created");
    console.log("  ✅ Recipient sees gift_created — cross-user flow verified");
  });
});
