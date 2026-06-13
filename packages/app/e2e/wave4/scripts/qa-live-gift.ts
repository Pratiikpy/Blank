/**
 * QA: drive Gift Envelope create + recipient claim on live Vercel with Rabby.
 *
 * Examples:
 *   CHAIN_ID=84532    pnpm exec tsx e2e/wave4/scripts/qa-live-gift.ts
 *   CHAIN_ID=11155111 pnpm exec tsx e2e/wave4/scripts/qa-live-gift.ts
 *   CHAIN_ID=421614   pnpm exec tsx e2e/wave4/scripts/qa-live-gift.ts
 */
import { chromium, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, http, type Address, type Hash } from "viem";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";
import {
  unlockRabby,
  dismissRabbyWhatsNew,
  waitAndConfirmRabbyPopup,
  selectRabbyChain,
} from "../../fixtures/rabby/rabby-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://www.myblank.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111 && CHAIN_ID !== 421614) {
  throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
}
const CHAIN_SLUG = CHAIN_ID === 11155111 ? "eth" : CHAIN_ID === 84532 ? "base" : "arb";
const CHAIN_NAME =
  CHAIN_ID === 11155111 ? "Ethereum Sepolia" : CHAIN_ID === 84532 ? "Base Sepolia" : "Arbitrum Sepolia";
const VIEM_CHAIN = CHAIN_ID === 11155111 ? sepolia : CHAIN_ID === 84532 ? baseSepolia : arbitrumSepolia;
const RPC_URL =
  CHAIN_ID === 11155111
    ? "https://ethereum-sepolia.publicnode.com"
    : CHAIN_ID === 84532
      ? "https://base-sepolia-rpc.publicnode.com"
      : "https://sepolia-rollup.arbitrum.io/rpc";
const EXPLORER_URL =
  CHAIN_ID === 11155111
    ? "https://sepolia.etherscan.io"
    : CHAIN_ID === 84532
      ? "https://sepolia.basescan.org"
      : "https://sepolia.arbiscan.io";
const BLOCKSCOUT_URL =
  CHAIN_ID === 11155111
    ? "https://eth-sepolia.blockscout.com"
    : CHAIN_ID === 84532
      ? "https://base-sepolia.blockscout.com"
      : "https://sepolia-explorer.arbitrum.io";
const OUT = resolve(REPO, `packages/app/test-results/qa-live-gift-${CHAIN_SLUG}`);

const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;
const BOB = "0x0D1883c48E14d733D464478f53706D92b7648b9d" as Address;

const publicClient = createPublicClient({
  chain: VIEM_CHAIN,
  transport: http(RPC_URL),
});

async function txsFrom(address: Address, fromNonce: number): Promise<Hash[]> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const url = `${BLOCKSCOUT_URL}/api?module=account&action=txlist&address=${address}&sort=desc`;
    const res = await fetch(url).then((r) => r.json()).catch(() => null) as
      | { result?: Array<{ hash: Hash; nonce: string | number; from?: string; isError?: string }> }
      | null;
    const found = (res?.result ?? [])
      .filter((tx) => tx.from?.toLowerCase() === address.toLowerCase() && Number(tx.nonce) >= fromNonce && tx.isError !== "1")
      .map((tx) => ({ nonce: Number(tx.nonce), hash: tx.hash }));
    if (found.length > 0) return found.sort((a, b) => a.nonce - b.nonce).map((x) => x.hash);
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return [];
}

async function snap(page: Page, label: string): Promise<string> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return file;
}

async function safeFill(page: Page, selector: string, value: string, index = 0): Promise<void> {
  const loc = page.locator(selector).nth(index);
  await loc.waitFor({ state: "visible", timeout: 20_000 });
  await loc.click({ force: true }).catch(() => undefined);
  await loc.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await loc.press("Backspace").catch(() => undefined);
  await loc.type(value, { delay: 25 });
  await loc.press("Tab").catch(() => undefined);
}

async function switchRabbyAccount(rabbyPage: Page, extId: string, targetLabel: string, targetAddress: Address): Promise<void> {
  await rabbyPage.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabbyPage.waitForTimeout(1_500);
  await dismissRabbyWhatsNew(rabbyPage);
  const expected = targetAddress.toLowerCase();
  const body = ((await rabbyPage.locator("body").textContent().catch(() => "")) ?? "").toLowerCase();
  if (body.includes(expected.slice(0, 8)) || body.includes(expected.slice(0, 6))) return;

  const current = rabbyPage.locator("text=/Private Key \\d|Seed Phrase/i").first();
  if (await current.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await current.click({ force: true }).catch(() => undefined);
  } else {
    await rabbyPage.mouse.click(130, 95);
  }
  await rabbyPage.waitForTimeout(1_500);

  const shortAddress = `${expected.slice(0, 6)}...${expected.slice(-4)}`;
  const byAddress = rabbyPage.locator("div, button").filter({ hasText: new RegExp(shortAddress.replace(".", "\\."), "i") }).last();
  if (await byAddress.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await byAddress.click({ force: true }).catch(() => undefined);
    await rabbyPage.waitForTimeout(2_000);
    return;
  }

  const byLabel = rabbyPage.locator("div, button").filter({ hasText: new RegExp(targetLabel, "i") }).last();
  if (await byLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await byLabel.click({ force: true }).catch(() => undefined);
    await rabbyPage.waitForTimeout(2_000);
    return;
  }

  throw new Error(`Rabby account row not found for ${targetLabel} / ${shortAddress}`);
}

async function ensureConnected(dapp: Page, knownPages: Set<Page>, extId: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_000 }).catch(() => false)) break;
    const heading = dapp.locator("h1, h2").filter({ hasText: /Gift|Envelope/i }).first();
    if (await heading.isVisible({ timeout: 1_000 }).catch(() => false)) return;
    const next = dapp.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 1_000 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => undefined);
    await dapp.waitForTimeout(1_000);
  }

  const existingCard = dapp.locator('[data-testid="wallet-choice-existing"]');
  if (await existingCard.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const connect = existingCard.locator("button").filter({ hasText: /Rabby/i }).first();
    await connect.click({ force: true });
    await waitAndConfirmRabbyPopup((dapp.context() as any), extId, knownPages, OUT, "rabby-connect", 30_000, {
      chainName: CHAIN_NAME,
    });
    await waitAndConfirmRabbyPopup((dapp.context() as any), extId, knownPages, OUT, "rabby-siwe", 20_000).catch(() => undefined);
    await dapp.waitForTimeout(3_000);
    await dapp.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
}

async function waitForClaimState(page: Page, state: "received" | "claimed", timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('button[aria-label="Received gifts"]').click().catch(() => undefined);
    await page.waitForTimeout(3_000);
    await page.locator("button").filter({ hasText: /^Install$/i }).locator("xpath=..").getByRole("button", { name: /^×$|^x$|close/i }).click().catch(() => undefined);
    const button = page.locator("button").filter({ hasText: state === "received" ? /^Claim$/i : /^Claimed$/i }).first();
    if (await button.isVisible({ timeout: 5_000 }).catch(() => false)) return true;
    await page.waitForTimeout(8_000);
  }
  return false;
}

async function waitForAliceClaimed(page: Page, timeoutMs = 240_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('button[aria-label="Sent gifts"]').click().catch(() => undefined);
    await page.waitForTimeout(3_000);
    const badge = page.locator("text=/claimed/i").first();
    if (await badge.isVisible({ timeout: 5_000 }).catch(() => false)) return true;
    await page.waitForTimeout(8_000);
  }
  return false;
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
  console.log(`QA Gift create + claim · ${CHAIN_NAME} · ${VERCEL_URL}`);
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

  const rabby = await ctx.newPage();
  await rabby.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabby.waitForTimeout(2_000);
  await unlockRabby(rabby, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(rabby);
  await selectRabbyChain(rabby, CHAIN_NAME, OUT).catch(() => undefined);

  const dapp = await ctx.newPage();
  const knownPages = new Set<Page>(ctx.pages());

  try {
    await switchRabbyAccount(rabby, extId, "Private Key 1", DAVE);
    await dapp.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await ensureConnected(dapp, knownPages, extId);
    await snap(dapp, "01-gifts-dave-landing");

    const createNonce = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
    const amount = "0.5";
    const message = `QA gift ${CHAIN_NAME} ${Date.now()}`;
    await safeFill(dapp, 'input[placeholder*="0.00"]', amount);
    await safeFill(dapp, 'input[placeholder*="0x"]', BOB);
    await safeFill(dapp, 'textarea[placeholder*="heartfelt"]', message);
    await dapp.locator("button").filter({ hasText: /^(Birthday|Celebration|Love|Thank You)$/i }).first().click({ force: true });
    await snap(dapp, "02-gift-filled");

    const submitBtn = dapp.locator("button").filter({ hasText: /Send Gift Envelope/i }).first();
    await submitBtn.click({ force: true });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-gift-create-1", 60_000, { chainName: CHAIN_NAME });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-gift-create-2", 45_000).catch(() => undefined);
    await dapp.getByRole("heading", { name: /Gift Sent!/i }).waitFor({ state: "visible", timeout: 180_000 });
    const createTxHash = await dapp.locator('[data-testid="gift-create-tx-hash"]').getAttribute("data-tx-hash").catch(() => null);
    const createHashes = createTxHash ? [createTxHash as Hash] : await txsFrom(DAVE, createNonce);
    await snap(dapp, "03-gift-created");

    await switchRabbyAccount(rabby, extId, "Private Key 2", BOB);
    await dapp.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await ensureConnected(dapp, knownPages, extId);
    const claimReady = await waitForClaimState(dapp, "received", 240_000);
    if (!claimReady) throw new Error("Bob did not see claimable gift");
    await snap(dapp, "04-bob-claim-ready");

    const claimNonce = await publicClient.getTransactionCount({ address: BOB, blockTag: "pending" });
    await dapp.locator('button[aria-label="Received gifts"]').click().catch(() => undefined);
    const claimBtn = dapp.locator("button").filter({ hasText: /^Claim$/i }).first();
    await claimBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await claimBtn.waitFor({ state: "visible", timeout: 20_000 });
    await claimBtn.click({ force: true });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-gift-claim-1", 60_000, { chainName: CHAIN_NAME });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-gift-claim-2", 45_000).catch(() => undefined);
    const bobClaimed = await waitForClaimState(dapp, "claimed", 240_000);
    const claimHashes = await txsFrom(BOB, claimNonce);
    if (!bobClaimed) throw new Error("Bob did not see claimed gift state");
    await snap(dapp, "05-bob-claimed");

    await switchRabbyAccount(rabby, extId, "Private Key 1", DAVE);
    const aliceClaimed = await waitForAliceClaimed(dapp, 240_000);
    await snap(dapp, "06-dave-sent-claimed");
    const claimProven = claimHashes.length > 0 || (bobClaimed && aliceClaimed);
    const overallGreen = createHashes.length > 0 && claimProven;

    const md = [
      `# QA Gift Envelope outcome`,
      `Generated: ${new Date().toISOString()}`,
      `URL base: ${VERCEL_URL}`,
      `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
      `Sender: Dave (Rabby EOA)`,
      `Recipient: Bob (Rabby EOA)`,
      "",
      "| Flow | Status | Tx hashes | Detail |",
      "|---|---|---|---|",
      `| Gift create -> recipient claims -> sender sees claimed | ${overallGreen ? "green" : "red"} | ${[...createHashes, ...claimHashes].map((h) => `[${h.slice(0, 10)}...](${EXPLORER_URL}/tx/${h})`).join("<br>") || "-"} | amount=${amount}; message=${message}; claimHashes=${claimHashes.length}; bobClaimed=${bobClaimed}; aliceClaimed=${aliceClaimed} |`,
      "",
      `Output dir: ${OUT}`,
    ].join("\n");
    writeFileSync(resolve(OUT, "REPORT.md"), md);
    console.log(md);
    if (!overallGreen) process.exit(2);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).stack ?? (e as Error).message);
  process.exit(99);
});
