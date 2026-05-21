/**
 * QA visual sweep against live Vercel preview with Rabby.
 *
 *   pnpm exec tsx packages/app/e2e/wave4/scripts/qa-live-sweep.ts
 *
 * What this does:
 *   1. Launch Chromium with Rabby + persistent profile (.rabby-profile-blank)
 *      that has Dave's seed + Base Sepolia chain + testnet visibility
 *      already configured.
 *   2. Open https://www.myblank.app/app, walk the carousel,
 *      click Connect Rabby Wallet, drive Rabby Connect popup + SIWE
 *      (using the same primitives Phase 9 uses).
 *   3. Visit EVERY desktop app route and snapshot it. Catches "this
 *      screen looks broken under Rabby" issues no automated test catches.
 *   4. Print a per-route status report to console.
 *
 * Routes covered (Base Sepolia, desktop, Dave's EOA-connected state):
 *   /app                - Dashboard
 *   /app/wallet         - Wallet / Deposit / Faucet
 *   /app/send           - Send & Receive
 *   /app/receive        - Receive
 *   /app/history        - Transaction history
 *   /app/business       - Business Tools (invoices, payroll)
 *   /app/groups         - Group Expenses
 *   /app/creators       - Creator Support
 *   /app/p2p            - P2P Exchange
 *   /app/stealth        - Stealth Payments
 *   /app/inheritance    - Inheritance
 *   /app/proofs         - Encrypted Proofs
 *   /app/gifts          - Gift Envelopes
 *   /app/sell           - Storefront create
 *   /app/fundraise      - Crowdfund create
 *   /app/requests       - Payment Requests
 *   /app/contacts       - Contacts
 *   /app/analytics      - Analytics
 *   /app/agent          - Agent Payments
 *   /app/explore        - Explore (public deep links)
 */
import { chromium, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import {
  unlockRabby,
  dismissRabbyWhatsNew,
  waitAndConfirmRabbyPopup,
} from "../../fixtures/rabby/rabby-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://www.myblank.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const OUT = resolve(REPO, "packages/app/test-results/qa-live-sweep");

// Full list copied from BlankApp.tsx <Route path=...> entries.
const ROUTES: Array<{ path: string; label: string }> = [
  { path: "/app", label: "01-dashboard" },
  { path: "/app/wallet", label: "02-wallet" },
  { path: "/app/send", label: "03-send" },
  { path: "/app/receive", label: "04-receive" },
  { path: "/app/history", label: "05-history" },
  { path: "/app/business", label: "06-business-tools" },
  { path: "/app/groups", label: "07-groups" },
  { path: "/app/creators", label: "08-creator-support" },
  { path: "/app/stealth", label: "09-stealth" },
  { path: "/app/stealth/inbox", label: "10-stealth-inbox" },
  { path: "/app/stealth/setup", label: "11-stealth-meta-setup" },
  { path: "/app/inheritance", label: "12-inheritance" },
  { path: "/app/proofs", label: "13-encrypted-proofs" },
  { path: "/app/gifts", label: "14-gifts" },
  { path: "/app/sell", label: "15-storefront-create" },
  { path: "/app/fundraise", label: "16-crowdfund-create" },
  { path: "/app/requests", label: "17-payment-requests" },
  { path: "/app/contacts", label: "18-contacts" },
  { path: "/app/analytics", label: "19-analytics" },
  { path: "/app/agents", label: "20-agent-payments" },
  { path: "/app/explore", label: "21-explore" },
  { path: "/app/profile", label: "22-profile" },
  { path: "/app/burners", label: "23-burners" },
  { path: "/app/scheduled", label: "24-scheduled" },
  { path: "/app/claim-link", label: "25-claim-link-create" },
  { path: "/app/swap", label: "26-swap" },
  { path: "/app/bridge", label: "27-bridge" },
  { path: "/app/privacy", label: "28-privacy" },
  { path: "/app/settings", label: "29-settings" },
  { path: "/app/help", label: "30-help" },
];

interface Report {
  route: string;
  label: string;
  status: "ok" | "blank" | "error" | "crash" | "404";
  notes: string;
  screenshotPath: string;
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR)) {
    console.error(`FATAL: Rabby ext missing at ${RABBY_EXT_DIR}`);
    process.exit(1);
  }
  if (!existsSync(RABBY_PROFILE_DIR)) {
    console.error(`FATAL: Rabby profile missing at ${RABBY_PROFILE_DIR}`);
    process.exit(2);
  }

  mkdirSync(OUT, { recursive: true });
  console.log(`QA live sweep — ${VERCEL_URL}`);
  console.log(`Output: ${OUT}`);

  const ctx = await chromium.launchPersistentContext(RABBY_PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${RABBY_EXT_DIR}`,
      `--load-extension=${RABBY_EXT_DIR}`,
      "--no-sandbox",
    ],
  });

  // Wait for Rabby SW to register.
  let extId = "";
  for (let i = 0; i < 30; i++) {
    const sw = ctx.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (sw) {
      extId = sw.url().split("/")[2];
      break;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!extId) {
    console.error("FATAL: Rabby SW didn't register");
    await ctx.close();
    process.exit(3);
  }

  // Open Rabby home tab, unlock, dismiss "What's new".
  const home = await ctx.newPage();
  await home.goto(`chrome-extension://${extId}/index.html`).catch(() => {});
  await home.waitForTimeout(2_000);
  await unlockRabby(home, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(home);

  // Open the live Vercel dApp + walk through Connect.
  const dapp = await ctx.newPage();
  await dapp.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.waitForTimeout(3_000);

  const knownPages = new Set<Page>(ctx.pages());

  // Walk carousel — click Next until WalletChoiceCard appears.
  for (let i = 0; i < 6; i++) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_500 }).catch(() => false)) break;
    const next = dapp.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 2_000 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => {});
    await dapp.waitForTimeout(1_200);
  }

  // Check if dApp already auto-connected (dashboard text visible).
  const dashboardLanded = await dapp
    .locator("text=/Good afternoon|Total Balance|FHE Protected/i")
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  if (!dashboardLanded) {
    // Click Connect Rabby Wallet.
    const existingCard = dapp.locator('[data-testid="wallet-choice-existing"]');
    await existingCard.waitFor({ state: "visible", timeout: 15_000 });
    const connect = existingCard.locator("button").filter({ hasText: /Rabby/i }).first();
    await connect.click({ force: true });

    // Drive Rabby Connect + SIWE popups.
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-connect", 30_000, {
      chainName: "Base Sepolia",
    });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-siwe", 20_000);
  }

  await dapp.waitForTimeout(3_000);
  console.log("\n✓ Rabby connected — starting route sweep\n");

  // Walk every route + snap.
  const reports: Report[] = [];
  for (const { path, label } of ROUTES) {
    const url = `${VERCEL_URL}${path}`;
    let status: Report["status"] = "ok";
    let notes = "";
    let screenshotPath = "";
    try {
      await dapp.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await dapp.waitForTimeout(3_500);
      // Detect 404 page first — BlankApp routes unknown paths to
      // NotFoundPage which shows "404 Page not found".
      const notFound = await dapp
        .locator("text=/^\\s*404\\s*$|Page not found/i")
        .first()
        .isVisible({ timeout: 1_500 })
        .catch(() => false);
      if (notFound) {
        status = "404";
        notes = "NotFoundPage rendered — route does not exist";
      } else {
        // Detect blank-screen (no visible <h1>, <h2>, or main text).
        const hasHeader = await dapp
          .locator("h1, h2, h3, [role='heading']")
          .first()
          .isVisible({ timeout: 3_000 })
          .catch(() => false);
        // Detect error overlay.
        const errorText = await dapp
          .locator("text=/Something went wrong|Failed to load|Crash/i")
          .first()
          .isVisible({ timeout: 1_500 })
          .catch(() => false);
        if (errorText) {
          status = "error";
          notes = "error-overlay visible";
        } else if (!hasHeader) {
          status = "blank";
          notes = "no header/heading rendered";
        }
      }
      screenshotPath = resolve(OUT, `${label}.png`);
      await dapp.screenshot({ path: screenshotPath, fullPage: true });
    } catch (e) {
      status = "crash";
      notes = (e as Error).message.slice(0, 200);
      screenshotPath = resolve(OUT, `${label}-CRASH.png`);
      await dapp.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    }
    const r: Report = { route: path, label, status, notes, screenshotPath };
    reports.push(r);
    console.log(`[${status.padEnd(5)}] ${path.padEnd(20)} ${notes}`);
  }

  // Write report markdown.
  const md = [
    `# QA live-vercel sweep`,
    `Generated: ${new Date().toISOString()}`,
    `URL base: ${VERCEL_URL}`,
    `Wallet: Dave (Rabby EOA, ${RABBY_PROFILE_DIR})`,
    `Chain: Base Sepolia (selected in Rabby)`,
    ``,
    `## Per-route status`,
    ``,
    `| Route | Status | Notes | Screenshot |`,
    `|---|---|---|---|`,
    ...reports.map((r) => `| \`${r.route}\` | ${r.status} | ${r.notes || "—"} | \`${r.screenshotPath.split(/[\\/]/).slice(-2).join("/")}\` |`),
    ``,
    `## Summary`,
    `- ok: ${reports.filter((r) => r.status === "ok").length}`,
    `- 404: ${reports.filter((r) => r.status === "404").length}`,
    `- blank: ${reports.filter((r) => r.status === "blank").length}`,
    `- error: ${reports.filter((r) => r.status === "error").length}`,
    `- crash: ${reports.filter((r) => r.status === "crash").length}`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(`\n✓ Report: ${resolve(OUT, "REPORT.md")}`);

  await ctx.close();
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(99);
});
