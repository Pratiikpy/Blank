import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");
const SETUP_JSON = path.resolve(__dirname, "fixtures", "phase2-setup.json");

// Phase 4 #5 — CREATOR SUPPORT (tip an existing creator).
// Uses an existing creator profile already in Supabase ("Prateek" from
// previous setup) so we don't have to create one in the test.

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

// Pre-existing Sepolia profile, won't show on Base Sepolia. We'll create
// our own under the smart account, then support ourselves. The flow exercises
// both the setProfile UserOp path (newly migrated to unifiedWriteAndWait)
// and the support UserOp path.

test.describe("Phase 4 #5 — Creator Support tip (Base Sepolia)", () => {
  test.setTimeout(600_000);

  let setup: Phase2Setup;
  test.beforeAll(() => { setup = loadSetup(); });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate((chainId) => {
      localStorage.setItem("blank_active_chain_id", String(chainId));
    }, setup.chainId);
  });

  test("create profile + support self → tip activity written", async ({ page }) => {
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
    // Query tips SENT by us (user_from=us). Contract forbids self-tip,
    // so the recipient varies per run — baselining by user_from gives
    // a stable diff regardless of which other creator we tip.
    const baselineRes = await page.request.get(
      `${supabaseUrl}/rest/v1/activities?user_from=eq.${senderLower}&activity_type=eq.tip&select=tx_hash`,
      { headers: { apikey: anonKey } },
    );
    const baselineRows = baselineRes.status() === 200 ? ((await baselineRes.json()) as Array<{ tx_hash: string }>) : [];
    const baselineHashes = new Set(baselineRows.map((r) => r.tx_hash));
    console.log(`  baseline tip rows for sender: ${baselineRows.length}`);

    await page.goto("/app");
    await importPrefundedPasskey(page, setup);
    await page.goto("/app");
    await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/creators");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-5a-creators-page.png"), fullPage: true });

    // ─── Step 1: Create profile under our smart account (idempotent) ───
    // If "Edit Profile" is shown, profile already exists — skip creation
    // and proceed straight to the support flow. Otherwise click "Set Up
    // Profile" and create one.
    const profileState = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const setupBtn = btns.find((b) => /Set Up Profile/i.test((b.textContent || "").trim()));
      const editBtn = btns.find((b) => /Edit Profile/i.test((b.textContent || "").trim()));
      if (editBtn) return { kind: "exists" as const };
      if (setupBtn) {
        (setupBtn as HTMLButtonElement).click();
        return { kind: "create" as const };
      }
      return { kind: "neither" as const };
    });
    console.log("  profile state:", JSON.stringify(profileState));
    expect(profileState.kind).not.toBe("neither");

    if (profileState.kind === "create") {
      await page.waitForTimeout(500);
      await page.locator('input[placeholder="Your name"]').first().fill(`e2e-creator-${Date.now()}`);
      const createProfileOk = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => /^Create Profile$/i.test((b.textContent || "").trim()));
        if (!target) return { ok: false };
        (target as HTMLButtonElement).click();
        return { ok: true };
      });
      console.log("  clicked Create Profile:", JSON.stringify(createProfileOk));
      expect(createProfileOk.ok).toBe(true);
      await page.waitForTimeout(2_000);

      // setProfile UserOp prompt
      console.log("  waiting for setProfile prompt...");
      await answerPassphrasePrompt(page, PASSPHRASE, 180_000);
      console.log("  ✅ filled setProfile prompt");

      // Wait for profile to appear in creators list (page refetches after create)
      await page.waitForTimeout(8_000);
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-5a2-after-profile.png"), fullPage: true });

    // ─── Step 2: Click Support on a creator OTHER than self ──────────
    // Contract rejects self-tip (`CreatorHub: cannot self-tip`), so we
    // must pick a creator whose data-creator-address differs from our
    // smart account.
    const selectOk = await page.evaluate((selfAddr) => {
      const self = selfAddr.toLowerCase();
      const cards = Array.from(document.querySelectorAll("[data-creator-address]"));
      const otherCard = cards.find((c) => c.getAttribute("data-creator-address") !== self);
      if (otherCard) {
        const btn = otherCard.querySelector("button");
        if (btn) {
          (btn as HTMLButtonElement).click();
          const targetAddr = otherCard.getAttribute("data-creator-address");
          return { ok: true, by: "other-creator", targetAddr };
        }
      }
      return { ok: false, why: "no other creator card", totalCards: cards.length };
    }, setup.smartAccount);
    console.log("  selected creator:", JSON.stringify(selectOk));
    expect(selectOk.ok).toBe(true);
    await page.waitForTimeout(500);

    // Click the $5 tier (Supporter)
    const tierOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      // Tier buttons contain "$5" (Supporter), "$15" (Fan), etc. Pick the $5 one.
      const target = btns.find((b) => /^\s*[A-Z][a-z]+\s*\$5\s*$/.test((b.textContent || "").trim()));
      if (!target) {
        // Fallback: any button whose text starts with "$5"
        const fallback = btns.find((b) => /\$5(\s|$)/.test((b.textContent || "").trim()));
        if (!fallback) return { ok: false };
        (fallback as HTMLButtonElement).click();
        return { ok: true, by: "fallback" };
      }
      (target as HTMLButtonElement).click();
      return { ok: true, by: "primary" };
    });
    console.log("  selected tier:", JSON.stringify(tierOk));
    expect(tierOk.ok).toBe(true);
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-5b-creators-tier.png"), fullPage: true });

    // Click "Send $5 Support" submit
    const submitOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /Send \$\d+ Support/i.test((b.textContent || "").trim()));
      if (!target) return { ok: false };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  clicked Send Support:", JSON.stringify(submitOk));
    expect(submitOk.ok).toBe(true);
    await page.waitForTimeout(2_000);

    // Vault-approve prompt + support prompt
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

    let allRows: Array<{ tx_hash: string; user_from: string; user_to: string; activity_type: string }> = [];
    let newRows: typeof allRows = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await page.request.get(
        `${supabaseUrl}/rest/v1/activities?user_from=eq.${senderLower}&activity_type=eq.tip&order=created_at.desc&limit=10`,
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
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-5c-creators-after.png"), fullPage: true });
    console.log(`  sender has total=${allRows.length} new=${newRows.length}`);
    expect(newRows.length, "sender must see fresh tip row").toBeGreaterThan(0);
    expect(newRows[0].user_from.toLowerCase()).toBe(senderLower);
    expect(newRows[0].activity_type).toBe("tip");
    console.log("  ✅ Tip verified — cross-creator support flow works");
  });
});
