import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Hash } from "viem";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";

import {
  unlockRabby,
  dismissRabbyWhatsNew,
  waitAndConfirmRabbyPopup,
  confirmRabbyPopup,
} from "../../fixtures/rabby/rabby-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://www.myblank.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PROFILE_DIR = process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111 && CHAIN_ID !== 421614)
  throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
const CHAIN_SLUG = CHAIN_ID === 11155111 ? "eth" : CHAIN_ID === 84532 ? "base" : "arb";
const CHAIN_NAME =
  CHAIN_ID === 11155111 ? "Ethereum Sepolia" : CHAIN_ID === 84532 ? "Base Sepolia" : "Arbitrum Sepolia";
const VIEM_CHAIN = CHAIN_ID === 11155111 ? sepolia : CHAIN_ID === 84532 ? baseSepolia : arbitrumSepolia;
const RPC_URL =
  CHAIN_ID === 11155111
    ? "https://ethereum-sepolia.publicnode.com"
    : CHAIN_ID === 84532
      ? "https://sepolia.base.org"
      : "https://sepolia-rollup.arbitrum.io/rpc";
const EXPLORER_URL =
  CHAIN_ID === 11155111
    ? "https://sepolia.etherscan.io"
    : CHAIN_ID === 84532
      ? "https://sepolia.basescan.org"
      : "https://sepolia.arbiscan.io";
const OUT = resolve(REPO, `packages/app/test-results/qa-live-send-${CHAIN_SLUG}`);
const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;
const BOB = "0x0D1883c48E14d733D464478f53706D92b7648b9d" as Address;
const SENDER = (process.env.SENDER ?? "Bob") as "Dave" | "Bob";
const RECIPIENT = (SENDER === "Bob" ? DAVE : BOB) as Address;

const publicClient = createPublicClient({
  chain: VIEM_CHAIN,
  transport: http(RPC_URL),
});

type Persona = "Dave" | "Bob";
type TxHit = { block: bigint; nonce: number; hash: Hash; to: Address | null; status: "success" | "reverted" };

const accountByPersona: Record<Persona, Address> = { Dave: DAVE, Bob: BOB };
const labelByPersona: Record<Persona, string> = { Dave: "Private Key 1", Bob: "Private Key 2" };

async function snap(page: Page, label: string): Promise<string> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return file;
}

async function safeFill(loc: Locator, value: string): Promise<void> {
  await loc.waitFor({ state: "visible", timeout: 30_000 });
  await loc.click({ timeout: 5_000 }).catch(() => undefined);
  await loc.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await loc.press("Backspace").catch(() => undefined);
  await loc.type(value, { delay: 30 });
  await loc.press("Tab").catch(() => undefined);
}

async function drainRabbyPopups(
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  label: string,
  maxPopups = 5,
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

async function txsFrom(address: Address, fromNonce: number): Promise<TxHit[]> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const latest = await publicClient.getBlockNumber();
    const min = latest > 180n ? latest - 180n : 0n;
    const found: TxHit[] = [];
    for (let n = latest; n >= min; n--) {
      const block = await publicClient.getBlock({ blockNumber: n, includeTransactions: true }).catch(() => null);
      if (!block) continue;
      for (const tx of block.transactions) {
        if (tx.from.toLowerCase() !== address.toLowerCase() || tx.nonce < fromNonce) continue;
        const receipt = await publicClient.getTransactionReceipt({ hash: tx.hash }).catch(() => null);
        found.push({
          block: n,
          nonce: tx.nonce,
          hash: tx.hash,
          to: tx.to,
          status: receipt?.status ?? "success",
        });
      }
      if (n === 0n) break;
    }
    if (found.length > 0) return found.sort((a, b) => a.nonce - b.nonce);
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return [];
}

async function switchRabbyAccount(rabbyPage: Page, extId: string, persona: Persona): Promise<void> {
  const target = labelByPersona[persona];
  const expected = accountByPersona[persona].toLowerCase();
  await rabbyPage.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabbyPage.waitForTimeout(1_500);
  await dismissRabbyWhatsNew(rabbyPage);

  const body = ((await rabbyPage.locator("body").textContent().catch(() => "")) ?? "").toLowerCase();
  if (body.includes(expected.slice(0, 8)) || body.includes(expected.slice(0, 6))) return;

  const current = rabbyPage.locator("text=/Private Key \\d/i").first();
  if (await current.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await current.click({ force: true }).catch(async () => {
      const box = await current.boundingBox().catch(() => null);
      if (box) await rabbyPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
  } else {
    await rabbyPage.mouse.click(130, 95);
  }
  await rabbyPage.waitForTimeout(1_500);
  await snap(rabbyPage, `rabby-account-menu-${persona.toLowerCase()}`);

  const rows = rabbyPage.locator("div, button").filter({ hasText: new RegExp(target, "i") });
  const count = await rows.count().catch(() => 0);
  if (count === 0) throw new Error(`Rabby account row not found for ${target}`);
  const row = rows.nth(Math.max(0, count - 1));
  const box = await row.boundingBox({ timeout: 5_000 }).catch(() => null);
  if (box) await rabbyPage.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 38));
  else await row.click({ force: true });
  await rabbyPage.waitForTimeout(2_500);
  await snap(rabbyPage, `rabby-after-switch-${persona.toLowerCase()}`);
}

async function ensureDappAccount(
  page: Page,
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  persona: Persona,
): Promise<void> {
  const expected = accountByPersona[persona].toLowerCase();
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  for (let i = 0; i < 4; i++) {
    const next = page.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 1_000 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(700);
  }
  const connectCard = page.locator('[data-testid="wallet-choice-existing"]').first();
  if (await connectCard.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await connectCard.locator("button").filter({ hasText: /Rabby/i }).first().click({ force: true });
    await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `connect-${persona.toLowerCase()}`, 45_000, { chainName: CHAIN_NAME });
    await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `siwe-${persona.toLowerCase()}`, 25_000);
  }

  const accounts = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string[]> } }).ethereum;
    if (!eth) return [];
    return await eth.request({ method: "eth_accounts" }).catch(() => []);
  });
  if (!accounts.map((x) => x.toLowerCase()).includes(expected)) {
    await page.evaluate(async () => {
      const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string[]> } }).ethereum;
      if (eth) await eth.request({ method: "eth_requestAccounts" });
    }).catch(() => undefined);
    await drainRabbyPopups(ctx, extId, known, `request-accounts-${persona.toLowerCase()}`, 2);
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  const after = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string[]> } }).ethereum;
    if (!eth) return [];
    return await eth.request({ method: "eth_accounts" }).catch(() => []);
  });
  if (!after.map((x) => x.toLowerCase()).includes(expected)) {
    throw new Error(`dApp account mismatch for ${persona}: ${after.join(", ")}`);
  }
}

async function driveSend(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<{ note: string; clicks: number; uiState: string }> {
  const note = `QA ${CHAIN_NAME} send ${Date.now()}`;
  await page.goto(`${VERCEL_URL}/app/send`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await safeFill(page.locator('input[placeholder*="0x"], input[placeholder*="address" i]').first(), RECIPIENT);
  await snap(page, "send-recipient-filled");
  const result = page.getByText(new RegExp(`Send to ${RECIPIENT.slice(0, 6)}`, "i")).first();
  if (await result.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await result.click({ force: true });
  }
  await page.locator("main button:visible:not([disabled])").filter({ hasText: /^(Continue|Next)/i }).last().click();

  const amountInput = page.locator('input[placeholder="0.00"]').first();
  if (await amountInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await safeFill(amountInput, "0.01");
  } else {
    const labelFor = (ch: string) => (ch === "." ? "Decimal point" : ch);
    for (const ch of "0.01") {
      const key = page.locator(`button[aria-label="${labelFor(ch)}"]:visible`).first();
      await key.waitFor({ state: "visible", timeout: 10_000 });
      await key.click();
    }
  }
  const addNote = page.getByRole("button", { name: /add a note/i }).first();
  if (await addNote.isVisible({ timeout: 1_000 }).catch(() => false)) await addNote.click({ force: true });
  const noteInput = page.locator('input[aria-label="Payment note"], input[placeholder="What is this for?"]').first();
  if (await noteInput.isVisible({ timeout: 2_000 }).catch(() => false)) await safeFill(noteInput, note);
  await snap(page, "send-amount-note-filled");

  await page.locator("main button:visible:not([disabled])").filter({ hasText: /^(Continue|Review|Next|Send)/i }).last().click();
  await page.waitForURL(/\/app\/send\/confirm/, { timeout: 15_000 }).catch(() => undefined);
  await snap(page, "send-confirm-ready");
  await page
    .locator("main button")
    .filter({ hasText: /Confirm.*Send|Send to stealth|Continue stealth send|^Send/i })
    .last()
    .click();

  const clicks = await drainRabbyPopups(ctx, extId, known, "send", 5);
  await Promise.race([
    page.locator('a[href*="/tx/0x"], text=/Payment sent|Total Balance|transactions/i').first().waitFor({ timeout: 120_000 }),
    page.waitForTimeout(120_000),
  ]).catch(() => undefined);
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  await snap(page, "send-after-popups");
  return { note, clicks, uiState: text.slice(0, 500) };
}

async function waitForHistoryNote(page: Page, note: string): Promise<boolean> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await page.goto(`${VERCEL_URL}/app/history`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    const body = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    await snap(page, `history-check-${Date.now()}`);
    if (body.includes(note)) return true;
    await page.waitForTimeout(12_000);
  }
  return false;
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(RABBY_PROFILE_DIR)) {
    throw new Error("Rabby extension or profile missing");
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`QA live send proof · ${CHAIN_NAME} · ${SENDER} -> ${RECIPIENT} · ${VERCEL_URL}`);

  const ctx = await chromium.launchPersistentContext(RABBY_PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
    args: [
      `--disable-extensions-except=${RABBY_EXT_DIR}`,
      `--load-extension=${RABBY_EXT_DIR}`,
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });

  let extId = "";
  for (let i = 0; i < 40; i++) {
    const sw = ctx.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (sw) {
      extId = sw.url().split("/")[2];
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!extId) throw new Error("Rabby service worker did not register");

  const rabbyPage = await ctx.newPage();
  await rabbyPage.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabbyPage.waitForTimeout(2_000);
  await unlockRabby(rabbyPage, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(rabbyPage);
  const known = new Set<Page>(ctx.pages());
  const page = await ctx.newPage();

  const senderAddress = accountByPersona[SENDER];
  const beforeNonce = await publicClient.getTransactionCount({ address: senderAddress, blockTag: "pending" });
  let note = "";
  let clicks = 0;
  let uiState = "";
  let historyUpdated = false;
  let hits: TxHit[] = [];
  try {
    await switchRabbyAccount(rabbyPage, extId, SENDER);
    await ensureDappAccount(page, ctx, extId, known, SENDER);
    await snap(page, "dashboard-before-send");
    const driven = await driveSend(page, ctx, extId, known);
    note = driven.note;
    clicks = driven.clicks;
    uiState = driven.uiState;
    hits = await txsFrom(senderAddress, beforeNonce);
    historyUpdated = await waitForHistoryNote(page, note);
    await snap(page, "history-final");
  } finally {
    await ctx.close().catch(() => undefined);
  }

  const status = hits.length > 0 && hits.every((h) => h.status === "success") ? "green" : "red";
  const md = [
    "# QA live send proof",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${VERCEL_URL}`,
    `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
    `Sender: ${SENDER} (${senderAddress})`,
    `Recipient: ${RECIPIENT}`,
    `Rabby CTA clicks: ${clicks}`,
    `Before nonce: ${beforeNonce}`,
    `Status: ${status}`,
    "",
    "## Chain transactions",
    "",
    hits.length
      ? hits.map((h) => `- nonce ${h.nonce}, ${h.to ?? "contract creation"}, ${h.status}: [${h.hash}](${EXPLORER_URL}/tx/${h.hash})`).join("\n")
      : "- none found",
    "",
    "## UI truth checks",
    "",
    `- Unique note: ${note || "-"}`,
    `- History note visible after refresh: ${historyUpdated ? "yes" : "no"}`,
    `- Post-popup UI text sample: ${uiState.replace(/\|/g, "/") || "-"}`,
    "",
    "## Screenshots",
    "",
    `- Output dir: ${OUT}`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
