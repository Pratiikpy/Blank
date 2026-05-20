import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Hash } from "viem";
import { baseSepolia, sepolia } from "viem/chains";

import {
  unlockRabby,
  dismissRabbyWhatsNew,
  waitAndConfirmRabbyPopup,
  confirmRabbyPopup,
} from "../../fixtures/rabby/rabby-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://blank-omega-jade.vercel.app";
const SOURCE_PROFILE = process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111) throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
const IS_ETH = CHAIN_ID === 11155111;
const CHAIN_NAME = IS_ETH ? "Ethereum Sepolia" : "Base Sepolia";
const RPC_URL = IS_ETH ? "https://ethereum-sepolia.publicnode.com" : "https://base-sepolia-rpc.publicnode.com";
const EXPLORER_URL = IS_ETH ? "https://sepolia.etherscan.io" : "https://sepolia.basescan.org";
const BLOCKSCOUT_URL = IS_ETH ? "https://eth-sepolia.blockscout.com" : "https://base-sepolia.blockscout.com";
const OUT = resolve(REPO, `packages/app/test-results/qa-live-outcome-payments-${IS_ETH ? "eth" : "base"}`);
const PROFILE_ROOT = resolve(OUT, "profiles");

const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;
const BOB = "0x0D1883c48E14d733D464478f53706D92b7648b9d" as Address;
type Persona = "Dave" | "Bob";
const accountByPersona: Record<Persona, Address> = { Dave: DAVE, Bob: BOB };
const labelByPersona: Record<Persona, string> = { Dave: "Private Key 1", Bob: "Private Key 2" };

const publicClient = createPublicClient({
  chain: IS_ETH ? sepolia : baseSepolia,
  transport: http(RPC_URL),
});

type Result = {
  name: string;
  status: "green" | "red";
  detail: string;
  hashes: Hash[];
  screenshot?: string;
};

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
  await loc.type(value, { delay: 25 });
  await loc.press("Tab").catch(() => undefined);
}

function cloneProfile(persona: Persona): string {
  const target = resolve(PROFILE_ROOT, persona.toLowerCase());
  if (existsSync(target)) return target;
  mkdirSync(PROFILE_ROOT, { recursive: true });
  cpSync(SOURCE_PROFILE, target, {
    recursive: true,
    force: true,
    filter: (src) => !/[\\/]Singleton/.test(src) && !/[\\/]lockfile$/i.test(src),
  });
  return target;
}

async function launchPersona(persona: Persona): Promise<{ ctx: BrowserContext; home: Page; extId: string; page: Page; known: Set<Page> }> {
  const ctx = await chromium.launchPersistentContext(cloneProfile(persona), {
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
  if (!extId) throw new Error(`Rabby service worker did not register for ${persona}`);
  const home = await ctx.newPage();
  await home.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await home.waitForTimeout(2_000);
  await unlockRabby(home, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(home);
  await switchRabbyAccount(home, extId, persona);
  const known = new Set<Page>(ctx.pages());
  const page = await ctx.newPage();
  await ensureDappAccount(page, ctx, extId, known, persona);
  return { ctx, home, extId, page, known };
}

async function switchRabbyAccount(rabbyPage: Page, extId: string, persona: Persona): Promise<void> {
  const target = labelByPersona[persona];
  const expected = accountByPersona[persona].toLowerCase();
  await rabbyPage.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabbyPage.waitForTimeout(1_500);
  await dismissRabbyWhatsNew(rabbyPage);
  const body = ((await rabbyPage.locator("body").textContent().catch(() => "")) ?? "").toLowerCase();
  if (body.includes(expected.slice(0, 8)) || body.includes(expected.slice(0, 6))) return;
  const current = rabbyPage.locator("text=/Private Key \\d|Seed Phrase/i").first();
  if (await current.isVisible({ timeout: 5_000 }).catch(() => false)) await current.click({ force: true }).catch(() => undefined);
  else await rabbyPage.mouse.click(130, 95);
  await rabbyPage.waitForTimeout(1_500);
  const rows = rabbyPage.locator("div, button").filter({ hasText: new RegExp(target, "i") });
  const count = await rows.count().catch(() => 0);
  if (count === 0) throw new Error(`Rabby account row not found for ${target}`);
  const row = rows.nth(Math.max(0, count - 1));
  const box = await row.boundingBox({ timeout: 5_000 }).catch(() => null);
  if (box) await rabbyPage.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 38));
  else await row.click({ force: true });
  await rabbyPage.waitForTimeout(2_500);
}

async function drainRabbyPopups(ctx: BrowserContext, extId: string, known: Set<Page>, label: string, maxPopups = 5): Promise<number> {
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

async function ensureDappAccount(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>, persona: Persona): Promise<void> {
  const expected = accountByPersona[persona].toLowerCase();
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  for (let i = 0; i < 4; i++) {
    const next = page.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 1_000 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(700);
  }
  const card = page.locator('[data-testid="wallet-choice-existing"]').first();
  if (await card.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await card.locator("button").filter({ hasText: /Rabby/i }).first().click({ force: true });
    await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `connect-${persona.toLowerCase()}`, 45_000, { chainName: CHAIN_NAME });
    await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `siwe-${persona.toLowerCase()}`, 25_000);
  }
  await page.evaluate(async (chainIdHex) => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
    if (eth) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] }).catch(() => undefined);
  }, `0x${CHAIN_ID.toString(16)}`);
  await drainRabbyPopups(ctx, extId, known, `switch-chain-${persona.toLowerCase()}`, 2);
  const after = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string[]> } }).ethereum;
    if (!eth) return [];
    return await eth.request({ method: "eth_accounts" }).catch(() => []);
  });
  if (!after.map((x) => x.toLowerCase()).includes(expected)) throw new Error(`${persona} dApp account mismatch: ${after.join(", ")}`);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Total Balance|FHE Protected|Dashboard|Payment Requests/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await snap(page, `${persona.toLowerCase()}-connected`);
}

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

async function waitForBody(page: Page, pattern: RegExp, label: string, timeoutMs = 180_000, refreshUrl?: string): Promise<{ ok: boolean; text: string; screenshot: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (refreshUrl) {
      await page.goto(refreshUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(3_000);
    const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (pattern.test(text)) return { ok: true, text: text.slice(0, 400), screenshot: await snap(page, label) };
    await page.waitForTimeout(7_000);
  }
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return { ok: false, text: text.slice(0, 400), screenshot: await snap(page, `${label}-red`) };
}

async function openOutgoingTab(page: Page): Promise<void> {
  await page.locator("h1").filter({ hasText: /Payment Requests/i }).first().waitFor({ state: "visible", timeout: 30_000 });
  const outgoing = page.getByRole("button", { name: "Outgoing" }).first();
  await outgoing.waitFor({ state: "visible", timeout: 30_000 });
  await outgoing.click({ force: true, timeout: 10_000 }).catch(async () => {
    await outgoing.evaluate((el) => (el as HTMLButtonElement).click());
  });
  await page.waitForFunction(() => {
    const body = document.body?.innerText ?? "";
    return !/No incoming requests|Requests for you to pay/i.test(body);
  }, undefined, { timeout: 10_000 }).catch(async () => {
    await outgoing.evaluate((el) => (el as HTMLButtonElement).click()).catch(() => undefined);
    await page.waitForTimeout(1_500);
  });
}

async function waitForOutgoingRequest(page: Page, pattern: RegExp, label: string, timeoutMs = 180_000): Promise<{ ok: boolean; text: string; screenshot: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.goto(`${VERCEL_URL}/app/requests`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await openOutgoingTab(page);
    await page.waitForTimeout(3_000);
    const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (pattern.test(text)) return { ok: true, text: text.slice(0, 400), screenshot: await snap(page, label) };
    await page.waitForTimeout(7_000);
  }
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return { ok: false, text: text.slice(0, 400), screenshot: await snap(page, `${label}-red`) };
}

async function waitForIncomingRequestGone(page: Page, note: string, label: string, timeoutMs = 180_000): Promise<{ ok: boolean; text: string; screenshot: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.goto(`${VERCEL_URL}/app/requests`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (!text.includes(note)) return { ok: true, text: text.slice(0, 400), screenshot: await snap(page, label) };
    await page.waitForTimeout(7_000);
  }
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return { ok: false, text: text.slice(0, 400), screenshot: await snap(page, `${label}-red`) };
}

async function createRequest(dave: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> }, note: string): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  await dave.page.goto(`${VERCEL_URL}/app/requests`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dave.page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await dave.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await dave.page.locator("text=/Payment Requests|Request/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await dave.page.locator("button:visible:not([disabled])").filter({ hasText: /^(\+\s*)?Request$/i }).first().click();
  await safeFill(dave.page.locator('input[placeholder*="0x"][placeholder*="pay" i]').first(), BOB);
  await safeFill(dave.page.locator('input[placeholder="0.00"]').first(), "0.01");
  await safeFill(dave.page.locator("textarea").first(), note);
  await snap(dave.page, "request-create-filled");
  await dave.page.locator("button:visible:not([disabled])").filter({ hasText: /^Send Request$/i }).last().click();
  await drainRabbyPopups(dave.ctx, dave.extId, dave.known, "request-create", 4);
  await waitForOutgoingRequest(dave.page, new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "request-dave-created", 120_000);
  return await txsFrom(DAVE, before);
}

async function payRequest(bob: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> }, note: string): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: BOB, blockTag: "pending" });
  await bob.page.goto(`${VERCEL_URL}/app/requests`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await bob.page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await bob.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await bob.page.locator("text=/Payment Requests|Incoming/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await waitForBody(bob.page, new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "request-bob-incoming", 180_000, `${VERCEL_URL}/app/requests`);
  const row = bob.page.locator("div, article, li").filter({ hasText: note }).first();
  await row.locator("button:visible:not([disabled])").filter({ hasText: /^Pay$/i }).first().click();
  await safeFill(bob.page.locator('input[placeholder="0.00"]').last(), "0.01");
  await snap(bob.page, "request-bob-pay-filled");
  await bob.page.locator("button:visible:not([disabled])").filter({ hasText: /^Pay Now$/i }).last().click();
  await drainRabbyPopups(bob.ctx, bob.extId, bob.known, "request-pay", 5);
  await waitForIncomingRequestGone(bob.page, note, "request-bob-paid-removed-from-incoming", 180_000);
  return await txsFrom(BOB, before);
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(SOURCE_PROFILE)) throw new Error("Rabby extension or source profile missing");
  mkdirSync(OUT, { recursive: true });
  console.log(`QA outcome payments · ${CHAIN_NAME} · ${VERCEL_URL}`);

  const results: Result[] = [];
  const dave = await launchPersona("Dave");
  const bob = await launchPersona("Bob");
  try {
    const note = `QA request payback ${CHAIN_NAME} ${Date.now()}`;
    const createHashes = await createRequest(dave, note);
    const payHashes = await payRequest(bob, note);
    const escapedNote = note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const daveFinal = await waitForOutgoingRequest(dave.page, new RegExp(`${escapedNote}.*fulfilled|fulfilled.*${escapedNote}`, "i"), "request-dave-fulfilled", 180_000);
    results.push({
      name: "Payment Request create -> payer pays -> requester sees fulfilled",
      status: createHashes.length > 0 && payHashes.length > 0 && daveFinal.ok ? "green" : "red",
      hashes: [...createHashes, ...payHashes],
      detail: `note=${note}; daveFinal=${daveFinal.ok}; createTxs=${createHashes.length}; payTxs=${payHashes.length}`,
      screenshot: daveFinal.screenshot,
    });
  } finally {
    await bob.ctx.close().catch(() => undefined);
    await dave.ctx.close().catch(() => undefined);
  }

  const md = [
    "# QA outcome payments",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${VERCEL_URL}`,
    `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
    "",
    "| Flow | Status | Tx hashes | Detail |",
    "|---|---|---|---|",
    ...results.map((r) => {
      const hashes = r.hashes.length ? r.hashes.map((h) => `[${h.slice(0, 10)}...](${EXPLORER_URL}/tx/${h})`).join("<br>") : "-";
      return `| ${r.name} | ${r.status} | ${hashes} | ${r.detail.replace(/\|/g, "/")} |`;
    }),
    "",
    `Output dir: ${OUT}`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(md);
  if (results.some((r) => r.status !== "green")) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
