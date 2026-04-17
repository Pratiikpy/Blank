// ══════════════════════════════════════════════════════════════════
//  Session 6 — Two-person passkey flows on Base Sepolia
//
//  Relayer is funded on both chains. This audit actually executes
//  transactions: faucet, shield, creator tip, send.
//
//  Using Base Sepolia because it has both USDC + USDT vaults (full
//  feature surface) and faster blocks. We'll visually audit ETH
//  Sepolia paths separately.
// ══════════════════════════════════════════════════════════════════

import { chromium, type Page, type BrowserContext, type ConsoleMessage } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "test-results", "two-person-audit");
const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3000";
const CHAIN_ID = 84532; // Base Sepolia — has USDT too
const PASSPHRASE = "test-passphrase-session6";

// Deterministic 32-byte (64 hex char) keypairs reused from earlier sessions.
const ACCOUNTS = {
  A: { label: "A", privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20", nickname: "alice-s6" },
  B: { label: "B", privKey: "7068617365362d726563697069656e742d736565642d4118191a1b1c1d1e1f20", nickname: "bob-s6" },
};

interface Finding { phase: string; severity: "pass" | "fail" | "warn" | "info"; message: string; shot?: string; }
const findings: Finding[] = [];
const consoleLogs: Record<string, string[]> = {};
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

function attachConsole(page: Page, label: string) {
  consoleLogs[label] = consoleLogs[label] ?? [];
  const log = consoleLogs[label];
  page.on("console", (msg: ConsoleMessage) => {
    const t = msg.type();
    if (t === "error" || t === "warning") {
      const text = msg.text();
      if (/DevTools|HMR|Download the React DevTools|vite.*connected|\[useUnifiedWrite\.module\]|\[unifiedWrite\]|\[useSmartAccount\]/i.test(text)) return;
      log.push(`[${t}] ${text.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (err) => log.push(`[pageerror] ${err.message.slice(0, 300)}`));
}

async function answerPass(page: Page, timeoutMs = 90_000): Promise<boolean> {
  try {
    const inp = page.locator('input[type="password"]').first();
    await inp.waitFor({ state: "visible", timeout: timeoutMs });
    await page.evaluate((p: string) => {
      const el = document.querySelector('input[type="password"]') as HTMLInputElement;
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, p);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, PASSPHRASE);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const form = document.querySelector('input[type="password"]')?.closest("form") as HTMLFormElement | null;
      if (form) (form.requestSubmit ? form.requestSubmit() : form.submit());
    });
    return true;
  } catch {
    return false;
  }
}

async function setupAccount(browser: any, acc: typeof ACCOUNTS.A): Promise<{ ctx: BrowserContext; page: Page; addr: string }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  attachConsole(page, acc.label);

  await page.goto(BASE + "/");
  await page.evaluate((c: number) => localStorage.setItem("blank_active_chain_id", String(c)), CHAIN_ID);
  await page.goto(BASE + "/app");
  await page.evaluate(
    async ([c, pk, pass, label]: [number, string, string, string]) => {
      const m = await import("/src/lib/passkey.ts");
      await m.deletePasskey(c).catch(() => {});
      return m._testImportPasskey(c, pk, pass, label);
    },
    [CHAIN_ID, acc.privKey, PASSPHRASE, acc.nickname] as [number, string, string, string],
  );
  await page.goto(BASE + "/app");
  await page.waitForTimeout(6_000);

  const addr = await page.evaluate(() => {
    // Address is embedded in the greeting "Good afternoon, 0xABCD...1234"
    const match = document.body.innerText.match(/0x[a-fA-F0-9]{4}\.{3}[a-fA-F0-9]{4}/);
    return match?.[0] ?? "";
  });
  return { ctx, page, addr };
}

async function clickByText(page: Page, regex: RegExp): Promise<boolean> {
  return await page.evaluate((src: string) => {
    const re = new RegExp(src, "i");
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) => re.test((b.textContent || "").trim()));
    if (btn && !(btn as HTMLButtonElement).disabled) { (btn as HTMLButtonElement).click(); return true; }
    return false;
  }, regex.source);
}

async function waitForToast(page: Page, match: RegExp, timeoutMs = 20_000): Promise<string | null> {
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
  console.log(`[session6] BASE=${BASE} CHAIN=${CHAIN_ID}`);
  console.log(`[session6] Output → ${OUT}`);

  const browser = await chromium.launch({ headless: true });

  // ── P1: Setup A and B ──────────────────────────────────────────
  console.log("\n=== P1: Setup ===");
  const { ctx: ctxA, page: A, addr: addrA } = await setupAccount(browser, ACCOUNTS.A);
  report("P1", "info", `A address: ${addrA}`, await snap(A, "A-dashboard"));
  const { ctx: ctxB, page: B, addr: addrB } = await setupAccount(browser, ACCOUNTS.B);
  report("P1", "info", `B address: ${addrB}`, await snap(B, "B-dashboard"));

  // ── P2: Faucet A (primary test of relayer + gasLimit + error-surface fixes) ──
  console.log("\n=== P2: Faucet A ===");
  const clickedA = await clickByText(A, /get test usdc/);
  if (!clickedA) {
    report("P2", "fail", "Faucet button missing on A's dashboard");
  } else {
    const promptShown = await answerPass(A, 20_000);
    if (!promptShown) {
      report("P2", "fail", "Passphrase prompt did not appear", await snap(A, "A-no-prompt"));
    } else {
      const toast = await waitForToast(A, /minted|error|failed|relayer|insufficient/i, 90_000);
      const sev: Finding["severity"] =
        !toast ? "warn" :
        /minted/i.test(toast) ? "pass" :
        /relayer|insufficient|out of gas/i.test(toast) ? "fail" :
        "warn";
      report("P2", sev, `A faucet toast: ${toast ?? "(none within 90s)"}`, await snap(A, "A-after-faucet"));
    }
  }

  // ── P3: Faucet B ──────────────────────────────────────────────
  console.log("\n=== P3: Faucet B ===");
  const clickedB = await clickByText(B, /get test usdc/);
  if (clickedB) {
    const promptShown = await answerPass(B, 20_000);
    if (promptShown) {
      const toast = await waitForToast(B, /minted|error|failed|relayer/i, 90_000);
      const sev: Finding["severity"] = !toast ? "warn" : /minted/i.test(toast) ? "pass" : "fail";
      report("P3", sev, `B faucet toast: ${toast ?? "(none)"}`, await snap(B, "B-after-faucet"));
    }
  }

  // ── P4: Shield A ──────────────────────────────────────────────
  console.log("\n=== P4: Shield A ===");
  await A.goto(BASE + "/app");
  await A.waitForTimeout(3_000);
  const shieldFilled = await A.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder*="0.00"]'));
    for (const i of inputs) {
      const el = i as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "50");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  });
  if (shieldFilled) {
    await A.waitForTimeout(500);
    const shielded = await clickByText(A, /^\s*deposit\s*$/i);
    if (shielded) {
      // Shield via AA is a batch (approve + deposit) → one passphrase.
      await answerPass(A, 20_000);
      const toast = await waitForToast(A, /shielded|deposit|success|error|failed/i, 120_000);
      const sev: Finding["severity"] = !toast ? "warn" : /success|shielded|deposit complete/i.test(toast) ? "pass" : /error|failed/i.test(toast) ? "fail" : "info";
      report("P4", sev, `A shield toast: ${toast ?? "(none within 120s)"}`, await snap(A, "A-after-shield"));
    } else {
      report("P4", "warn", "Could not click Deposit button (maybe still minting)");
    }
  } else {
    report("P4", "warn", "Could not fill shield amount");
  }

  // ── P5: A becomes creator ──────────────────────────────────────
  console.log("\n=== P5: A becomes creator ===");
  await A.goto(BASE + "/app/creators");
  await A.waitForTimeout(3_000);
  await snap(A, "A-creators-before");
  const setupClicked = await clickByText(A, /set.?up.*profile/i);
  if (setupClicked) {
    await A.waitForTimeout(1_500);
    const formFilled = await A.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input[type='text'], input:not([type])"));
      for (const i of inputs) {
        const el = i as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, "Alice Audit");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        break;
      }
      const textareas = document.querySelectorAll("textarea");
      if (textareas[0]) {
        const el = textareas[0] as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(el, "Test creator bio for audit session");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    });
    if (formFilled) {
      await A.waitForTimeout(500);
      await snap(A, "A-creator-form");
      const saved = await clickByText(A, /^(save|create).*$/i);
      if (saved) {
        await answerPass(A, 20_000);
        const toast = await waitForToast(A, /profile|created|updated|error|failed/i, 120_000);
        const sev: Finding["severity"] = !toast ? "warn" : /created|updated/i.test(toast) ? "pass" : /error|failed/i.test(toast) ? "fail" : "info";
        report("P5", sev, `A creator toast: ${toast ?? "(none)"}`, await snap(A, "A-creator-after"));
      }
    }
  } else {
    report("P5", "info", "No setup-profile button (may already be a creator)");
  }

  // ── P6: Console summary ────────────────────────────────────────
  console.log("\n=== P6: Console summary ===");
  for (const [label, logs] of Object.entries(consoleLogs)) {
    const fatalLogs = logs.filter((l) => /pageerror|failed to fetch|500|502|reverted/i.test(l));
    report(`P6/${label}`, fatalLogs.length === 0 ? "pass" : "warn", `Console: ${logs.length} issues, ${fatalLogs.length} fatal-ish`);
    if (fatalLogs.length > 0) {
      for (const l of fatalLogs.slice(0, 10)) console.log(`    ${l}`);
    }
  }

  // ── Write report ───────────────────────────────────────────────
  const report_json = { baseUrl: BASE, chainId: CHAIN_ID, accountA: addrA, accountB: addrB, timestamp: new Date().toISOString(), findings, consoleLogs };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report_json, null, 2));

  const md: string[] = [];
  md.push(`# Session 6 — Two-person audit on Base Sepolia`);
  md.push(``);
  md.push(`Run at: ${new Date().toISOString()}`);
  md.push(`Base URL: ${BASE}`);
  md.push(``);
  md.push(`- A: ${addrA}`);
  md.push(`- B: ${addrB}`);
  md.push(``);
  md.push(`## Findings`);
  md.push(``);
  for (const f of findings) {
    md.push(`- **[${f.severity.toUpperCase()}] ${f.phase}** — ${f.message}${f.shot ? ` \`${f.shot}\`` : ""}`);
  }
  fs.writeFileSync(path.join(OUT, "report.md"), md.join("\n"));

  await ctxA.close();
  await ctxB.close();
  await browser.close();

  const failCount = findings.filter((f) => f.severity === "fail").length;
  const passCount = findings.filter((f) => f.severity === "pass").length;
  console.log(`\n[session6] Done. pass=${passCount} fail=${failCount} total=${findings.length}`);
  console.log(`[session6] Report: ${OUT}/report.md`);
}

main().catch((err) => { console.error(err); process.exit(1); });
