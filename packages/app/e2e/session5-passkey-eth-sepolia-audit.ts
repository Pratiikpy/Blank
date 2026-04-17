// ══════════════════════════════════════════════════════════════════
//  Session 5 — Passkey + ETH Sepolia Full Visual Audit
//
//  Runs against LOCAL DEV (http://localhost:3000) which hits the same
//  testnet contracts as prod. Uses ETH Sepolia (11155111) because the
//  user reports the bugs show up there with passkey-only auth.
//
//  Two passkey accounts, every feature page, two-person flows.
//  Output: test-results/passkey-eth-audit/
// ══════════════════════════════════════════════════════════════════

import { chromium, type Page, type BrowserContext, type ConsoleMessage } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "test-results", "passkey-eth-audit");
const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3000";
const CHAIN_ID = 11155111; // Ethereum Sepolia
const PASSPHRASE = "test-passphrase-audit-5";

// Deterministic keypairs seeded for reproducibility. These are TEST accounts.
const ACCOUNTS = {
  A: {
    label: "A",
    privKey: "2a95614c7c07a7b9a85b93f62f5c22d59d1b64b68f2f4cf7c4e1a67b0e8f3421",
    nickname: "alice-audit-5",
  },
  B: {
    label: "B",
    privKey: "f38c22e0df9caf74f35c8f4a7adbf5ec0d6f6d2f11e2c5e3b7b05f0c12e4afdd",
    nickname: "bob-audit-5",
  },
};

interface AuditFinding {
  phase: string;
  page: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  message: string;
  screenshot?: string;
}

const findings: AuditFinding[] = [];
const consoleLogs: Record<string, string[]> = {};
let step = 0;

fs.mkdirSync(OUT, { recursive: true });

function shot(phase: string, page: string, severity: AuditFinding["severity"], message: string, file?: string) {
  findings.push({ phase, page, severity, message, screenshot: file });
  const icon = { critical: "X", high: "!", medium: "~", low: "-", info: "i" }[severity];
  console.log(`  [${icon}] ${phase}/${page} — ${message}${file ? ` (${file})` : ""}`);
}

async function snap(p: Page, label: string): Promise<string> {
  step++;
  const fname = `${String(step).padStart(3, "0")}-${label}.png`;
  await p.screenshot({ path: path.join(OUT, fname), fullPage: true }).catch(() => {});
  return fname;
}

function attachConsole(page: Page, label: string) {
  consoleLogs[label] = consoleLogs[label] ?? [];
  const log = consoleLogs[label];
  page.on("console", (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      const text = msg.text();
      // Filter known noise.
      if (/DevTools|HMR|Download the React DevTools|vite.*connected/i.test(text)) return;
      log.push(`[${type}] ${text.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (err) => log.push(`[pageerror] ${err.message.slice(0, 300)}`));
  page.on("requestfailed", (req) => {
    const url = req.url();
    // Only flag real failures, not dev-server internals.
    if (!/localhost:3000/i.test(url) || /\/@|\.map/.test(url)) return;
    log.push(`[requestfailed] ${req.method()} ${url.slice(0, 200)} — ${req.failure()?.errorText ?? "?"}`);
  });
}

async function setupAccount(browser: any, acc: typeof ACCOUNTS.A): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  attachConsole(page, acc.label);

  await page.goto(BASE + "/");
  await page.evaluate((chainId: number) => {
    localStorage.setItem("blank_active_chain_id", String(chainId));
  }, CHAIN_ID);

  await page.goto(BASE + "/app");
  // Import the passkey bytes directly via the dev-mode source import.
  await page.evaluate(
    async ([chainId, privKey, pass, label]: [number, string, string, string]) => {
      const pk = await import("/src/lib/passkey.ts");
      await pk.deletePasskey(chainId).catch(() => {});
      return pk._testImportPasskey(chainId, privKey, pass, label);
    },
    [CHAIN_ID, acc.privKey, PASSPHRASE, acc.nickname] as [number, string, string, string],
  );

  await page.goto(BASE + "/app");
  await page.waitForTimeout(6_000);
  return { ctx, page };
}

// Dismiss the passphrase prompt by typing + submitting. Used for every
// on-chain write the passkey path triggers.
async function answerPassphrase(page: Page, timeoutMs = 60_000): Promise<boolean> {
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

// ─── Per-page visual audit ──────────────────────────────────────────

interface PageTarget {
  path: string;
  name: string;
  selectorsToProbe?: string[];
}

const PAGES: PageTarget[] = [
  { path: "/app", name: "dashboard" },
  { path: "/app/send", name: "send-contacts" },
  { path: "/app/receive", name: "receive" },
  { path: "/app/history", name: "history" },
  { path: "/app/explore", name: "explore" },
  { path: "/app/profile", name: "profile" },
  { path: "/app/groups", name: "groups" },
  { path: "/app/stealth", name: "stealth" },
  { path: "/app/gifts", name: "gifts" },
  { path: "/app/swap", name: "p2p-exchange" },
  { path: "/app/business", name: "business" },
  { path: "/app/creators", name: "creators" },
  { path: "/app/inheritance", name: "inheritance" },
  { path: "/app/requests", name: "requests" },
  { path: "/app/contacts", name: "contacts" },
  { path: "/app/privacy", name: "privacy" },
  { path: "/app/proofs", name: "proofs" },
  { path: "/app/agents", name: "ai-agents" },
  { path: "/app/wallet", name: "smart-wallet" },
  { path: "/app/settings", name: "settings" },
  { path: "/app/help", name: "help" },
];

async function auditPage(page: Page, target: PageTarget, phase: string): Promise<void> {
  try {
    await page.goto(BASE + target.path, { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (err) {
    const file = await snap(page, `${target.name}-load-fail`);
    shot(phase, target.name, "critical", `page.goto failed: ${(err as Error).message}`, file);
    return;
  }
  await page.waitForTimeout(2_500);

  // Detect blank white-screen render: if body has <100 chars of text and no
  // key semantic elements, something went wrong.
  const state = await page.evaluate(() => {
    const body = document.body;
    const hasMain = !!document.querySelector("main");
    const textLen = (body.innerText || "").trim().length;
    const hasNav = !!document.querySelector("nav, [role='navigation']");
    const hasError = /error|failed|something went wrong/i.test(body.innerText || "");
    return { textLen, hasMain, hasNav, hasError };
  }).catch(() => null);

  const file = await snap(page, target.name);

  if (!state) {
    shot(phase, target.name, "critical", "Could not read page state", file);
    return;
  }
  if (state.textLen < 50) {
    shot(phase, target.name, "critical", `White/blank render (textLen=${state.textLen}, hasMain=${state.hasMain})`, file);
    return;
  }
  if (!state.hasMain) {
    shot(phase, target.name, "high", "No <main> element — layout may be broken", file);
  }
  if (state.hasError) {
    shot(phase, target.name, "high", "Page text contains 'error' keyword — likely error state rendered", file);
  }
  shot(phase, target.name, "info", `Rendered (textLen=${state.textLen})`, file);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(`[audit] Starting — BASE=${BASE} CHAIN=${CHAIN_ID}`);
  console.log(`[audit] Output → ${OUT}`);

  const browser = await chromium.launch({ headless: true });

  // Phase 1: Setup both passkey accounts
  console.log("\n=== Phase 1: Setup passkeys ===");
  const { ctx: ctxA, page: A } = await setupAccount(browser, ACCOUNTS.A);
  shot("P1", "setup-A", "info", "Account A passkey imported");
  const { ctx: ctxB, page: B } = await setupAccount(browser, ACCOUNTS.B);
  shot("P1", "setup-B", "info", "Account B passkey imported");

  const addrA = await A.evaluate(() => {
    const el = document.querySelector("[data-testid='effective-address']") as HTMLElement | null;
    return el?.textContent?.trim() ?? "";
  });
  const addrB = await B.evaluate(() => {
    const el = document.querySelector("[data-testid='effective-address']") as HTMLElement | null;
    return el?.textContent?.trim() ?? "";
  });
  console.log(`  account A: ${addrA}`);
  console.log(`  account B: ${addrB}`);

  // Phase 2: A — visit every sidebar page, screenshot + capture console errors
  console.log("\n=== Phase 2: A — full page visual sweep ===");
  for (const target of PAGES) {
    await auditPage(A, target, "P2-A");
  }

  // Phase 3: A — faucet flow (the primary reported bug)
  console.log("\n=== Phase 3: A — faucet flow (USDC) ===");
  await A.goto(BASE + "/app");
  await A.waitForTimeout(3_000);
  await snap(A, "faucet-before");

  // Find and click the "Get Test USDC" button
  const clicked = await A.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) => /get test usdc/i.test((b.textContent || "").trim()));
    if (btn && !(btn as HTMLButtonElement).disabled) {
      (btn as HTMLButtonElement).click();
      return true;
    }
    return false;
  });
  if (!clicked) {
    shot("P3", "faucet", "high", "Couldn't find 'Get Test USDC' button on dashboard");
  } else {
    console.log("  clicked Get Test USDC, waiting for passphrase prompt...");
    await A.waitForTimeout(1_500);
    await snap(A, "faucet-prompt");
    const ok = await answerPassphrase(A, 20_000);
    if (!ok) {
      shot("P3", "faucet", "critical", "Passphrase prompt never appeared after clicking faucet", await snap(A, "faucet-no-prompt"));
    } else {
      console.log("  submitted passphrase, waiting for tx...");
      await A.waitForTimeout(30_000);
      const after = await snap(A, "faucet-after");
      const toastText = await A.evaluate(() => {
        const toasts = Array.from(document.querySelectorAll("[data-sonner-toast], [role='status'], .Toastify__toast, [class*='toast']"));
        return toasts.map((t) => (t as HTMLElement).innerText).join(" | ").slice(0, 500);
      });
      shot("P3", "faucet", toastText.includes("minted") ? "info" : "high", `After-faucet toasts: ${toastText || "(none)"}`, after);
    }
  }

  // Phase 4: A — shield flow
  console.log("\n=== Phase 4: A — shield flow ===");
  await A.waitForTimeout(2_000);
  const shieldClicked = await A.evaluate(() => {
    const input = document.querySelector('input[placeholder="0.00"]') as HTMLInputElement | null;
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "10");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) => /^shield$/i.test((b.textContent || "").trim()));
    if (btn && !(btn as HTMLButtonElement).disabled) {
      (btn as HTMLButtonElement).click();
      return true;
    }
    return false;
  });
  if (!shieldClicked) {
    shot("P4", "shield", "medium", "Shield button not clickable (may need USDC first)");
  } else {
    await A.waitForTimeout(2_000);
    // Shield typically needs TWO passphrase prompts (approve + deposit) in EOA
    // mode, or ONE in AA mode (executeBatch). Try both.
    for (let i = 0; i < 3; i++) {
      const ok = await answerPassphrase(A, 15_000);
      if (!ok) break;
      console.log(`  shield passphrase ${i + 1}`);
      await A.waitForTimeout(8_000);
    }
    await A.waitForTimeout(15_000);
    await snap(A, "shield-after");
  }

  // Phase 5: B — faucet + shield (same flow)
  console.log("\n=== Phase 5: B — faucet + shield ===");
  await B.goto(BASE + "/app");
  await B.waitForTimeout(3_000);
  const clickedB = await B.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) => /get test usdc/i.test((b.textContent || "").trim()));
    if (btn && !(btn as HTMLButtonElement).disabled) {
      (btn as HTMLButtonElement).click();
      return true;
    }
    return false;
  });
  if (clickedB) {
    await B.waitForTimeout(1_500);
    await answerPassphrase(B, 20_000);
    await B.waitForTimeout(30_000);
    await snap(B, "B-faucet-after");
  } else {
    shot("P5", "faucet-B", "medium", "Couldn't click faucet for B");
  }

  // Phase 6: A becomes a creator
  console.log("\n=== Phase 6: A becomes creator ===");
  await A.goto(BASE + "/app/creators");
  await A.waitForTimeout(3_000);
  await snap(A, "creators-before");
  const becameCreator = await A.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) =>
      /become a creator|create.*profile|setup.*profile/i.test((b.textContent || "").trim()),
    );
    if (btn && !(btn as HTMLButtonElement).disabled) {
      (btn as HTMLButtonElement).click();
      return true;
    }
    return false;
  });
  if (becameCreator) {
    await A.waitForTimeout(1_500);
    const nameInput = await A.locator("input[type='text'], input:not([type])").first();
    if (await nameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await nameInput.fill("Alice Audit Creator");
      await A.waitForTimeout(300);
      const textareas = A.locator("textarea");
      if (await textareas.count() > 0) {
        await textareas.first().fill("Audit-session creator profile");
      }
      await A.waitForTimeout(300);
      await snap(A, "creator-form-filled");
      await A.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find((b) => /^(save|create)/i.test((b.textContent || "").trim()));
        if (btn && !(btn as HTMLButtonElement).disabled) (btn as HTMLButtonElement).click();
      });
      await A.waitForTimeout(2_000);
      await answerPassphrase(A, 20_000);
      await A.waitForTimeout(25_000);
      await snap(A, "creator-created");
    } else {
      shot("P6", "become-creator", "high", "Creator form didn't open after button click");
    }
  } else {
    shot("P6", "become-creator", "info", "No 'Become a Creator' button (may already be one or feature missing)");
  }

  // Phase 7: Report console errors collected across all pages/phases
  console.log("\n=== Phase 7: Console error summary ===");
  for (const [label, logs] of Object.entries(consoleLogs)) {
    if (logs.length === 0) {
      console.log(`  ${label}: clean`);
      continue;
    }
    console.log(`  ${label}: ${logs.length} issues`);
    for (const l of logs.slice(0, 30)) {
      console.log(`    ${l}`);
    }
    if (logs.length > 30) console.log(`    ... (${logs.length - 30} more)`);
    shot("P7", `console-${label}`, logs.length > 20 ? "high" : "medium", `${logs.length} console errors/warnings`);
  }

  // Phase 8: Write findings report
  console.log(`\n=== Phase 8: Writing report ===`);
  const report = {
    baseUrl: BASE,
    chainId: CHAIN_ID,
    timestamp: new Date().toISOString(),
    accountA: addrA,
    accountB: addrB,
    findings,
    consoleLogs,
  };
  const reportPath = path.join(OUT, "audit-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  report: ${reportPath}`);

  // Also write human-readable markdown summary
  const md: string[] = [];
  md.push(`# Passkey + ETH Sepolia Audit — ${new Date().toISOString()}`);
  md.push(``);
  md.push(`- Base URL: \`${BASE}\``);
  md.push(`- Chain: \`${CHAIN_ID}\` (Ethereum Sepolia)`);
  md.push(`- Account A: \`${addrA}\``);
  md.push(`- Account B: \`${addrB}\``);
  md.push(`- Total findings: ${findings.length}`);
  md.push(``);
  const bySeverity = { critical: [], high: [], medium: [], low: [], info: [] } as Record<string, AuditFinding[]>;
  findings.forEach((f) => bySeverity[f.severity].push(f));
  for (const sev of ["critical", "high", "medium", "low", "info"] as const) {
    if (bySeverity[sev].length === 0) continue;
    md.push(`## ${sev.toUpperCase()} (${bySeverity[sev].length})`);
    md.push(``);
    for (const f of bySeverity[sev]) {
      md.push(`- **${f.phase}/${f.page}** — ${f.message}${f.screenshot ? ` [\`${f.screenshot}\`]` : ""}`);
    }
    md.push(``);
  }
  md.push(`## Console errors by account`);
  md.push(``);
  for (const [label, logs] of Object.entries(consoleLogs)) {
    md.push(`### ${label}`);
    md.push(``);
    if (logs.length === 0) {
      md.push(`*clean*`);
      md.push(``);
      continue;
    }
    md.push("```");
    logs.slice(0, 50).forEach((l) => md.push(l));
    if (logs.length > 50) md.push(`... (${logs.length - 50} more)`);
    md.push("```");
    md.push(``);
  }
  fs.writeFileSync(path.join(OUT, "audit-report.md"), md.join("\n"));
  console.log(`  markdown: ${path.join(OUT, "audit-report.md")}`);

  await ctxA.close();
  await ctxB.close();
  await browser.close();

  console.log(`\n[audit] Done. ${findings.length} findings. See ${OUT}/audit-report.md`);
}

main().catch((err) => {
  console.error("[audit] fatal:", err);
  process.exit(1);
});
