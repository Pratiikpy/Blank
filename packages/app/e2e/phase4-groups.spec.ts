import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");
const SETUP_JSON = path.resolve(__dirname, "fixtures", "phase2-setup.json");

// Phase 4 #2 — GROUP creation. Single tx (createGroup), no encryption.
// Verifies a fresh group_memberships row appears in Supabase.

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

test.describe("Phase 4 #2 — Group create (Base Sepolia)", () => {
  test.setTimeout(600_000);

  let setup: Phase2Setup;
  test.beforeAll(() => { setup = loadSetup(); });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate((chainId) => {
      localStorage.setItem("blank:active_chain_id", String(chainId));
    }, setup.chainId);
  });

  test("create group with recipient member → group_memberships row written", async ({ page }) => {
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

    // Capture baseline group_memberships count for the recipient — the new
    // group's row must be a strict superset.
    const supabaseUrl = process.env.VITE_SUPABASE_URL || "https://nlwooeqotxmfjdaizjus.supabase.co";
    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sd29vZXFvdHhtZmpkYWl6anVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NzgyNTcsImV4cCI6MjA5MDM1NDI1N30.EHPoMd6Ts8aZPmcLBn68FCAiz2uYk4pjx7IodrR8r1g";
    const recipientLower = setup.recipient.toLowerCase();
    const groupName = `e2e-group-${Date.now()}`;
    console.log(`  group name: ${groupName}`);
    const baselineRes = await page.request.get(
      `${supabaseUrl}/rest/v1/group_memberships?member_address=eq.${recipientLower}&select=group_id,group_name`,
      { headers: { apikey: anonKey } },
    );
    const baselineRows = baselineRes.status() === 200 ? ((await baselineRes.json()) as Array<{ group_id: number; group_name: string }>) : [];
    const baselineGroupIds = new Set(baselineRows.map((r) => r.group_id));
    console.log(`  baseline group_memberships for recipient: ${baselineRows.length}`);

    await page.goto("/app");
    await importPrefundedPasskey(page, setup);
    await page.goto("/app");
    await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/groups");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-2a-groups-page.png"), fullPage: true });

    // Click "Create Group" (top of page — opens modal)
    const openOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) => /Create Group/i.test((b.textContent || "").trim()));
      if (!target) return { ok: false };
      (target as HTMLButtonElement).click();
      return { ok: true };
    });
    console.log("  opened create modal:", JSON.stringify(openOk));
    expect(openOk.ok).toBe(true);
    await page.waitForTimeout(500);

    // Fill group name + member input via JS to bypass Playwright's
    // actionability check (which hangs on these modals — same workaround
    // the spec already uses for the submit button below).
    await page.evaluate(({ name, recipient }) => {
      const setVal = (sel: string, value: string) => {
        const inp = document.querySelector(sel) as HTMLInputElement | null;
        if (!inp) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(inp, value);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      setVal('input[placeholder="Weekend getaway"]', name);
      setVal('input[placeholder="0x..."]', recipient);
    }, { name: groupName, recipient: setup.recipient });
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Add member"]') as HTMLButtonElement | null;
      if (btn) btn.click();
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-2b-groups-filled.png"), fullPage: true });

    // Click the modal's "Create Group" submit button (NOT the page-level open
    // button). The modal button has text "Create Group" too — picking the
    // LAST one in DOM order ensures we hit the modal's submit.
    const submitOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button")).filter(
        (b) => /^Create Group$/i.test((b.textContent || "").trim()),
      );
      const target = btns[btns.length - 1]; // last = modal's submit
      if (!target) return { ok: false, count: btns.length };
      (target as HTMLButtonElement).click();
      return { ok: true, count: btns.length };
    });
    console.log("  clicked Create Group submit:", JSON.stringify(submitOk));
    await page.waitForTimeout(2_000);

    // Up to 3 prompts: cofhe warmup + (optional) approve + createGroup.
    console.log("  waiting for createGroup passphrase prompts...");
    for (let i = 0; i < 3; i++) {
      try {
        await answerPassphrasePrompt(page, PASSPHRASE, 90_000);
        console.log(`  ✅ filled createGroup prompt #${i + 1}`);
      } catch {
        console.log(`  no prompt #${i + 1} — flow proceeded`);
        break;
      }
      await page.waitForTimeout(2_000);
    }

    // Poll for new membership row
    let allRows: Array<{ group_id: number; group_name: string; member_address: string }> = [];
    let newRows: typeof allRows = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await page.request.get(
        `${supabaseUrl}/rest/v1/group_memberships?member_address=eq.${recipientLower}&select=group_id,group_name,member_address&order=group_id.desc&limit=20`,
        { headers: { apikey: anonKey } },
      );
      if (res.status() === 200) {
        allRows = await res.json();
        newRows = allRows.filter((r) => !baselineGroupIds.has(r.group_id));
        if (newRows.length > 0) break;
      }
      if (attempt % 5 === 0) console.log(`  poll[${attempt}] total=${allRows.length} new=${newRows.length}`);
      await page.waitForTimeout(3000);
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p4-2c-groups-after.png"), fullPage: true });
    console.log(`  membership rows total=${allRows.length} new=${newRows.length}`);
    expect(newRows.length, "recipient must see new group_memberships row").toBeGreaterThan(0);
    expect(newRows[0].group_name).toBe(groupName);
    console.log("  ✅ Group membership written to Supabase — cross-user flow verified");
  });
});
