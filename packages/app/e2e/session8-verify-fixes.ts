// ══════════════════════════════════════════════════════════════════
//  Session 8 — Verify the fixes I just shipped actually work on prod
//
//  Checks:
//  1. Passphrase modal renders LIGHT when app is in light mode
//     (previously dark due to Tailwind's media-query dark mode)
//  2. Passphrase modal renders DARK when user toggles dark mode
//  3. Passkey creation modal auto-closes after success (no manual refresh)
//  4. /api/relay returns JSON on invalid input (not HTML crash)
// ══════════════════════════════════════════════════════════════════

import { chromium, type Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "test-results", "verify-fixes");
const BASE = process.env.AUDIT_BASE_URL ?? "https://blank-omega-jade.vercel.app";
const PASSPHRASE = "verify-session8";

fs.mkdirSync(OUT, { recursive: true });
let step = 0;
const results: Array<{ name: string; pass: boolean; detail: string; shot?: string }> = [];

async function snap(p: Page, label: string): Promise<string> {
  step++;
  const f = `${String(step).padStart(3, "0")}-${label}.png`;
  await p.screenshot({ path: path.join(OUT, f), fullPage: true }).catch(() => {});
  return f;
}

function check(name: string, pass: boolean, detail: string, shot?: string) {
  results.push({ name, pass, detail, shot });
  const icon = pass ? "PASS" : "FAIL";
  console.log(`  [${icon}] ${name} — ${detail}`);
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

async function main() {
  console.log(`[session8] Verifying fixes on ${BASE}`);

  const browser = await chromium.launch({ headless: true });

  // ═══════════════════════════════════════════════════════════════
  // Test 1: /api/relay returns JSON (not HTML crash)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== Test 1: /api/relay returns JSON ===");
  const relayCheck = await fetch(`${BASE}/api/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const relayText = await relayCheck.text();
  const isJson = relayText.trim().startsWith("{");
  const status = relayCheck.status;
  check(
    "relay-returns-json",
    isJson && status !== 500,
    `status=${status}, body=${relayText.slice(0, 120)}`,
  );

  // ═══════════════════════════════════════════════════════════════
  // Test 2: Passphrase/Passkey modal renders in LIGHT mode on a
  // browser with OS-level dark preference (previously this would
  // trigger Tailwind's dark: variants and make the modal dark while
  // the app stayed light).
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== Test 2: Modal theme consistency (OS dark preference) ===");
  const ctxDarkOs = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark", // Simulate user's OS in dark mode
  });
  const pageDark = await ctxDarkOs.newPage();
  await pageDark.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await pageDark.waitForTimeout(5000);

  // Ensure the app is NOT in manual dark mode (default on fresh session)
  const hasAppDarkClass = await pageDark.evaluate(() => document.documentElement.classList.contains("dark"));
  check("app-default-light-mode", !hasAppDarkClass, `html.dark present=${hasAppDarkClass}`);

  // Click through onboarding to open the modal
  for (let i = 0; i < 5; i++) {
    const hasCreate = await pageDark.evaluate(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        /continue with passkey/i.test((b.textContent || "").trim()),
      ),
    );
    if (hasCreate) break;
    const next = await clickByText(pageDark, /^next$/i, 2000);
    if (!next) break;
    await pageDark.waitForTimeout(600);
  }

  const openedModal = await clickByText(pageDark, /continue with passkey/i, 3000);
  check("onboarding-reaches-create", openedModal, openedModal ? "found create btn" : "could not find create btn");

  if (openedModal) {
    await pageDark.waitForTimeout(1200);
    const shot = await snap(pageDark, "modal-in-os-dark-mode-but-light-app");

    // Read the actual rendered modal background color
    const modalBg = await pageDark.evaluate(() => {
      const inputs = document.querySelectorAll("input[type='password']");
      if (inputs.length < 2) return null;
      // Walk up from the password input to find the modal box
      let el: HTMLElement | null = inputs[0].closest(".rounded-3xl, .rounded-2xl, [class*='bg-white']") as HTMLElement | null;
      if (!el) el = inputs[0].parentElement?.parentElement?.parentElement as HTMLElement | null;
      if (!el) return null;
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color, html: el.className.slice(0, 200) };
    });

    if (!modalBg) {
      check("modal-bg-detected", false, "could not locate modal element", shot);
    } else {
      // bg-white in light mode = rgb(255, 255, 255) or rgba(255, 255, 255, X)
      // dark mode = rgb(15, 15, 16)-ish
      const isLightBg =
        /rgba?\(2[45][0-9],\s*2[45][0-9],\s*2[45][0-9]/.test(modalBg.bg) ||
        modalBg.bg === "rgb(255, 255, 255)";
      check(
        "modal-light-on-light-app",
        isLightBg,
        `modal bg=${modalBg.bg} (want rgb(255,255,255) or near-white when app is in light mode)`,
        shot,
      );
    }
  }

  await ctxDarkOs.close();

  // ═══════════════════════════════════════════════════════════════
  // Test 3: Verify the same modal is DARK when the app's dark mode
  // is actually enabled (by adding .dark to html)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== Test 3: Modal DARK when app in dark mode ===");
  const ctxAppDark = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageAD = await ctxAppDark.newPage();
  await pageAD.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await pageAD.waitForTimeout(3000);
  await pageAD.evaluate(() => document.documentElement.classList.add("dark"));
  await pageAD.waitForTimeout(500);
  for (let i = 0; i < 5; i++) {
    const hasCreate = await pageAD.evaluate(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        /continue with passkey/i.test((b.textContent || "").trim()),
      ),
    );
    if (hasCreate) break;
    const next = await clickByText(pageAD, /^next$/i, 2000);
    if (!next) break;
    await pageAD.waitForTimeout(600);
  }
  const openedInDark = await clickByText(pageAD, /continue with passkey/i, 3000);
  if (openedInDark) {
    await pageAD.waitForTimeout(1200);
    const shot = await snap(pageAD, "modal-in-app-dark-mode");
    const modalBg = await pageAD.evaluate(() => {
      const inputs = document.querySelectorAll("input[type='password']");
      if (inputs.length < 2) return null;
      let el: HTMLElement | null = inputs[0].closest(".rounded-3xl, .rounded-2xl, [class*='bg-white']") as HTMLElement | null;
      if (!el) el = inputs[0].parentElement?.parentElement?.parentElement as HTMLElement | null;
      if (!el) return null;
      return { bg: getComputedStyle(el).backgroundColor };
    });
    if (modalBg) {
      const isDarkBg = /rgba?\([0-3][0-9]?,\s*[0-3][0-9]?,\s*[0-3][0-9]?/.test(modalBg.bg) || modalBg.bg.includes("rgb(15, 15, 16)");
      check("modal-dark-when-app-dark", isDarkBg, `modal bg=${modalBg.bg}`, shot);
    }
  }
  await ctxAppDark.close();

  // ═══════════════════════════════════════════════════════════════
  // Test 4: Passkey creation modal auto-closes after success
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== Test 4: Modal auto-closes after passkey created ===");
  const ctx4 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p4 = await ctx4.newPage();
  await p4.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await p4.waitForTimeout(4000);

  // Carousel
  for (let i = 0; i < 5; i++) {
    const hasCreate = await p4.evaluate(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        /continue with passkey/i.test((b.textContent || "").trim()),
      ),
    );
    if (hasCreate) break;
    const next = await clickByText(p4, /^next$/i, 2000);
    if (!next) break;
    await p4.waitForTimeout(600);
  }
  await clickByText(p4, /continue with passkey/i, 3000);
  await p4.waitForTimeout(1500);

  // Fill both password inputs
  await p4.evaluate((pw: string) => {
    const inputs = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (const el of inputs) {
      setter.call(el, pw);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, PASSPHRASE);
  await p4.waitForTimeout(300);
  await snap(p4, "passkey-form-filled");

  await clickByText(p4, /^create smart wallet$/i, 3000);
  await p4.waitForTimeout(2000);
  const succShot = await snap(p4, "passkey-success-state");

  // Modal should auto-close 1.2s after success. Wait a touch longer, then check.
  await p4.waitForTimeout(2000);

  const modalStillOpen = await p4.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="password"]');
    return inputs.length > 0;
  });
  const onDashboard = await p4.evaluate(() => {
    const body = document.body.innerText;
    return /good (morning|afternoon|evening)/i.test(body);
  });
  const afterShot = await snap(p4, "after-auto-close");
  check(
    "modal-auto-closes",
    !modalStillOpen,
    `modalStillOpen=${modalStillOpen}, onDashboard=${onDashboard}`,
    afterShot,
  );
  check(
    "landed-on-dashboard",
    onDashboard,
    `dashboard greeting visible=${onDashboard}`,
    afterShot,
  );

  await ctx4.close();
  await browser.close();

  // ═══════════════════════════════════════════════════════════════
  // Report
  // ═══════════════════════════════════════════════════════════════
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n[session8] Done. pass=${pass} fail=${fail}`);

  const md: string[] = [];
  md.push(`# Session 8 — Fix verification`);
  md.push(`- URL: ${BASE}`);
  md.push(`- Time: ${new Date().toISOString()}`);
  md.push(`- pass=${pass} fail=${fail}`);
  md.push(``);
  for (const r of results) {
    md.push(`- **[${r.pass ? "PASS" : "FAIL"}] ${r.name}** ${r.detail}${r.shot ? ` \`${r.shot}\`` : ""}`);
  }
  fs.writeFileSync(path.join(OUT, "report.md"), md.join("\n"));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
  console.log(`Report: ${OUT}/report.md`);

  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
