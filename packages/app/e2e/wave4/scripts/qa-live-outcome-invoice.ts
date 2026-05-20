import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Address, type Hash } from "viem";
import { baseSepolia, sepolia } from "viem/chains";

import {
  confirmRabbyPopup,
  dismissRabbyWhatsNew,
  unlockRabby,
  waitAndConfirmRabbyPopup,
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
const MODE =
  process.env.MODE === "escrow" ||
  process.env.MODE === "payroll" ||
  process.env.MODE === "creator" ||
  process.env.MODE === "p2p"
    ? process.env.MODE
    : "invoice";
const IS_ETH = CHAIN_ID === 11155111;
const CHAIN_NAME = IS_ETH ? "Ethereum Sepolia" : "Base Sepolia";
const RPC_URL = IS_ETH ? "https://ethereum-sepolia.publicnode.com" : "https://base-sepolia-rpc.publicnode.com";
const EXPLORER_URL = IS_ETH ? "https://sepolia.etherscan.io" : "https://sepolia.basescan.org";
const BLOCKSCOUT_URL = IS_ETH ? "https://eth-sepolia.blockscout.com" : "https://base-sepolia.blockscout.com";
const OUT = resolve(REPO, `packages/app/test-results/qa-live-outcome-${MODE}-${IS_ETH ? "eth" : "base"}`);
const PROFILE_ROOT = resolve(OUT, "profiles");

const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;
const BOB = "0x0D1883c48E14d733D464478f53706D92b7648b9d" as Address;
const CAROL = "0x54488ad8d58f9147c1a99673ef8743608cd1b526" as Address;
type Persona = "Dave" | "Bob" | "Carol";
const accountByPersona: Record<Persona, Address> = { Dave: DAVE, Bob: BOB, Carol: CAROL };
const labelByPersona: Record<Persona, string> = { Dave: "Private Key 1", Bob: "Private Key 2", Carol: "Seed Phrase 1 #1" };

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
      : await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `${label}-${i + 1}`, 60_000);
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
  await page.locator("text=/Total Balance|FHE Protected|Dashboard|Business Tools/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await snap(page, `${persona.toLowerCase()}-connected`);
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

async function openBusiness(page: Page): Promise<void> {
  await page.goto(`${VERCEL_URL}/app/business`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: /Business Tools/i }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("tab", { name: "Invoices" }).click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(2_000);
}

async function waitForInvoiceRow(page: Page, note: string, status: RegExp, label: string, timeoutMs = 180_000): Promise<{ ok: boolean; text: string; screenshot: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await openBusiness(page);
    const rowText = await page.evaluate(
      ({ note, source, flags }) => {
        const status = new RegExp(source, flags);
        const rows = Array.from(document.querySelectorAll("div"))
          .map((el) => (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? "")
          .filter((text) => text.includes(note) && status.test(text))
          .sort((a, b) => a.length - b.length);
        return rows[0] ?? "";
      },
      { note, source: status.source, flags: status.flags },
    );
    if (rowText) return { ok: true, text: rowText.slice(0, 500), screenshot: await snap(page, label) };
    await page.waitForTimeout(8_000);
  }
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return { ok: false, text: text.slice(0, 500), screenshot: await snap(page, `${label}-red`) };
}

async function findInvoiceId(page: Page, note: string): Promise<number> {
  const row = page.locator("div").filter({ hasText: note }).filter({ hasText: /pending/i }).first();
  const link = row.locator('[data-testid^="invoice-preview-"]').first();
  await link.waitFor({ state: "attached", timeout: 60_000 });
  const testId = await link.getAttribute("data-testid");
  const id = Number(testId?.match(/invoice-preview-(\d+)/)?.[1]);
  if (!Number.isInteger(id)) throw new Error(`Could not read invoice id from ${testId}`);
  return id;
}

async function createInvoice(dave: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> }, note: string): Promise<{ invoiceId: number; hashes: Hash[] }> {
  const before = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  await openBusiness(dave.page);
  await dave.page.getByRole("button", { name: /New Invoice/i }).click({ force: true });
  await safeFill(dave.page.locator('input[placeholder="0x..."]').first(), BOB);
  await safeFill(dave.page.locator('input[placeholder="0.00"]').first(), "0.001");
  await safeFill(dave.page.locator('input[placeholder="Services rendered"]').first(), note);
  await snap(dave.page, "invoice-create-filled");
  await dave.page.getByRole("button", { name: /^Create Invoice$/i }).click({ force: true });
  await drainRabbyPopups(dave.ctx, dave.extId, dave.known, "invoice-create", 5);
  const created = await waitForInvoiceRow(dave.page, note, /pending/i, "invoice-dave-created");
  if (!created.ok) throw new Error(`Dave did not see created invoice: ${created.text}`);
  const invoiceId = await findInvoiceId(dave.page, note);
  const preview = await dave.page.goto(`${VERCEL_URL}/app/invoice/${CHAIN_ID}/${invoiceId}`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
  void preview;
  await dave.page.waitForTimeout(4_000);
  await snap(dave.page, "invoice-public-preview");
  return { invoiceId, hashes: await txsFrom(DAVE, before) };
}

async function payInvoice(bob: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> }, note: string, invoiceId: number): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: BOB, blockTag: "pending" });
  const incoming = await waitForInvoiceRow(bob.page, note, /pending/i, "invoice-bob-incoming", 180_000);
  if (!incoming.ok) throw new Error(`Bob did not see pending invoice: ${incoming.text}`);
  const row = bob.page.locator("div").filter({ hasText: note }).filter({ hasText: /pending/i }).first();
  await row.getByRole("button", { name: /^Pay$/i }).click({ force: true });
  await safeFill(bob.page.locator('input[placeholder="0.00"]').last(), "0.001");
  await snap(bob.page, "invoice-bob-pay-filled");
  await bob.page.getByRole("button", { name: /^Pay$/i }).last().click({ force: true });
  await drainRabbyPopups(bob.ctx, bob.extId, bob.known, "invoice-pay", 5);
  const paymentPending = await waitForInvoiceRow(bob.page, note, /payment_pending/i, "invoice-bob-payment-pending", 240_000);
  if (!paymentPending.ok) throw new Error(`Bob did not see payment_pending invoice: ${paymentPending.text}`);
  const pendingRow = bob.page.locator("div").filter({ hasText: note }).filter({ hasText: /payment_pending/i }).first();
  await pendingRow.getByRole("button", { name: /^Finalize$/i }).first().click({ force: true });
  await drainRabbyPopups(bob.ctx, bob.extId, bob.known, "invoice-finalize", 5);
  const paid = await waitForInvoiceRow(bob.page, note, /paid/i, "invoice-bob-paid", 300_000);
  if (!paid.ok) throw new Error(`Bob did not see paid invoice #${invoiceId}: ${paid.text}`);
  return await txsFrom(BOB, before);
}

async function finalizeExistingInvoice(bob: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> }, note: string, invoiceId: number): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: BOB, blockTag: "pending" });
  const paymentPending = await waitForInvoiceRow(bob.page, note, /payment_pending/i, "invoice-bob-payment-pending-recover", 180_000);
  if (!paymentPending.ok) throw new Error(`Bob did not see recoverable payment_pending invoice #${invoiceId}: ${paymentPending.text}`);
  const pendingRow = bob.page.locator("div").filter({ hasText: note }).filter({ hasText: /payment_pending/i }).first();
  await pendingRow.getByRole("button", { name: /^Finalize$/i }).first().click({ force: true });
  await drainRabbyPopups(bob.ctx, bob.extId, bob.known, "invoice-finalize", 5);
  const paid = await waitForInvoiceRow(bob.page, note, /paid/i, "invoice-bob-paid", 300_000);
  if (!paid.ok) throw new Error(`Bob did not see paid invoice #${invoiceId}: ${paid.text}`);
  return await txsFrom(BOB, before);
}

async function openEscrow(page: Page): Promise<void> {
  await openBusiness(page);
  await page.getByRole("tab", { name: "Escrow" }).click({ force: true });
  await page.waitForTimeout(2_000);
}

async function openPayroll(page: Page): Promise<void> {
  await openBusiness(page);
  await page.getByRole("tab", { name: "Payroll" }).click({ force: true });
  await page.waitForTimeout(2_000);
}

async function waitForEscrowCard(page: Page, note: string, status: RegExp, label: string, timeoutMs = 180_000): Promise<{ ok: boolean; text: string; screenshot: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await openEscrow(page);
    const cardText = await page.evaluate(
      ({ note, source, flags }) => {
        const status = new RegExp(source, flags);
        const rows = Array.from(document.querySelectorAll("div"))
          .map((el) => (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? "")
          .filter((text) => text.includes(note) && status.test(text))
          .sort((a, b) => a.length - b.length);
        return rows[0] ?? "";
      },
      { note, source: status.source, flags: status.flags },
    );
    if (cardText) return { ok: true, text: cardText.slice(0, 500), screenshot: await snap(page, label) };
    await page.waitForTimeout(8_000);
  }
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return { ok: false, text: text.slice(0, 500), screenshot: await snap(page, `${label}-red`) };
}

async function createEscrow(dave: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> }, note: string): Promise<{ escrowId: number | null; hashes: Hash[] }> {
  const before = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  await openEscrow(dave.page);
  await dave.page.getByRole("button", { name: /New Escrow/i }).click({ force: true });
  await safeFill(dave.page.locator('input[placeholder="0x..."]').first(), BOB);
  await safeFill(dave.page.locator('input[placeholder="0.00"]').first(), "0.001");
  await safeFill(dave.page.locator('input[placeholder="Project milestone"]').first(), note);
  await snap(dave.page, "escrow-create-filled");
  await dave.page.getByRole("button", { name: /^Create Escrow$/i }).click({ force: true });
  await drainRabbyPopups(dave.ctx, dave.extId, dave.known, "escrow-create", 6);
  const created = await waitForEscrowCard(dave.page, note, /active/i, "escrow-dave-created", 240_000);
  if (!created.ok) throw new Error(`Dave did not see created escrow: ${created.text}`);
  const idMatch = created.text.match(/#(\d+)/);
  return { escrowId: idMatch ? Number(idMatch[1]) : null, hashes: await txsFrom(DAVE, before) };
}

async function clickEscrowAction(page: Page, note: string, action: RegExp): Promise<void> {
  const card = page.locator("div").filter({ hasText: note }).filter({ hasText: /active|released|disputed/i }).first();
  await card.getByRole("button", { name: action }).first().click({ force: true });
}

async function deliverAndReleaseEscrow(
  dave: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> },
  bob: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> },
  note: string,
): Promise<Hash[]> {
  const beforeBob = await publicClient.getTransactionCount({ address: BOB, blockTag: "pending" });
  const bobSeen = await waitForEscrowCard(bob.page, note, /active/i, "escrow-bob-active", 180_000);
  if (!bobSeen.ok) throw new Error(`Bob did not see active escrow: ${bobSeen.text}`);
  await clickEscrowAction(bob.page, note, /^Release Funds$/i);
  await drainRabbyPopups(bob.ctx, bob.extId, bob.known, "escrow-mark-delivered", 5);
  await waitForEscrowCard(bob.page, note, /active/i, "escrow-bob-delivered-still-active", 120_000);

  const beforeDave = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  const daveActive = await waitForEscrowCard(dave.page, note, /active/i, "escrow-dave-ready-release", 180_000);
  if (!daveActive.ok) throw new Error(`Dave did not see active escrow for release: ${daveActive.text}`);
  await clickEscrowAction(dave.page, note, /^Release Funds$/i);
  await drainRabbyPopups(dave.ctx, dave.extId, dave.known, "escrow-release", 5);
  const bobReleased = await waitForEscrowCard(bob.page, note, /released/i, "escrow-bob-released", 240_000);
  if (!bobReleased.ok) throw new Error(`Bob did not see released escrow: ${bobReleased.text}`);
  return [...(await txsFrom(BOB, beforeBob)), ...(await txsFrom(DAVE, beforeDave))];
}

async function runPayroll(
  dave: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> },
  noteLabel: string,
): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  await openPayroll(dave.page);
  await dave.page.getByRole("button", { name: /^Run Payroll$/i }).first().click({ force: true });
  await safeFill(dave.page.locator('textarea[placeholder*="0xabc"]').first(), `${BOB}, ${CAROL}`);
  await safeFill(dave.page.locator('textarea[placeholder*="5000"]').first(), "0.001, 0.001");
  await snap(dave.page, "payroll-filled");
  await dave.page.getByRole("button", { name: /^Run Payroll$/i }).last().click({ force: true });
  await drainRabbyPopups(dave.ctx, dave.extId, dave.known, "payroll-run", 6);
  await dave.page.evaluate((label) => localStorage.setItem("blank:qa:last_payroll_label", label), noteLabel).catch(() => undefined);
  return await txsFrom(DAVE, before);
}

async function waitForPayrollHistory(page: Page, label: string, timeoutMs = 180_000): Promise<{ ok: boolean; text: string; screenshot: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await openPayroll(page);
    const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (/Payroll History/i.test(text) && /Payroll from/i.test(text)) {
      return { ok: true, text: text.slice(0, 500), screenshot: await snap(page, label) };
    }
    await page.waitForTimeout(8_000);
  }
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return { ok: false, text: text.slice(0, 500), screenshot: await snap(page, `${label}-red`) };
}

async function openCreators(page: Page): Promise<void> {
  await page.goto(`${VERCEL_URL}/app/creators`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: /Creator Support/i }).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(2_000);
}

async function ensureCreatorProfile(
  bob: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> },
  creatorName: string,
): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: BOB, blockTag: "pending" });
  await openCreators(bob.page);
  const body = ((await bob.page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  if (!body.includes(creatorName)) {
    const setup = bob.page.getByRole("button", { name: /Set Up Profile/i }).first();
    if (await setup.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await setup.click({ force: true });
      await safeFill(bob.page.locator('input[placeholder="Your name"]').first(), creatorName);
      await safeFill(bob.page.locator('input[placeholder="Bio (optional)"]').first(), `QA creator profile ${CHAIN_NAME}`);
      await snap(bob.page, "creator-bob-profile-filled");
      await bob.page.getByRole("button", { name: /^Create Profile$/i }).click({ force: true });
      await drainRabbyPopups(bob.ctx, bob.extId, bob.known, "creator-profile", 5);
    }
  }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await openCreators(bob.page);
    const text = ((await bob.page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (text.includes(creatorName) || /Your Creator Profile/i.test(text)) {
      await snap(bob.page, "creator-bob-profile");
      return await txsFrom(BOB, before);
    }
    await bob.page.waitForTimeout(8_000);
  }
  throw new Error(`Bob creator profile did not appear: ${creatorName}`);
}

async function supportCreator(
  dave: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> },
  bob: { page: Page },
  creatorName: string,
  message: string,
): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  await openCreators(dave.page);
  const search = dave.page.locator('input[placeholder="Search creators by name or bio..."]').first();
  if (await search.isVisible({ timeout: 10_000 }).catch(() => false)) await safeFill(search, creatorName);
  const creatorCard = dave.page.locator(`[data-creator-address="${BOB.toLowerCase()}"]`).first();
  await creatorCard.waitFor({ state: "visible", timeout: 60_000 });
  await creatorCard.getByRole("button", { name: /Support|Selected/i }).click({ force: true });
  await dave.page.getByRole("button", { name: /Supporter/i }).first().click({ force: true });
  await safeFill(dave.page.locator('textarea[placeholder="Say something nice..."]').first(), message);
  await snap(dave.page, "creator-dave-tip-filled");
  await dave.page.getByRole("button", { name: /Send \$5 Support/i }).click({ force: true });
  await drainRabbyPopups(dave.ctx, dave.extId, dave.known, "creator-tip", 6);

  const daveDeadline = Date.now() + 180_000;
  while (Date.now() < daveDeadline) {
    await openCreators(dave.page);
    const text = ((await dave.page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (text.includes(message) || /My Supported Creators.*1 Supported/i.test(text)) {
      await snap(dave.page, "creator-dave-supported");
      break;
    }
    await dave.page.waitForTimeout(8_000);
  }

  const bobDeadline = Date.now() + 180_000;
  while (Date.now() < bobDeadline) {
    await openCreators(bob.page);
    const text = ((await bob.page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (text.includes(message) || text.includes(DAVE.slice(0, 6))) {
      await snap(bob.page, "creator-bob-supporter");
      return await txsFrom(DAVE, before);
    }
    await bob.page.waitForTimeout(8_000);
  }
  throw new Error("Bob did not see Dave in My Supporters after tip");
}

async function openP2P(page: Page): Promise<void> {
  await page.goto(`${VERCEL_URL}/app/swap?tab=p2p`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: /Exchange/i }).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(3_000);
}

async function waitForP2PText(page: Page, pattern: RegExp, label: string, timeoutMs = 180_000): Promise<{ ok: boolean; text: string; screenshot: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await openP2P(page);
    const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (pattern.test(text)) return { ok: true, text: text.slice(0, 600), screenshot: await snap(page, label) };
    await page.waitForTimeout(8_000);
  }
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return { ok: false, text: text.slice(0, 600), screenshot: await snap(page, `${label}-red`) };
}

async function createP2POffer(dave: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> }): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  await openP2P(dave.page);
  await safeFill(dave.page.getByLabel("Amount you give").first(), "0.001");
  await safeFill(dave.page.getByLabel("Amount you want").first(), "0.001");
  await snap(dave.page, "p2p-create-filled");
  await dave.page.getByRole("button", { name: /^Create Swap Offer$/i }).click({ force: true });
  await drainRabbyPopups(dave.ctx, dave.extId, dave.known, "p2p-create", 6);
  const created = await waitForP2PText(dave.page, /My Open Offers|Offering 0\.001 USDC for 0\.001 USDT|0\.001 USDC.*0\.001 USDT/i, "p2p-dave-open", 240_000);
  if (!created.ok) throw new Error(`Dave did not see open P2P offer: ${created.text}`);
  return await txsFrom(DAVE, before);
}

async function fillP2POffer(
  bob: { page: Page; ctx: BrowserContext; extId: string; known: Set<Page> },
  dave: { page: Page },
): Promise<Hash[]> {
  const before = await publicClient.getTransactionCount({ address: BOB, blockTag: "pending" });
  const available = await waitForP2PText(bob.page, /Available Offers|0\.001 USDC.*0\.001 USDT|0\.001 USDC.*0\.001/i, "p2p-bob-available", 240_000);
  if (!available.ok) throw new Error(`Bob did not see Dave's P2P offer: ${available.text}`);
  const offerRow = bob.page.locator("div").filter({ hasText: /0\.001 USDC/ }).filter({ hasText: /0\.001 USDT/ }).first();
  await offerRow.getByRole("button", { name: /^Fill Offer$/i }).first().click({ force: true });
  await drainRabbyPopups(bob.ctx, bob.extId, bob.known, "p2p-fill", 6);
  const bobFilled = await waitForP2PText(bob.page, /Recently Filled|Bought 0\.001 USDC for 0\.001 USDT|Offer #/i, "p2p-bob-filled", 300_000);
  if (!bobFilled.ok) throw new Error(`Bob did not see filled P2P offer: ${bobFilled.text}`);
  const daveFilled = await waitForP2PText(dave.page, /Recently Filled|Sold 0\.001 USDC for 0\.001 USDT|Offer #/i, "p2p-dave-filled", 240_000);
  if (!daveFilled.ok) throw new Error(`Dave did not see filled P2P offer: ${daveFilled.text}`);
  return await txsFrom(BOB, before);
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(SOURCE_PROFILE)) throw new Error("Rabby extension or source profile missing");
  mkdirSync(OUT, { recursive: true });
  console.log(`QA outcome ${MODE} · ${CHAIN_NAME} · ${VERCEL_URL}`);

  const results: Result[] = [];
  const dave = await launchPersona("Dave");
  const bob = await launchPersona("Bob");
  const carol = MODE === "payroll" ? await launchPersona("Carol") : null;
  try {
    if (MODE === "escrow") {
      const note = `QA escrow ${CHAIN_NAME} ${Date.now()}`;
      const created = await createEscrow(dave, note);
      const lifecycleHashes = await deliverAndReleaseEscrow(dave, bob, note);
      const daveReleased = await waitForEscrowCard(dave.page, note, /released/i, "escrow-dave-released", 240_000);
      results.push({
        name: "Escrow create -> beneficiary marks delivered -> depositor releases -> both see released",
        status: created.hashes.length > 0 && lifecycleHashes.length > 0 && daveReleased.ok ? "green" : "red",
        hashes: [...created.hashes, ...lifecycleHashes],
        detail: `escrowId=${created.escrowId ?? "unknown"}; note=${note}; daveReleased=${daveReleased.ok}`,
        screenshot: daveReleased.screenshot,
      });
    } else if (MODE === "payroll") {
      const note = `QA payroll ${CHAIN_NAME} ${Date.now()}`;
      const hashes = await runPayroll(dave, note);
      const daveHistory = await waitForPayrollHistory(dave.page, "payroll-dave-history", 180_000);
      const bobHistory = await waitForPayrollHistory(bob.page, "payroll-bob-history", 180_000);
      const carolHistory = carol ? await waitForPayrollHistory(carol.page, "payroll-carol-history", 180_000) : { ok: false, text: "carol not launched", screenshot: undefined };
      results.push({
        name: "Payroll fan-out -> Dave, Bob, Carol see payroll history",
        status: hashes.length > 0 && daveHistory.ok && bobHistory.ok && carolHistory.ok ? "green" : "red",
        hashes,
        detail: `note=${note}; daveHistory=${daveHistory.ok}; bobHistory=${bobHistory.ok}; carolHistory=${carolHistory.ok}`,
        screenshot: carolHistory.screenshot,
      });
    } else if (MODE === "creator") {
      const creatorName = `QA Bob Creator ${CHAIN_NAME}`;
      const message = `QA creator support ${Date.now()}`;
      const profileHashes = await ensureCreatorProfile(bob, creatorName);
      const tipHashes = await supportCreator(dave, bob, creatorName, message);
      results.push({
        name: "Creator profile -> supporter tips -> creator sees supporter",
        status: tipHashes.length > 0 ? "green" : "red",
        hashes: [...profileHashes, ...tipHashes],
        detail: `creator=${creatorName}; message=${message}; profileTxs=${profileHashes.length}; tipTxs=${tipHashes.length}`,
        screenshot: resolve(OUT, "creator-bob-supporter.png"),
      });
    } else if (MODE === "p2p") {
      const createHashes = await createP2POffer(dave);
      const fillHashes = await fillP2POffer(bob, dave);
      results.push({
        name: "P2P offer create -> other wallet fills -> both see filled",
        status: createHashes.length > 0 && fillHashes.length > 0 ? "green" : "red",
        hashes: [...createHashes, ...fillHashes],
        detail: `createTxs=${createHashes.length}; fillTxs=${fillHashes.length}`,
        screenshot: resolve(OUT, "p2p-dave-filled.png"),
      });
    } else {
      const recoverNote = process.env.RECOVER_NOTE;
    const note = recoverNote ?? `QA invoice ${CHAIN_NAME} ${Date.now()}`;
    const created = recoverNote
      ? {
          invoiceId: Number(process.env.RECOVER_INVOICE_ID),
          hashes: (process.env.RECOVER_CREATE_HASHES ?? "").split(",").filter(Boolean) as Hash[],
        }
      : await createInvoice(dave, note);
    if (!Number.isInteger(created.invoiceId)) throw new Error("RECOVER_INVOICE_ID is required for recovery mode");
    const bobHashes = recoverNote
      ? [
          ...((process.env.RECOVER_PAY_HASHES ?? "").split(",").filter(Boolean) as Hash[]),
          ...(await finalizeExistingInvoice(bob, note, created.invoiceId)),
        ]
      : await payInvoice(bob, note, created.invoiceId);
    const davePaid = await waitForInvoiceRow(dave.page, note, /paid/i, "invoice-dave-paid", 240_000);
    results.push({
      name: "Invoice create -> client pays -> client finalizes -> both see paid",
      status: created.hashes.length > 0 && bobHashes.length > 0 && davePaid.ok ? "green" : "red",
      hashes: [...created.hashes, ...bobHashes],
      detail: `invoiceId=${created.invoiceId}; note=${note}; davePaid=${davePaid.ok}`,
      screenshot: davePaid.screenshot,
    });
    }
  } finally {
    await carol?.ctx.close().catch(() => undefined);
    await bob.ctx.close().catch(() => undefined);
    await dave.ctx.close().catch(() => undefined);
  }

  const md = [
    `# QA outcome ${MODE}`,
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
