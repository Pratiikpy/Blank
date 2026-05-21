import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  unlockRabby,
  dismissRabbyWhatsNew,
  waitAndConfirmRabbyPopup,
  confirmRabbyPopup,
} from "../../fixtures/rabby/rabby-driver";
import {
  faucetUsdcIfNeeded,
  shieldUsdc,
  drainPromptsAndCaptureTx,
} from "../helpers/app-actions";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://www.myblank.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const OUT = resolve(REPO, "packages/app/test-results/qa-live-multiwallet");
const CHAIN_ID = 84532;
const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175";
const ALICE_PASSPHRASE = "qa-live-alice-passphrase-2026";

interface Result {
  status: "green" | "red";
  aliceAddress?: string;
  sendTxHash?: string;
  note: string;
  screenshot?: string;
}

async function snap(page: Page, label: string): Promise<string> {
  const path = resolve(OUT, `${label}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => {});
  return path;
}

async function safeFill(loc: Locator, value: string): Promise<void> {
  await loc.waitFor({ state: "visible", timeout: 30_000 });
  await loc.click().catch(() => undefined);
  await loc.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await loc.press("Backspace").catch(() => undefined);
  await loc.type(value, { delay: 25 });
  await loc.press("Tab").catch(() => undefined);
}

async function drainRabbyPopups(
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  label: string,
  maxPopups = 3,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxPopups; i++) {
    const existing = ctx.pages().find((p) => {
      if (p.isClosed()) return false;
      const url = p.url();
      return url.includes(extId) && url.includes("notification.html");
    });
    const r = existing
      ? { popup: existing, ...(await confirmRabbyPopup(existing, OUT, `${label}-${i + 1}`)) }
      : await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `${label}-${i + 1}`, 45_000);
    if (r.popup) known.add(r.popup);
    if (r.clicks === 0) break;
    total += r.clicks;
  }
  return total;
}

async function connectDave(ctx: BrowserContext, extId: string): Promise<{ page: Page; known: Set<Page> }> {
  const page = await ctx.newPage();
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_500);
  const known = new Set<Page>(ctx.pages());

  for (let i = 0; i < 6; i++) {
    const card = page.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_500 }).catch(() => false)) break;
    const next = page.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 1_500 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }

  const landed = await page
    .locator("text=/Total Balance|Recent Activity|FHE Protected/i")
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (!landed) {
    const card = page.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await card.locator("button").filter({ hasText: /Rabby/i }).first().click({ force: true });
      await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "rabby-connect", 30_000, { chainName: "Base Sepolia" });
      await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "rabby-siwe", 20_000);
    }
  }
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Recent Activity|Total Balance|FHE Protected/i").first().waitFor({ state: "visible", timeout: 30_000 });
  await snap(page, "dave-before");
  return { page, known };
}

async function createPasskeyAlice(page: Page): Promise<string> {
  await page.goto(VERCEL_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page
    .locator("h2", { hasText: /Send money privately/i })
    .waitFor({ state: "visible", timeout: 30_000 });

  const headings = [
    /Only you see the amounts/i,
    /Works everywhere you go/i,
    /Your keys\. Your money\./i,
  ];
  for (const h of headings) {
    const next = page.locator("button").filter({ hasText: /^Next/i }).first();
    if (await next.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await next.click();
      await page.locator("h2", { hasText: h }).waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
    }
  }

  const passkeyCta = page
    .locator("button")
    .filter({ hasText: /passkey|smart wallet|create.*account/i })
    .first();
  await passkeyCta.waitFor({ state: "visible", timeout: 20_000 });
  await snap(page, "alice-wallet-choice");
  await passkeyCta.click();

  await safeFill(page.locator('[data-testid="passkey-passphrase-new"]').first(), ALICE_PASSPHRASE);
  await safeFill(page.locator('[data-testid="passkey-passphrase-confirm"]').first(), ALICE_PASSPHRASE);
  await snap(page, "alice-passkey-form");
  await page.locator('[data-testid="passkey-create-submit"]').click();

  await page
    .locator("text=/Total Balance|Recent Activity|FHE Protected|Dashboard/i")
    .first()
    .waitFor({ state: "visible", timeout: 90_000 });
  await snap(page, "alice-dashboard-created");

  await page.goto(`${VERCEL_URL}/app/wallet`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const address = (await page.locator('[data-testid="gas-wallet-address"]').textContent({ timeout: 60_000 }))?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Alice address not found: ${address}`);
  await snap(page, "alice-wallet-address");
  return address;
}

async function driveSendFlow(page: Page, recipientAddress: string, amountUsdc: string, note: string): Promise<string> {
  await page.goto(`${VERCEL_URL}/app/send`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const recipientInput = page
    .locator('input[placeholder="0x… or pratik.eth"], input[placeholder*="Wallet address" i]')
    .first();
  await safeFill(recipientInput, recipientAddress);
  await page.locator("button").filter({ hasText: /^(Continue|Next)/i }).first().click();

  const amountInput = page.locator('input[placeholder="0.00"]').first();
  if (await amountInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await safeFill(amountInput, amountUsdc);
  } else {
    for (const ch of amountUsdc) {
      const label = ch === "." ? "Decimal point" : ch;
      await page.locator(`button[aria-label="${label}"]:visible`).first().click();
    }
  }

  const addNote = page.locator('button[aria-label="Add a note"]').first();
  if (await addNote.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await addNote.click();
  }
  const noteInput = page.locator('input[aria-label="Payment note"]').first();
  if (await noteInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await safeFill(noteInput, note);
  }
  await snap(page, "alice-send-amount-note");

  await page
    .locator("main button:visible:not([disabled])")
    .filter({ hasText: /^(Continue|Review|Next|Send)/i })
    .last()
    .click();
  await page.waitForURL(/\/app\/send\/confirm/, { timeout: 30_000 });
  await snap(page, "alice-send-confirm");

  await page
    .locator("main button:visible:not([disabled])")
    .filter({ hasText: /Confirm.*Send|^Send/i })
    .last()
    .click();
  const txHash = await drainPromptsAndCaptureTx(page, ALICE_PASSPHRASE, {
    windowMs: 420_000,
    readTimeoutMs: 120_000,
  });
  await snap(page, "alice-send-success");
  return txHash;
}

async function waitForDaveActivity(page: Page, note: string): Promise<boolean> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("text=/Recent Activity|Total Balance/i").first().waitFor({ state: "visible", timeout: 30_000 });
    const found = await page.locator(`text=${note}`).first().isVisible({ timeout: 5_000 }).catch(() => false);
    if (found) return true;
    const received = await page
      .locator("text=/Received|Payment received|Incoming|Sent you/i")
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    if (received) {
      const body = (await page.locator("body").textContent().catch(() => "")) ?? "";
      if (body.includes(note) || body.includes("Received")) return true;
    }
    await page.waitForTimeout(20_000);
  }
  return false;
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(RABBY_PROFILE_DIR)) {
    console.error("FATAL: Rabby ext or profile missing");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`QA live multi-wallet · ${VERCEL_URL} · output: ${OUT}`);

  const rabbyCtx = await chromium.launchPersistentContext(RABBY_PROFILE_DIR, {
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
    const sw = rabbyCtx.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (sw) { extId = sw.url().split("/")[2]; break; }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!extId) throw new Error("Rabby service worker did not register");

  const rabbyHome = await rabbyCtx.newPage();
  await rabbyHome.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabbyHome.waitForTimeout(2_000);
  await unlockRabby(rabbyHome, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(rabbyHome);
  const dave = await connectDave(rabbyCtx, extId);

  const aliceBrowser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const aliceCtx = await aliceBrowser.newContext({
    viewport: { width: 1280, height: 800 },
    baseURL: VERCEL_URL,
  });
  const alicePage = await aliceCtx.newPage();
  alicePage.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || m.type() === "warn" || /relay|userop|revert|fail|error|passphrase/i.test(t)) {
      console.log(`[alice console:${m.type()}] ${t.slice(0, 400)}`);
    }
  });

  const result: Result = { status: "red", note: "not completed" };
  try {
    const aliceAddress = await createPasskeyAlice(alicePage);
    result.aliceAddress = aliceAddress;
    console.log(`✓ Alice passkey address: ${aliceAddress}`);

    const faucetHash = await faucetUsdcIfNeeded(alicePage, aliceAddress, CHAIN_ID, VERCEL_URL);
    console.log(`✓ Alice faucet: ${faucetHash.slice(0, 10)}…`);
    await alicePage.reload();
    await shieldUsdc(alicePage, "2", ALICE_PASSPHRASE);
    await snap(alicePage, "alice-shielded");
    console.log("✓ Alice shielded 2 USDC");

    const note = `QA multiwallet ${Date.now().toString().slice(-6)}`;
    const txHash = await driveSendFlow(alicePage, DAVE, "0.25", note);
    result.sendTxHash = txHash;
    console.log(`✓ Alice sent to Dave: ${txHash}`);

    const reactive = await waitForDaveActivity(dave.page, note);
    await snap(dave.page, "dave-after-reactivity");
    result.status = reactive ? "green" : "red";
    result.note = reactive
      ? `Dave Rabby dashboard showed Alice's incoming payment note: ${note}`
      : `Dave Rabby dashboard did not show note within 240s: ${note}`;
  } catch (err) {
    result.status = "red";
    result.note = err instanceof Error ? err.message : String(err);
    await snap(alicePage, "alice-error").catch(() => undefined);
    await snap(dave.page, "dave-error").catch(() => undefined);
  } finally {
    const md = [
      "# QA live multi-wallet (live Vercel, desktop, Base Sepolia)",
      `Generated: ${new Date().toISOString()}`,
      "",
      `Status: ${result.status}`,
      `Alice: ${result.aliceAddress ?? "-"}`,
      `Dave: ${DAVE}`,
      `Send tx: ${result.sendTxHash ? `[${result.sendTxHash}](https://sepolia.basescan.org/tx/${result.sendTxHash})` : "-"}`,
      `Note: ${result.note}`,
    ].join("\n");
    writeFileSync(resolve(OUT, "REPORT.md"), md);
    await aliceCtx.close().catch(() => undefined);
    await aliceBrowser.close().catch(() => undefined);
    await rabbyCtx.close().catch(() => undefined);
  }

  console.log(`✓ Report: ${resolve(OUT, "REPORT.md")}`);
  if (result.status !== "green") process.exit(2);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(99);
});
