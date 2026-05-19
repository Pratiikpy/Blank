/**
 * QA batch: drive remaining features sequentially on live Vercel.
 *
 *   pnpm exec tsx packages/app/e2e/wave4/scripts/qa-live-batch.ts
 *
 * One browser session, one Rabby connect, then drive each feature's
 * primary "create" action. Captures per-feature outcome + final
 * screenshot. Writes a single combined REPORT.md.
 *
 * Covered features (post-Send + Deposit + Gifts already proven):
 *   - Stealth Inbox setup (generate keys)
 *   - Inheritance plan setup
 *   - Encrypted income Proof
 *   - Business invoice create
 *   - Payment Request create
 *   - Group create
 *   - Claim Link create
 *   - Storefront Listing create
 *   - Crowdfund Campaign create
 */
import { chromium, type Page, type BrowserContext } from "@playwright/test";
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
const OUT = resolve(REPO, "packages/app/test-results/qa-live-batch");

interface FeatureResult {
  name: string;
  status: "green" | "red" | "skipped";
  txHash?: string;
  notes: string;
  screenshot: string;
}

const results: FeatureResult[] = [];

async function snap(p: Page, label: string): Promise<string> {
  const path = resolve(OUT, `${label}.png`);
  await p.screenshot({ path, fullPage: true }).catch(() => {});
  return path;
}

function recordTxFromText(text: string): string | undefined {
  const m = text.match(/0x[0-9a-fA-F]{64}/);
  return m ? m[0] : undefined;
}

async function drainPopups(
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  label: string,
  maxPopups = 3,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxPopups; i++) {
    const r = await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `${label}-${i + 1}`, 45_000);
    if (r.clicks === 0) break;
    total += r.clicks;
  }
  return total;
}

// ──────────────────────────────────────────────────────────────────
//  Stealth Inbox — generate keys.
// ──────────────────────────────────────────────────────────────────
async function driveStealth(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Stealth Inbox";
  await dapp.goto(`${VERCEL_URL}/app/stealth/setup`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_000);
  // Look for "Generate keys" / "Set up" / "Create" CTA on stealth setup.
  const cta = dapp.locator("button:visible:not([disabled])").filter({ hasText: /Generate|Set up|Create.*key/i }).first();
  if (!(await cta.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "stealth-no-cta");
    return { name, status: "skipped", notes: "No Generate/Set-up CTA visible", screenshot: s };
  }
  await cta.click();
  await drainPopups(ctx, extId, known, "stealth");
  await dapp.waitForTimeout(3_000);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "stealth-final");
  return { name, status: txHash ? "green" : "red", txHash, notes: txHash ? "tx captured" : "no tx hash in DOM", screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Inheritance — set up plan (Bob as heir).
// ──────────────────────────────────────────────────────────────────
async function driveInheritance(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Inheritance";
  await dapp.goto(`${VERCEL_URL}/app/inheritance`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_000);
  // Click "Set Up Inheritance Plan".
  const setupBtn = dapp.locator("button:visible:not([disabled])").filter({ hasText: /Set Up.*Plan|Create Plan/i }).first();
  if (!(await setupBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "inheritance-no-cta");
    return { name, status: "skipped", notes: "No Set-Up-Plan CTA — plan may already exist", screenshot: s };
  }
  await setupBtn.click();
  await dapp.waitForTimeout(1_500);
  // Fill heir address. Modal typically has a 0x input.
  const heirInput = dapp.locator('input[placeholder*="0x"]').first();
  if (await heirInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await heirInput.fill("0x000000000000000000000000000000000000bEEf");
    await heirInput.press("Tab");
  }
  // Submit.
  const submit = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^(Create|Submit|Save|Confirm).*[Pp]lan|^Set.*Plan/i }).first();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    const s = await snap(dapp, "inheritance-no-submit");
    return { name, status: "red", notes: "Submit CTA not visible inside modal", screenshot: s };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "inheritance");
  await dapp.waitForTimeout(3_000);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "inheritance-final");
  return { name, status: txHash ? "green" : "red", txHash, notes: txHash ? "tx captured" : "no tx hash in DOM", screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Encrypted Proof of Income.
// ──────────────────────────────────────────────────────────────────
async function driveProof(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Encrypted Proof";
  await dapp.goto(`${VERCEL_URL}/app/proofs`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // CTA: "Create proof" / "Generate proof".
  const createBtn = dapp.locator("button:visible:not([disabled])").filter({ hasText: /Create.*[Pp]roof|Generate.*[Pp]roof|^New.*[Pp]roof/i }).first();
  if (!(await createBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "proof-no-cta");
    return { name, status: "skipped", notes: "No Create-proof CTA visible", screenshot: s };
  }
  await createBtn.click();
  await dapp.waitForTimeout(1_500);
  // Form: threshold amount input, time window, verifier address.
  const threshold = dapp.locator('input[type="number"], input[placeholder*="0.00"], input[placeholder*="amount"]').first();
  if (await threshold.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await threshold.fill("100");
    await threshold.press("Tab");
  }
  // Verifier address input.
  const verifier = dapp.locator('input[placeholder*="0x"]').first();
  if (await verifier.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await verifier.fill("0x000000000000000000000000000000000000bEEf");
    await verifier.press("Tab");
  }
  await snap(dapp, "proof-form-filled");
  // Submit.
  const submit = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^(Generate|Create|Submit).*[Pp]roof|^Create$/i }).last();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    const s = await snap(dapp, "proof-no-submit");
    return { name, status: "red", notes: "Submit CTA not visible", screenshot: s };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "proof");
  await dapp.waitForTimeout(5_000);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "proof-final");
  return { name, status: txHash ? "green" : "red", txHash, notes: txHash ? "tx captured" : "no tx hash in DOM", screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Business invoice create.
// ──────────────────────────────────────────────────────────────────
async function driveBusinessInvoice(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Business Invoice";
  await dapp.goto(`${VERCEL_URL}/app/business`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  const cta = dapp.locator("button:visible:not([disabled])").filter({ hasText: /Create.*[Ii]nvoice|New.*[Ii]nvoice/i }).first();
  if (!(await cta.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "business-no-cta");
    return { name, status: "skipped", notes: "No Create-invoice CTA visible", screenshot: s };
  }
  await cta.click();
  await dapp.waitForTimeout(1_500);
  // Amount + payer.
  const amount = dapp.locator('input[placeholder="0.00"]').first();
  if (await amount.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await amount.fill("25");
    await amount.press("Tab");
  }
  const payer = dapp.locator('input[placeholder*="0x"]').first();
  if (await payer.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await payer.fill("0x000000000000000000000000000000000000bEEf");
    await payer.press("Tab");
  }
  await snap(dapp, "business-form-filled");
  const submit = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^(Create|Send|Submit).*[Ii]nvoice|^Create$/i }).last();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    const s = await snap(dapp, "business-no-submit");
    return { name, status: "red", notes: "Submit CTA not visible", screenshot: s };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "business");
  await dapp.waitForTimeout(3_000);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "business-final");
  return { name, status: txHash ? "green" : "red", txHash, notes: txHash ? "tx captured" : "no tx hash in DOM", screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Payment Request.
// ──────────────────────────────────────────────────────────────────
async function drivePaymentRequest(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Payment Request";
  await dapp.goto(`${VERCEL_URL}/app/requests`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // Header "Request" / "+ Request" button.
  const cta = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^Request$|New.*[Rr]equest/i }).first();
  if (!(await cta.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "request-no-cta");
    return { name, status: "skipped", notes: "No New-request CTA visible", screenshot: s };
  }
  await cta.click();
  await dapp.waitForTimeout(1_500);
  // Form fields.
  const payer = dapp.locator('input[placeholder*="0x"]').first();
  if (await payer.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await payer.fill("0x000000000000000000000000000000000000bEEf");
    await payer.press("Tab");
  }
  const amount = dapp.locator('input[placeholder="0.00"]').first();
  if (await amount.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await amount.fill("5");
    await amount.press("Tab");
  }
  await snap(dapp, "request-form-filled");
  const submit = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^Send Request|^Create.*[Rr]equest/i }).first();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    const s = await snap(dapp, "request-no-submit");
    return { name, status: "red", notes: "Submit CTA not visible", screenshot: s };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "request");
  await dapp.waitForTimeout(3_000);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "request-final");
  return { name, status: txHash ? "green" : "red", txHash, notes: txHash ? "tx captured" : "no tx hash in DOM", screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Group create.
// ──────────────────────────────────────────────────────────────────
async function driveGroup(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Group";
  await dapp.goto(`${VERCEL_URL}/app/groups`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  const cta = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^Create|^\+ Group|First Group/i }).first();
  if (!(await cta.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "group-no-cta");
    return { name, status: "skipped", notes: "No Create-group CTA visible", screenshot: s };
  }
  await cta.click();
  await dapp.waitForTimeout(1_500);
  // Name input.
  const nameInput = dapp.locator('input[placeholder*="Weekend"], input[placeholder*="name"]').first();
  if (await nameInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await nameInput.fill(`QA-${Date.now().toString().slice(-5)}`);
    await nameInput.press("Tab");
  }
  // Add member.
  const memberInput = dapp.locator('input[placeholder="0x..."]').first();
  if (await memberInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await memberInput.fill("0x000000000000000000000000000000000000bEEf");
    const addBtn = dapp.locator('button[aria-label="Add member"]').first();
    if (await addBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await addBtn.click();
  }
  await snap(dapp, "group-form-filled");
  const submit = dapp.locator('button:visible:not([disabled])').filter({ hasText: /^Create Group/i }).last();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    const s = await snap(dapp, "group-no-submit");
    return { name, status: "red", notes: "Submit CTA not visible", screenshot: s };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "group");
  await dapp.waitForTimeout(3_000);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "group-final");
  return { name, status: txHash ? "green" : "red", txHash, notes: txHash ? "tx captured" : "no tx hash in DOM", screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Claim Link create.
// ──────────────────────────────────────────────────────────────────
async function driveClaimLink(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Claim Link";
  await dapp.goto(`${VERCEL_URL}/app/claim-link`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  const amount = dapp.locator('input[placeholder="0.00"]').first();
  if (await amount.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await amount.fill("0.1");
    await amount.press("Tab");
  }
  await snap(dapp, "claim-link-form");
  const submit = dapp.locator('button:visible:not([disabled])').filter({ hasText: /^Generate|^Create.*[Ll]ink|^Send/i }).last();
  if (!(await submit.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "claim-link-no-submit");
    return { name, status: "red", notes: "Submit CTA not visible", screenshot: s };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "claim-link");
  await dapp.waitForTimeout(3_000);
  // Claim link surfaces a URL: look for /claim/ pattern.
  const claimUrl = await dapp.locator('a[href*="/claim/"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "claim-link-final");
  return { name, status: claimUrl || txHash ? "green" : "red", txHash, notes: claimUrl ? `claim URL: ${claimUrl}` : (txHash ? "tx captured" : "no proof"), screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Storefront listing create.
// ──────────────────────────────────────────────────────────────────
async function driveStorefront(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Storefront Listing";
  await dapp.goto(`${VERCEL_URL}/app/sell`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // Pick Fixed price mode if mode picker exists.
  const fixedTab = dapp.locator("button").filter({ hasText: /^Fixed/i }).first();
  if (await fixedTab.isVisible({ timeout: 3_000 }).catch(() => false)) await fixedTab.click();
  // Title, description, price.
  const titleInput = dapp.locator('input[placeholder*="title" i], input[placeholder*="name" i]').first();
  if (await titleInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await titleInput.fill(`QA Listing ${Date.now().toString().slice(-5)}`);
    await titleInput.press("Tab");
  }
  const desc = dapp.locator('textarea').first();
  if (await desc.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await desc.fill("QA test listing");
    await desc.press("Tab");
  }
  const price = dapp.locator('input[placeholder="0.00"]').first();
  if (await price.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await price.fill("0.5");
    await price.press("Tab");
  }
  await snap(dapp, "storefront-form-filled");
  const submit = dapp.locator('button:visible:not([disabled])').filter({ hasText: /^Create.*[Ll]isting|^Publish|^List/i }).last();
  if (!(await submit.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "storefront-no-submit");
    return { name, status: "red", notes: "Submit CTA not visible", screenshot: s };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "storefront");
  await dapp.waitForTimeout(3_000);
  const shopUrl = await dapp.locator('a[href*="/shop/"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "storefront-final");
  return { name, status: shopUrl || txHash ? "green" : "red", txHash, notes: shopUrl ? `shop URL: ${shopUrl}` : (txHash ? "tx captured" : "no proof"), screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Crowdfund campaign.
// ──────────────────────────────────────────────────────────────────
async function driveCrowdfund(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Crowdfund Campaign";
  await dapp.goto(`${VERCEL_URL}/app/fundraise`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  const titleInput = dapp.locator('input[placeholder*="title" i], input[placeholder*="name" i]').first();
  if (await titleInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await titleInput.fill(`QA Campaign ${Date.now().toString().slice(-5)}`);
    await titleInput.press("Tab");
  }
  const goal = dapp.locator('input[placeholder="0.00"]').first();
  if (await goal.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await goal.fill("10");
    await goal.press("Tab");
  }
  const desc = dapp.locator('textarea').first();
  if (await desc.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await desc.fill("QA test campaign");
    await desc.press("Tab");
  }
  await snap(dapp, "crowdfund-form-filled");
  const submit = dapp.locator('button:visible:not([disabled])').filter({ hasText: /^Create.*[Cc]ampaign|^Launch|^Publish/i }).last();
  if (!(await submit.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const s = await snap(dapp, "crowdfund-no-submit");
    return { name, status: "red", notes: "Submit CTA not visible", screenshot: s };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "crowdfund");
  await dapp.waitForTimeout(3_000);
  const fundUrl = await dapp.locator('a[href*="/fund/"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  const txHash = recordTxFromText(await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "") ?? "");
  const s = await snap(dapp, "crowdfund-final");
  return { name, status: fundUrl || txHash ? "green" : "red", txHash, notes: fundUrl ? `fund URL: ${fundUrl}` : (txHash ? "tx captured" : "no proof"), screenshot: s };
}

// ──────────────────────────────────────────────────────────────────
//  Main orchestration.
// ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(RABBY_PROFILE_DIR)) {
    console.error("FATAL: Rabby ext or profile missing");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`QA batch · ${VERCEL_URL} · output: ${OUT}`);

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
    if (sw) { extId = sw.url().split("/")[2]; break; }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!extId) { console.error("FATAL: SW didn't register"); await ctx.close(); process.exit(2); }

  const home = await ctx.newPage();
  await home.goto(`chrome-extension://${extId}/index.html`).catch(() => {});
  await home.waitForTimeout(2_000);
  await unlockRabby(home, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(home);

  const dapp = await ctx.newPage();
  await dapp.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.waitForTimeout(3_500);

  const known = new Set<Page>(ctx.pages());

  // Walk carousel + connect if needed.
  for (let i = 0; i < 6; i++) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_500 }).catch(() => false)) break;
    const next = dapp.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 1_500 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => {});
    await dapp.waitForTimeout(1_000);
  }
  const landed = await dapp.locator("text=/Good afternoon|Total Balance|FHE Protected/i").first()
    .isVisible({ timeout: 5_000 }).catch(() => false);
  if (!landed) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await card.locator("button").filter({ hasText: /Rabby/i }).first().click({ force: true });
      await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "rabby-connect", 30_000, { chainName: "Base Sepolia" });
      await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "rabby-siwe", 20_000);
    }
  }
  console.log("✓ Connected, starting feature batch\n");

  const features: Array<(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>) => Promise<FeatureResult>> = [
    driveStealth,
    driveInheritance,
    driveProof,
    driveBusinessInvoice,
    drivePaymentRequest,
    driveGroup,
    driveClaimLink,
    driveStorefront,
    driveCrowdfund,
  ];

  for (const fn of features) {
    try {
      const r = await fn(dapp, ctx, extId, known);
      const tag = r.status === "green" ? "🟢" : r.status === "red" ? "🔴" : "⚪";
      console.log(`${tag} ${r.name.padEnd(22)} ${r.notes}${r.txHash ? "  tx=" + r.txHash.slice(0, 10) + "…" : ""}`);
      results.push(r);
    } catch (e) {
      const r: FeatureResult = { name: fn.name, status: "red", notes: (e as Error).message.slice(0, 200), screenshot: "" };
      console.log(`🔴 ${r.name.padEnd(22)} EXCEPTION: ${r.notes}`);
      results.push(r);
    }
  }

  const md = [
    `# QA batch (live Vercel, desktop, Base Sepolia, Rabby)`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Per-feature results`,
    ``,
    `| Feature | Status | Tx hash | Notes |`,
    `|---|---|---|---|`,
    ...results.map((r) => {
      const tag = r.status === "green" ? "🟢 green" : r.status === "red" ? "🔴 red" : "⚪ skipped";
      const tx = r.txHash ? `[${r.txHash.slice(0, 10)}…](https://sepolia.basescan.org/tx/${r.txHash})` : "—";
      return `| ${r.name} | ${tag} | ${tx} | ${r.notes} |`;
    }),
    ``,
    `## Summary`,
    `- 🟢 green: ${results.filter((r) => r.status === "green").length}`,
    `- 🔴 red: ${results.filter((r) => r.status === "red").length}`,
    `- ⚪ skipped: ${results.filter((r) => r.status === "skipped").length}`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(`\n✓ Report: ${resolve(OUT, "REPORT.md")}`);

  await ctx.close();
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(99); });
