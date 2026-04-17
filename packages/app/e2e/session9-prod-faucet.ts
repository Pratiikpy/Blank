// Create passkey via real UI on prod → click faucet → wait for real toast.
// No dev-only helpers. Honest end-to-end verification.

import { chromium, type Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "test-results", "prod-faucet");
const BASE = "https://blank-omega-jade.vercel.app";
const PASSPHRASE = `s9-${Date.now()}`;

fs.mkdirSync(OUT, { recursive: true });
let step = 0;
async function snap(p: Page, label: string) {
  step++;
  const f = `${String(step).padStart(3, "0")}-${label}.png`;
  await p.screenshot({ path: path.join(OUT, f), fullPage: true }).catch(() => {});
  return f;
}

async function clickByText(page: Page, regex: RegExp, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate((src: string) => {
      const re = new RegExp(src, "i");
      const btns = Array.from(document.querySelectorAll("button"));
      const btn = btns.find((b) => re.test((b.textContent || "").trim()));
      if (btn && !(btn as HTMLButtonElement).disabled) { (btn as HTMLButtonElement).click(); return true; }
      return false;
    }, regex.source);
    if (ok) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function fillAllPasswordInputs(page: Page, value: string) {
  await page.evaluate((v: string) => {
    const inputs = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (const el of inputs) {
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, value);
}

async function readToasts(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("[data-sonner-toast], [role='status'], .Toastify__toast, [class*='toast']"));
    return nodes.map((n) => (n as HTMLElement).innerText).join(" | ");
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  console.log(`[session9] ${BASE} passphrase=${PASSPHRASE.slice(0, 8)}...`);

  // Step 1: Land on /app
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await snap(page, "landed");

  // Step 2: Click Next through carousel until Continue with Passkey appears
  for (let i = 0; i < 6; i++) {
    const hasCreate = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        /continue with passkey/i.test((b.textContent || "").trim()),
      ),
    );
    if (hasCreate) break;
    const nextClicked = await clickByText(page, /^next$/i, 2500);
    if (!nextClicked) break;
    await page.waitForTimeout(700);
  }
  await snap(page, "at-passkey-step");

  // Step 3: Click Continue with Passkey — opens PasskeyCreationModal
  const opened = await clickByText(page, /continue with passkey/i, 5000);
  console.log(`  continue-with-passkey clicked: ${opened}`);
  await page.waitForTimeout(2000);
  await snap(page, "modal-opened");

  // Step 4: Fill both password inputs
  await fillAllPasswordInputs(page, PASSPHRASE);
  await page.waitForTimeout(500);
  await snap(page, "passphrase-filled");

  // Step 5: Click Create Smart Wallet
  const created = await clickByText(page, /^create smart wallet$/i, 5000);
  console.log(`  create-smart-wallet clicked: ${created}`);

  // Wait for success → auto-close → dashboard
  await page.waitForTimeout(4000);
  await snap(page, "post-create");

  // Step 6: Verify we're on the dashboard
  const onDashboard = await page.evaluate(() => /good (morning|afternoon|evening)/i.test(document.body.innerText));
  console.log(`  on-dashboard: ${onDashboard}`);
  await snap(page, "dashboard-check");

  if (!onDashboard) {
    console.log("[session9] FAIL: not on dashboard after passkey create");
    await browser.close();
    process.exit(1);
  }

  // Step 7: Click Get Test USDC
  await page.waitForTimeout(2000);
  const faucetClicked = await clickByText(page, /get test usdc/i, 8000);
  console.log(`  faucet-clicked: ${faucetClicked}`);
  if (!faucetClicked) {
    await snap(page, "faucet-btn-missing");
    console.log("[session9] FAIL: faucet button not clickable");
    await browser.close();
    process.exit(1);
  }

  // Step 8: Passphrase prompt appears → submit it
  await page.waitForTimeout(1500);
  await snap(page, "faucet-passphrase-prompt");
  await fillAllPasswordInputs(page, PASSPHRASE);
  await page.waitForTimeout(300);
  const unlocked = await clickByText(page, /^unlock$/i, 5000);
  console.log(`  unlock-clicked: ${unlocked}`);

  // Step 9: Wait for toast (success or error)
  const start = Date.now();
  let toastText = "";
  while (Date.now() - start < 120_000) {
    toastText = await readToasts(page);
    if (/minted|ran out of gas|rejected|failed|cancelled|error|crashed|insufficient|relayer/i.test(toastText)) break;
    await page.waitForTimeout(1000);
  }
  await snap(page, "faucet-final");

  console.log(`\n=== RESULT ===`);
  console.log(`  toast: ${toastText || "(no toast within 120s)"}`);
  const balance = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/Public USDC Balance:\s*([\d.,]+)/i);
    return m?.[1] ?? "(not parsed)";
  });
  console.log(`  public balance: ${balance}`);

  const success = /minted/i.test(toastText);
  console.log(`  passkey-transaction-works: ${success ? "YES" : "NO"}`);

  if (consoleErrors.length > 0) {
    console.log(`\n  console errors (top 5):`);
    consoleErrors.slice(0, 5).forEach((e) => console.log(`    ${e}`));
  }

  await browser.close();
  process.exit(success ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
