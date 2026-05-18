import { type Page, type BrowserContext, type Browser, expect } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const SCREENSHOT_DIR = path.resolve(__dirname, "..", "..", "test-results", "screenshots");
const SETUP_JSON = path.resolve(__dirname, "..", "fixtures", "phase6-setup.json");

export interface AccountFixture {
  address: string;
  passkey: { pubX: string; pubY: string; privKey: string };
  seed: string;
}

export interface Phase6Setup {
  chainId: number;
  sender: AccountFixture;
  recipient: AccountFixture;
  contracts: Record<string, string>;
}

export const PASSPHRASE = "phase6-test-pass";
export const SUPABASE_URL = "https://nlwooeqotxmfjdaizjus.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sd29vZXFvdHhtZmpkYWl6anVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NzgyNTcsImV4cCI6MjA5MDM1NDI1N30.EHPoMd6Ts8aZPmcLBn68FCAiz2uYk4pjx7IodrR8r1g";

export function loadSetup(): Phase6Setup {
  return JSON.parse(fs.readFileSync(SETUP_JSON, "utf8"));
}

/** Wire console + relay + pageerror logs prefixed with the account label so
 *  output is readable when 2 contexts are running in parallel. */
export function instrumentPage(page: Page, label: string) {
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("Coinbase Wallet SDK")) return;
    console.log(`    [${label}.b.${msg.type()}]`, text.slice(0, 400));
  });
  page.on("pageerror", (err) => {
    console.log(`    [${label}.PAGEERROR]`, err.message?.slice(0, 600));
  });
  page.on("response", async (res) => {
    if (res.url().includes("/api/relay")) {
      console.log(`    [${label}.http<-${res.status()}] /api/relay`);
      if (res.status() >= 400) {
        try { const body = await res.text(); console.log(`    [${label}.http.body]`, body.slice(0, 400)); } catch {}
      }
    }
  });
}

/** Open a fresh browser context, set the active chain, import the passkey,
 *  and land on /app with the dashboard rendered. */
export async function openAccountPage(
  browser: Browser,
  account: AccountFixture,
  chainId: number,
  label: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  instrumentPage(page, label);

  await page.goto("/");
  await page.evaluate((id) => {
    localStorage.setItem("blank:active_chain_id", String(id));
  }, chainId);

  await page.goto("/app");
  await page.evaluate(
    async ({ chainId, privKey, passphrase, label }) => {
      const passkey = await import("/src/lib/passkey.ts");
      await passkey.deletePasskey(chainId).catch(() => {});
      return passkey._testImportPasskey(chainId, privKey, passphrase, label);
    },
    { chainId, privKey: account.passkey.privKey, passphrase: PASSPHRASE, label: `phase6-${label}` },
  );
  await page.goto("/app");
  await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });
  // Let SmartAccountCofheBinder finish binding.
  await page.waitForTimeout(8_000);
  return { context, page };
}

/** Same JS-direct passphrase fill used in Phase 2/3/4 tests — bypasses
 *  Playwright's actionability check that hangs while the cofhe SDK iframe is
 *  busy postmessaging. */
export async function answerPassphrasePrompt(page: Page, passphrase: string, timeoutMs = 180_000) {
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

/** JS-direct click — same reason as fill above. Searches by visible text. */
export async function clickByText(page: Page, text: string | RegExp, opts?: { last?: boolean }) {
  const re = typeof text === "string" ? new RegExp(text, "i") : text;
  const ok = await page.evaluate(({ pattern, flags, last }) => {
    const r = new RegExp(pattern, flags);
    const btns = Array.from(document.querySelectorAll("button")).filter((b) =>
      r.test((b.textContent || "").trim()),
    );
    if (btns.length === 0) return { ok: false, count: 0 };
    const target = last ? btns[btns.length - 1] : btns[0];
    (target as HTMLButtonElement).click();
    return { ok: true, count: btns.length };
  }, { pattern: re.source, flags: re.flags, last: !!opts?.last });
  if (!ok.ok) throw new Error(`clickByText: no button matching ${re} (count=${ok.count})`);
  await page.waitForTimeout(500);
}

/** Pre-fetch baseline rows for a Supabase activity query, then poll for a
 *  NEW row not in the baseline (so a stale row from a prior test doesn't
 *  cause a false-positive). */
export type ActivityRow = { tx_hash: string; user_from: string; user_to: string; activity_type: string; note?: string };

/** Snapshot the current set of tx_hashes for `query`. Pass to
 *  pollForNewActivityRow as `baselineHashes` so any subsequent insert is
 *  detected as a true NEW row (not one that existed before the test ran). */
export async function captureBaseline(page: Page, query: string): Promise<Set<string>> {
  const url = `${SUPABASE_URL}/rest/v1/${query}&select=tx_hash`;
  const res = await page.request.get(url, { headers: { apikey: SUPABASE_ANON_KEY } });
  if (res.status() !== 200) return new Set();
  const rows = (await res.json()) as Array<{ tx_hash: string }>;
  return new Set(rows.map((r) => r.tx_hash));
}

export async function pollForNewActivityRow(
  page: Page,
  query: string,
  opts?: { attempts?: number; intervalMs?: number; label?: string; baselineHashes?: Set<string> },
): Promise<{ baseline: number; newRows: ActivityRow[] }> {
  const url = `${SUPABASE_URL}/rest/v1/${query}`;
  const headers = { apikey: SUPABASE_ANON_KEY };
  // Use externally-provided baseline if given (avoids re-snapshotting at a
  // moment when the new row may already have landed).
  const baselineHashes = opts?.baselineHashes ?? (await captureBaseline(page, query));
  const label = opts?.label ?? "poll";
  console.log(`  [${label}] baseline size: ${baselineHashes.size}`);

  const attempts = opts?.attempts ?? 60;
  const interval = opts?.intervalMs ?? 3_000;
  for (let i = 0; i < attempts; i++) {
    const res = await page.request.get(url + "&order=created_at.desc&limit=20", { headers });
    if (res.status() === 200) {
      const all = (await res.json()) as ActivityRow[];
      const newRows = all.filter((r) => !baselineHashes.has(r.tx_hash));
      if (newRows.length > 0) {
        console.log(`  [${label}] found ${newRows.length} new rows after ${i * interval / 1000}s`);
        return { baseline: baselineHashes.size, newRows };
      }
    }
    if (i % 5 === 0) console.log(`  [${label}] poll[${i}] still waiting...`);
    await page.waitForTimeout(interval);
  }
  return { baseline: baselineHashes.size, newRows: [] };
}

/** Wait until the recipient's UI shows a fresh activity row appear via
 *  Supabase realtime. Looks for any activity row containing the sender's
 *  short address (e.g. "0x021a") or a known activity type label in the
 *  visible DOM. Polls the page every 2s up to timeoutMs. */
export async function waitForUiNotification(
  page: Page,
  matchers: { textRegex?: RegExp; toastRegex?: RegExp },
  timeoutMs = 60_000,
): Promise<{ found: boolean; how: string; sample?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(({ tr, tor }) => {
      const body = (document.body.innerText || "").slice(0, 5000);
      const toasts = Array.from(document.querySelectorAll("[role=status], [class*=toast]"))
        .map((e) => e.textContent?.slice(0, 200) ?? "")
        .join(" | ");
      const tre = tr ? new RegExp(tr.pattern, tr.flags) : null;
      const tore = tor ? new RegExp(tor.pattern, tor.flags) : null;
      const inText = tre ? tre.test(body) : false;
      const inToast = tore ? tore.test(toasts) : false;
      return {
        inText, inToast,
        textHit: inText ? body.match(tre!)?.[0] : null,
        toastHit: inToast ? toasts.match(tore!)?.[0] : null,
      };
    }, {
      tr: matchers.textRegex ? { pattern: matchers.textRegex.source, flags: matchers.textRegex.flags } : null,
      tor: matchers.toastRegex ? { pattern: matchers.toastRegex.source, flags: matchers.toastRegex.flags } : null,
    });
    if (result.inText) return { found: true, how: "text", sample: result.textHit ?? "" };
    if (result.inToast) return { found: true, how: "toast", sample: result.toastHit ?? "" };
    await page.waitForTimeout(2_000);
  }
  return { found: false, how: "" };
}
