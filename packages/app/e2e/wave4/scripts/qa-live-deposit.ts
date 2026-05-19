/**
 * QA: drive Deposit / Shield flow on live Vercel with Rabby.
 *
 *   pnpm exec tsx packages/app/e2e/wave4/scripts/qa-live-deposit.ts
 *
 * Connects Rabby (reusing Phase 9 primitives), navigates to /app
 * dashboard, finds the "DEPOSIT TO PRIVATE WALLET" panel, enters an
 * amount, clicks Deposit, drives Rabby approve + shield popups,
 * captures both tx hashes.
 *
 * This is the foundational flow for nearly every other feature —
 * encrypted Send, Stealth Send, Gifts, Inheritance, Proofs all need
 * shielded balance to operate. If this works for Dave's Rabby EOA on
 * live Vercel, the dApp's encryption pipeline + Rabby integration
 * are end-to-end healthy.
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

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://blank-omega-jade.vercel.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const OUT = resolve(REPO, "packages/app/test-results/qa-live-deposit");

const AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1";

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
  console.log(`QA Deposit → Shield · ${VERCEL_URL} · amount=${AMOUNT} USDC`);
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

  const home = await ctx.newPage();
  await home.goto(`chrome-extension://${extId}/index.html`).catch(() => {});
  await home.waitForTimeout(2_000);
  await unlockRabby(home, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(home);

  const dapp = await ctx.newPage();
  await dapp.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.waitForTimeout(3_000);
  await dapp.screenshot({ path: resolve(OUT, "01-app-loaded.png"), fullPage: true });

  const knownPages = new Set<Page>(ctx.pages());

  // Walk onboarding carousel (idempotent — breaks early if already past).
  for (let i = 0; i < 6; i++) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_500 }).catch(() => false)) break;
    const next = dapp.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 2_000 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => {});
    await dapp.waitForTimeout(1_200);
  }

  // Connect via WalletChoiceCard if dashboard isn't already mounted.
  const dashboardLanded = await dapp
    .locator("text=/Good afternoon|Total Balance|FHE Protected/i")
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  if (!dashboardLanded) {
    const existingCard = dapp.locator('[data-testid="wallet-choice-existing"]');
    await existingCard.waitFor({ state: "visible", timeout: 15_000 });
    const connect = existingCard.locator("button").filter({ hasText: /Rabby/i }).first();
    await connect.click({ force: true });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-connect", 30_000, {
      chainName: "Base Sepolia",
    });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-siwe", 20_000);
  }
  await dapp.waitForTimeout(3_000);
  await dapp.screenshot({ path: resolve(OUT, "02-dashboard.png"), fullPage: true });
  console.log("✓ Rabby connected, dashboard visible");

  // Find the Deposit panel. The dashboard renders a "DEPOSIT TO PRIVATE
  // WALLET" section with an amount input + "Get Test USDC" + "Deposit"
  // buttons. The amount input has the same placeholder pattern used
  // throughout the app: "0.00". The Deposit button text is "Deposit".
  console.log("→ Locating Deposit panel...");

  // Scope to the deposit section so we don't accidentally hit other
  // numeric inputs (e.g. Withdraw panel).
  const depositSection = dapp
    .locator("section, div")
    .filter({ hasText: /Deposit to private wallet/i })
    .first();

  if (!(await depositSection.isVisible({ timeout: 5_000 }).catch(() => false))) {
    console.error("✘ Deposit panel not visible — dashboard layout may have changed");
    await dapp.screenshot({ path: resolve(OUT, "03-no-deposit-panel.png"), fullPage: true });
    await ctx.close();
    process.exit(10);
  }

  // Capture state before action.
  await dapp.screenshot({ path: resolve(OUT, "03-pre-deposit.png"), fullPage: true });

  // Fill the deposit amount. Use a section-scoped query.
  const amountInput = depositSection.locator('input[placeholder="0.00"]').first();
  await amountInput.waitFor({ state: "visible", timeout: 10_000 });
  await amountInput.fill(AMOUNT);
  console.log(`✓ Entered ${AMOUNT} USDC in Deposit input`);
  await dapp.screenshot({ path: resolve(OUT, "04-amount-filled.png"), fullPage: true });

  // Click Deposit button.
  const depositBtn = depositSection.locator("button").filter({ hasText: /^Deposit/i }).first();
  await depositBtn.waitFor({ state: "visible", timeout: 5_000 });
  const isEnabled = await depositBtn.isEnabled().catch(() => false);
  if (!isEnabled) {
    console.error("✘ Deposit button is disabled — Dave may not have plaintext USDC balance");
    await dapp.screenshot({ path: resolve(OUT, "05-deposit-disabled.png"), fullPage: true });
    await ctx.close();
    process.exit(11);
  }
  await depositBtn.click();
  console.log("✓ Deposit button clicked");
  await dapp.waitForTimeout(2_000);
  await dapp.screenshot({ path: resolve(OUT, "05-post-deposit-click.png"), fullPage: true });

  // Drive Rabby popups in sequence. First popup is usually approve()
  // for the TestUSDC → vault allowance. Second is the shield()
  // call itself. Some flows bundle both in one popup; handle both.
  console.log("→ Driving Rabby popup #1 (approve or shield)...");
  const popup1 = await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-deposit-1", 60_000);
  console.log(`  popup1: ${popup1.clicks} click(s), closed=${popup1.closed}`);

  // Sometimes a second popup fires for the actual shield after approve.
  console.log("→ Driving Rabby popup #2 (shield, if approve was separate)...");
  const popup2 = await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-deposit-2", 30_000);
  console.log(`  popup2: ${popup2.clicks} click(s), closed=${popup2.closed}`);

  // Wait for success state — either an explorer link surfaces, the
  // dashboard balance updates, or the panel resets.
  console.log("→ Waiting for shield success state...");
  let txHash = "";
  for (let i = 0; i < 24; i++) {
    const href = await dapp
      .locator('a[href*="/tx/0x"]')
      .first()
      .getAttribute("href", { timeout: 5_000 })
      .catch(() => null);
    if (href) {
      const m = href.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
      if (m) {
        txHash = m[1];
        console.log(`✓ Tx hash captured: ${txHash}`);
        break;
      }
    }
    await dapp.waitForTimeout(5_000);
  }

  await dapp.screenshot({ path: resolve(OUT, "06-final-state.png"), fullPage: true });

  // Write report.
  const md = [
    `# QA Deposit → Shield (live Vercel)`,
    `Generated: ${new Date().toISOString()}`,
    `URL base: ${VERCEL_URL}`,
    `Wallet: Dave (Rabby EOA)`,
    `Chain: Base Sepolia`,
    `Amount: ${AMOUNT} USDC`,
    ``,
    `## Result`,
    ``,
    txHash
      ? `🟢 GREEN — Tx hash: [\`${txHash}\`](https://sepolia.basescan.org/tx/${txHash})`
      : `🔴 RED — No tx hash captured within budget`,
    ``,
    `## Rabby popups`,
    ``,
    `- Popup 1 (approve/shield): ${popup1.clicks} clicks, closed=${popup1.closed}`,
    `- Popup 2 (shield, if separate): ${popup2.clicks} clicks, closed=${popup2.closed}`,
    ``,
    `## Screenshots`,
    ``,
    `- \`01-app-loaded.png\` — initial /app load`,
    `- \`02-dashboard.png\` — post-connect dashboard`,
    `- \`03-pre-deposit.png\` — dashboard with Deposit panel`,
    `- \`04-amount-filled.png\` — Deposit input filled with ${AMOUNT}`,
    `- \`05-post-deposit-click.png\` — after Deposit button click`,
    `- \`06-final-state.png\` — final dApp state`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(`\n✓ Report: ${resolve(OUT, "REPORT.md")}`);

  await ctx.close();
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(99);
});
