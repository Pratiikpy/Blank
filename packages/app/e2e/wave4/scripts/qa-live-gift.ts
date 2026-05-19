/**
 * QA: drive Gift Envelope creation on live Vercel with Rabby.
 *
 *   pnpm exec tsx packages/app/e2e/wave4/scripts/qa-live-gift.ts
 *
 * Dave creates an encrypted gift envelope from his shielded balance.
 * Verifies the create flow surfaces a shareable URL + on-chain tx.
 *
 * Prereq: Dave has shielded balance from qa-live-deposit.ts.
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
const OUT = resolve(REPO, "packages/app/test-results/qa-live-gift");

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
  console.log(`QA Gift Envelope · ${VERCEL_URL}`);
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
  await dapp.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.waitForTimeout(3_000);

  const knownPages = new Set<Page>(ctx.pages());

  // The /app/gifts route may also gate on connect — walk carousel + connect if not on dashboard.
  for (let i = 0; i < 6; i++) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_500 }).catch(() => false)) break;
    const heading = dapp.locator("h1, h2").filter({ hasText: /Gift|Envelope/i }).first();
    if (await heading.isVisible({ timeout: 1_500 }).catch(() => false)) break;
    const next = dapp.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 2_000 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => {});
    await dapp.waitForTimeout(1_200);
  }

  const onGifts = await dapp
    .locator("h1, h2")
    .filter({ hasText: /Gift|Envelope/i })
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false);

  if (!onGifts) {
    // Try Connect via WalletChoiceCard.
    const existingCard = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await existingCard.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const connect = existingCard.locator("button").filter({ hasText: /Rabby/i }).first();
      await connect.click({ force: true });
      await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-connect", 30_000, {
        chainName: "Base Sepolia",
      });
      await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-siwe", 20_000);
      await dapp.waitForTimeout(3_000);
      await dapp.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded" });
      await dapp.waitForTimeout(3_000);
    }
  }

  await dapp.screenshot({ path: resolve(OUT, "01-gifts-landing.png"), fullPage: true });
  console.log("✓ /app/gifts loaded");

  // Gifts.tsx renders the form inline (not behind a "Create" button).
  // Fill amount, recipient address, then click "Send Gift Envelope"
  // (line 649 in Gifts.tsx).
  const amount = "0.5";

  // Amount input has placeholder "$ 0.00" or "0.00" — match both.
  const amountInput = dapp.locator('input[placeholder*="0.00"]').first();
  await amountInput.waitFor({ state: "visible", timeout: 10_000 });
  await amountInput.fill(amount);
  console.log(`✓ Filled amount: ${amount}`);
  await dapp.screenshot({ path: resolve(OUT, "02-amount-filled.png"), fullPage: true });

  // Recipient input — placeholder includes "0x... (address)" per the form.
  const recipientInput = dapp.locator('input[placeholder*="0x"]').first();
  await recipientInput.waitFor({ state: "visible", timeout: 5_000 });
  await recipientInput.fill("0x000000000000000000000000000000000000dEaD");
  // Trigger blur so React's controlled-input state catches up. fill()
  // alone sometimes leaves React's state empty until blur fires.
  await recipientInput.press("Tab");
  console.log(`✓ Filled recipient: 0x...dEaD`);
  await dapp.waitForTimeout(800);
  await dapp.screenshot({ path: resolve(OUT, "03-recipient-filled.png"), fullPage: true });

  // Pick a gift theme — required by Gifts.tsx:590 (selectedTheme gates
  // the Send button render). Theme cards have visible labels like
  // "Birthday", "Celebration", "Love", "Thank You". Click the first
  // visible theme card.
  const themeBtn = dapp
    .locator("button")
    .filter({ hasText: /^(Birthday|Celebration|Love|Thank You)$/i })
    .first();
  await themeBtn.waitFor({ state: "visible", timeout: 5_000 });
  await themeBtn.click();
  console.log(`✓ Selected gift theme`);
  await dapp.waitForTimeout(800);
  await dapp.screenshot({ path: resolve(OUT, "03b-theme-selected.png"), fullPage: true });

  // Click "Send Gift Envelope". The button (Gifts.tsx:635-650) is
  // disabled while !giftAmount || (!giftRecipient.trim() && recipients.length === 0).
  // After fill + Tab the state should be valid. Relax selector — find
  // by text first, then check if disabled.
  const submitBtn = dapp.locator("button").filter({ hasText: /Send Gift Envelope/i }).first();
  const exists = await submitBtn.count().catch(() => 0);
  console.log(`  submit button count in DOM: ${exists}`);
  if (exists === 0) {
    console.error("✘ Send Gift Envelope button NOT in DOM — form may be in different state");
    await dapp.screenshot({ path: resolve(OUT, "04-no-submit-button.png"), fullPage: true });
    await ctx.close();
    process.exit(11);
  }
  // Scroll into view + check enabled state.
  await submitBtn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  const isDisabled = await submitBtn.isDisabled({ timeout: 2_000 }).catch(() => true);
  console.log(`  submit button disabled: ${isDisabled}`);
  if (isDisabled) {
    console.error("✘ Send Gift Envelope button is disabled — form validation failed");
    await dapp.screenshot({ path: resolve(OUT, "04-submit-disabled.png"), fullPage: true });
    await ctx.close();
    process.exit(12);
  }
  await submitBtn.click();
  console.log("✓ Create gift submitted");
  await dapp.waitForTimeout(2_000);

  // Drive Rabby popup chain (encrypted gift = approve + create like deposit).
  const popup1 = await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-gift-1", 60_000);
  console.log(`  popup1: ${popup1.clicks} click(s), closed=${popup1.closed}`);
  const popup2 = await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-gift-2", 30_000);
  console.log(`  popup2: ${popup2.clicks} click(s), closed=${popup2.closed}`);

  // Wait for success — gift URL surfaces OR Activity updates OR receipt banner appears.
  let giftUrl = "";
  let successBanner = false;
  for (let i = 0; i < 24; i++) {
    // Gift share URL pattern: /gift/<chainId>/<id>
    const giftHref = await dapp
      .locator('a[href*="/gift/"]')
      .first()
      .getAttribute("href", { timeout: 3_000 })
      .catch(() => null);
    if (giftHref) {
      giftUrl = giftHref;
      break;
    }
    successBanner = await dapp
      .locator("text=/Gift created|Gift sent|Envelope created|Successfully created/i")
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (successBanner) break;
    await dapp.waitForTimeout(3_000);
  }

  await dapp.screenshot({ path: resolve(OUT, "05-final-state.png"), fullPage: true });

  const status = giftUrl || successBanner ? "🟢 GREEN" : "🔴 RED";
  const md = [
    `# QA Gift Envelope (live Vercel)`,
    `Generated: ${new Date().toISOString()}`,
    `URL base: ${VERCEL_URL}`,
    `Wallet: Dave (Rabby EOA)`,
    `Chain: Base Sepolia`,
    `Amount: ${amount} USDC`,
    ``,
    `## Result`,
    ``,
    `${status} — ${giftUrl ? `Gift URL: ${giftUrl}` : successBanner ? "Success banner surfaced" : "No success indicator captured"}`,
    ``,
    `## Rabby popups`,
    ``,
    `- Popup 1: ${popup1.clicks} clicks, closed=${popup1.closed}`,
    `- Popup 2: ${popup2.clicks} clicks, closed=${popup2.closed}`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(`\n✓ Report: ${resolve(OUT, "REPORT.md")}`);

  await ctx.close();
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(99);
});
