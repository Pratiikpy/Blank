// ══════════════════════════════════════════════════════════════════
//  Session 7 — Full visual audit against PROD
//
//  Targets https://blank-omega-jade.vercel.app (not local dev).
//  Uses the real UI flow (PasskeyCreationModal) to create a passkey —
//  no dev-only test helpers available in the prod bundle.
// ══════════════════════════════════════════════════════════════════

import { chromium, type Page, type ConsoleMessage } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "test-results", "prod-visual");
const BASE = process.env.AUDIT_BASE_URL ?? "https://blank-omega-jade.vercel.app";
const PASSPHRASE = "prod-audit-session7-passphrase";

interface Finding { phase: string; severity: "pass" | "fail" | "warn" | "info"; message: string; shot?: string; }
const findings: Finding[] = [];
const consoleLogs: string[] = [];
let step = 0;
fs.mkdirSync(OUT, { recursive: true });

function report(phase: string, severity: Finding["severity"], message: string, shot?: string) {
  findings.push({ phase, severity, message, shot });
  const icon = { pass: "OK", fail: "X", warn: "!", info: "-" }[severity];
  console.log(`  [${icon}] ${phase} — ${message}${shot ? ` (${shot})` : ""}`);
}

async function snap(p: Page, label: string): Promise<string> {
  step++;
  const f = `${String(step).padStart(3, "0")}-${label}.png`;
  await p.screenshot({ path: path.join(OUT, f), fullPage: true }).catch(() => {});
  return f;
}

function attach(page: Page) {
  page.on("console", (msg: ConsoleMessage) => {
    const t = msg.type();
    if (t === "error" || t === "warning") {
      const text = msg.text();
      if (/DevTools|Download the React DevTools|Third-party cookie/i.test(text)) return;
      consoleLogs.push(`[${t}] ${text.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${err.message.slice(0, 300)}`));
}

async function fillByTestId(page: Page, testid: string, value: string): Promise<boolean> {
  return await page.evaluate(([t, v]: [string, string]) => {
    const el = document.querySelector(`input[data-testid="${t}"]`) as HTMLInputElement | null;
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, [testid, value] as [string, string]);
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

async function fillPassphraseModal(page: Page, value: string) {
  // Generic password-input filler; PassphrasePrompt and PasskeyCreationModal
  // both render <input type="password"> when visible.
  await page.evaluate((p: string) => {
    const inputs = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (const el of inputs) {
      setter.call(el, p);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, value);
  await page.waitForTimeout(200);
}

async function waitForToast(page: Page, match: RegExp, timeoutMs = 60_000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const txt = await page.evaluate(() => {
      const toasts = Array.from(document.querySelectorAll("[data-sonner-toast], [role='status'], .Toastify__toast, [class*='toast']"));
      return toasts.map((t) => (t as HTMLElement).innerText).join(" | ");
    });
    if (match.test(txt)) return txt;
    await page.waitForTimeout(500);
  }
  return null;
}

async function main() {
  console.log(`[session7] PROD audit → ${BASE}`);
  console.log(`[session7] Output → ${OUT}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  attach(page);

  // ── P1: Land on /app (should show Onboarding for fresh user) ────
  console.log("\n=== P1: Land on /app ===");
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5_000);
  report("P1", "info", "Loaded /app", await snap(page, "01-onboarding"));

  // ── P2: Create passkey via UI ───────────────────────────────────
  console.log("\n=== P2: Create passkey ===");
  // Onboarding is a 4-step carousel. Click Next ≤5 times until we
  // reach a screen with a "Create Smart Wallet" button.
  for (let i = 0; i < 6; i++) {
    const foundCreate = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("button")).some((b) =>
        /create smart wallet|continue with passkey|set up passphrase/i.test((b.textContent || "").trim()),
      );
    });
    if (foundCreate) break;
    const clickedNext = await clickByText(page, /^next$/i, 3_000);
    if (!clickedNext) break;
    await page.waitForTimeout(900);
  }
  await snap(page, "02-onboarding-last-step");
  const clickedCreate = await clickByText(page, /create smart wallet|continue with passkey/i, 5_000);
  if (!clickedCreate) {
    report("P2", "warn", "Could not find final create button after carousel", await snap(page, "03-no-create-btn"));
  } else {
    await page.waitForTimeout(1_500);
  }
  await snap(page, "04-passkey-modal");

  // Fill BOTH passphrase inputs (modal has new + confirm)
  const filled = await page.evaluate((p: string) => {
    const inputs = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    if (inputs.length < 2) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (const el of inputs) {
      setter.call(el, p);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }, PASSPHRASE);
  if (!filled) {
    report("P2", "fail", "Could not find two password inputs in the modal", await snap(page, "04-fill-fail"));
    await browser.close();
    return;
  }
  await page.waitForTimeout(500);
  await snap(page, "04-passkey-filled");

  const submitted = await clickByText(page, /create smart wallet/i, 3_000);
  if (!submitted) {
    report("P2", "fail", "Submit button not clickable", await snap(page, "05-submit-fail"));
  } else {
    await page.waitForTimeout(5_000);
    report("P2", "pass", "Passkey create submitted", await snap(page, "06-passkey-created"));
  }

  await page.waitForTimeout(3_000);

  // ── P3: Dashboard visible? ──────────────────────────────────────
  console.log("\n=== P3: Dashboard ===");
  const dashCheck = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      hasBalance: /total balance/i.test(body),
      hasGreeting: /good (morning|afternoon|evening)/i.test(body),
      hasFaucet: /get test usdc/i.test(body),
      hasUsdtFaucet: /get test usdt/i.test(body),
      hasConnecting: /connecting to fhe/i.test(body),
      hasFheActive: /fhe active/i.test(body),
      hasFheReady: /fhe ready/i.test(body),
      textLen: body.length,
    };
  });
  report("P3", dashCheck.hasBalance ? "pass" : "fail", `Dashboard state: ${JSON.stringify(dashCheck)}`, await snap(page, "07-dashboard"));

  // ── P4: Faucet (the big test) ───────────────────────────────────
  console.log("\n=== P4: Faucet flow ===");
  const faucetClicked = await clickByText(page, /get test usdc/, 3_000);
  if (!faucetClicked) {
    report("P4", "fail", "Faucet button not clickable", await snap(page, "08-faucet-fail"));
  } else {
    await page.waitForTimeout(1_500);
    await snap(page, "09-passphrase-prompt");
    await fillPassphraseModal(page, PASSPHRASE);
    await page.waitForTimeout(200);
    // Submit the Sign faucet form
    const unlocked = await clickByText(page, /^unlock$/i, 3_000);
    if (!unlocked) {
      report("P4", "warn", "Unlock button not clickable — passphrase may not have filled");
    }

    const toast = await waitForToast(page, /minted|error|failed|relayer|crashed|insufficient|cancelled|rejected/i, 90_000);
    if (!toast) {
      report("P4", "warn", "No toast within 90s — faucet may still be pending", await snap(page, "10-faucet-pending"));
    } else if (/minted/i.test(toast)) {
      report("P4", "pass", `Faucet toast: ${toast}`, await snap(page, "10-faucet-success"));
    } else {
      report("P4", "fail", `Faucet error toast: ${toast}`, await snap(page, "10-faucet-error"));
    }
  }

  // ── P5: Navigate all pages, screenshot each ─────────────────────
  console.log("\n=== P5: Page sweep ===");
  const PAGES = [
    { path: "/app", name: "dashboard" },
    { path: "/app/send", name: "send" },
    { path: "/app/history", name: "history" },
    { path: "/app/groups", name: "groups" },
    { path: "/app/creators", name: "creators" },
    { path: "/app/gifts", name: "gifts" },
    { path: "/app/stealth", name: "stealth" },
    { path: "/app/business", name: "business" },
    { path: "/app/inheritance", name: "inheritance" },
    { path: "/app/swap", name: "swap" },
    { path: "/app/proofs", name: "proofs" },
    { path: "/app/agents", name: "agents" },
    { path: "/app/wallet", name: "smart-wallet" },
    { path: "/app/profile", name: "profile" },
    { path: "/app/settings", name: "settings" },
    { path: "/app/help", name: "help" },
  ];
  for (const p of PAGES) {
    try {
      await page.goto(`${BASE}${p.path}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(2_500);
      const state = await page.evaluate(() => ({
        textLen: (document.body.innerText || "").length,
        hasMain: !!document.querySelector("main"),
      }));
      const shot = await snap(page, `page-${p.name}`);
      report(`P5/${p.name}`,
        state.textLen < 100 ? "fail" : state.hasMain ? "pass" : "warn",
        `textLen=${state.textLen} hasMain=${state.hasMain}`,
        shot);
    } catch (err) {
      report(`P5/${p.name}`, "fail", `Navigation failed: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // ── P6: Chain switcher ──────────────────────────────────────────
  console.log("\n=== P6: Chain switcher ===");
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  // Click the chain selector button in sidebar
  const selectorOpened = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const sidebar = btns.find((b) => /eth sepolia|base sepolia/i.test((b.textContent || "").trim()));
    if (sidebar) { (sidebar as HTMLButtonElement).click(); return true; }
    return false;
  });
  if (selectorOpened) {
    await page.waitForTimeout(500);
    await snap(page, "30-chain-selector-open");
    const chainListText = await page.evaluate(() => {
      const listbox = document.querySelector('[role="listbox"]');
      return listbox ? (listbox as HTMLElement).innerText : "";
    });
    const basePresent = /base sepolia/i.test(chainListText);
    const ethPresent = /ethereum sepolia|eth sepolia/i.test(chainListText);
    const hasWarning = /passkey wallet on other chain|passkey.*per.chain/i.test(chainListText);
    report("P6", basePresent && ethPresent ? "pass" : "warn",
      `Chain list: ${chainListText.slice(0, 200).replace(/\n/g, " / ")}${hasWarning ? " [warn-text-present]" : ""}`);
  } else {
    report("P6", "warn", "Could not open chain selector from sidebar");
  }

  // ── Write report ────────────────────────────────────────────────
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ base: BASE, findings, consoleLogs, timestamp: new Date().toISOString() }, null, 2));

  const md: string[] = [];
  md.push(`# Session 7 — Prod visual audit`);
  md.push(`- URL: ${BASE}`);
  md.push(`- Time: ${new Date().toISOString()}`);
  md.push(``);
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  findings.forEach((f) => counts[f.severity]++);
  md.push(`pass=${counts.pass} warn=${counts.warn} fail=${counts.fail} info=${counts.info}`);
  md.push(``);
  for (const f of findings) {
    md.push(`- **[${f.severity.toUpperCase()}] ${f.phase}** ${f.message}${f.shot ? ` \`${f.shot}\`` : ""}`);
  }
  md.push(``);
  md.push(`## Console`);
  md.push(`\`\`\``);
  consoleLogs.slice(0, 40).forEach((l) => md.push(l));
  if (consoleLogs.length > 40) md.push(`... (${consoleLogs.length - 40} more)`);
  md.push(`\`\`\``);
  fs.writeFileSync(path.join(OUT, "report.md"), md.join("\n"));

  await ctx.close();
  await browser.close();

  console.log(`\n[session7] Done. ${OUT}/report.md`);
  console.log(`  pass=${counts.pass} warn=${counts.warn} fail=${counts.fail}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
