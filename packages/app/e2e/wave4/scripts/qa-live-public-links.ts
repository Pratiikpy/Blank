import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://www.myblank.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PROFILE_DIR = process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
const IS_ETH = CHAIN_ID === 11155111;
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111) throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
const CHAIN_NAME = IS_ETH ? "Ethereum Sepolia" : "Base Sepolia";
const RPC_URL = IS_ETH ? "https://ethereum-sepolia.publicnode.com" : "https://sepolia.base.org";
const EXPLORER_URL = IS_ETH ? "https://sepolia.etherscan.io" : "https://sepolia.basescan.org";
const OUT = resolve(REPO, `packages/app/test-results/qa-live-public-links-${IS_ETH ? "eth" : "base"}`);
const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;
const BOB = "0x0D1883c48E14d733D464478f53706D92b7648b9d" as Address;
const CAROL = "0x54488ad8d58f9147c1a99673ef8743608cd1b526" as Address;

const publicClient = createPublicClient({
  chain: IS_ETH ? sepolia : baseSepolia,
  transport: http(RPC_URL),
});

type Persona = "Dave" | "Bob" | "Carol";
type FlowResult = {
  name: string;
  status: "green" | "red";
  url?: string;
  hashes: Hash[];
  note: string;
  screenshot?: string;
};

const accountByPersona: Record<Persona, Address> = { Dave: DAVE, Bob: BOB, Carol: CAROL };
const labelByPersona: Record<Persona, string[]> = {
  Dave: ["Private Key 1", "Seed Phrase 1 #1"],
  Bob: ["Private Key 2", "Seed Phrase 1 #2"],
  Carol: ["Private Key 3", "Seed Phrase 1 #3", "Seed Phrase 1 #1"],
};
const results: FlowResult[] = [];

async function snap(page: Page, label: string): Promise<string> {
  const path = resolve(OUT, `${label}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  return path;
}

async function safeFill(loc: Locator, value: string): Promise<void> {
  await loc.waitFor({ state: "visible", timeout: 30_000 });
  await loc.click({ timeout: 5_000 }).catch(() => undefined);
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
  maxPopups = 4,
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

async function txHashesFrom(address: Address, fromNonce: number): Promise<Hash[]> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const latest = await publicClient.getBlockNumber();
    const min = latest > 80n ? latest - 80n : 0n;
    const found: Array<{ nonce: number; hash: Hash }> = [];
    for (let n = latest; n >= min; n--) {
      const block = await publicClient.getBlock({ blockNumber: n, includeTransactions: true }).catch(() => null);
      if (!block) continue;
      for (const tx of block.transactions) {
        if (tx.from.toLowerCase() === address.toLowerCase() && tx.nonce >= fromNonce) {
          found.push({ nonce: tx.nonce, hash: tx.hash });
        }
      }
      if (n === 0n) break;
    }
    if (found.length > 0) {
      found.sort((a, b) => a.nonce - b.nonce);
      return found.map((x) => x.hash);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return [];
}

async function getNonce(address: Address): Promise<number> {
  return await publicClient.getTransactionCount({ address, blockTag: "pending" });
}

async function ensureWalletChain(
  page: Page,
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  persona: Persona,
): Promise<void> {
  const targetHex = `0x${CHAIN_ID.toString(16)}`;
  const current = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<string> } }).ethereum;
    if (!eth) return null;
    return await eth.request({ method: "eth_chainId" }).catch(() => null);
  });
  if (current?.toLowerCase() === targetHex.toLowerCase()) return;
  await page.evaluate(async (chainIdHex) => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
    if (!eth) throw new Error("window.ethereum missing");
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  }, targetHex).catch(() => undefined);
  await drainRabbyPopups(ctx, extId, known, `switch-chain-${persona.toLowerCase()}`, 2);
  const after = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<string> } }).ethereum;
    if (!eth) return null;
    return await eth.request({ method: "eth_chainId" }).catch(() => null);
  });
  if (after?.toLowerCase() !== targetHex.toLowerCase()) {
    throw new Error(`${persona} Rabby chain mismatch: expected ${targetHex}, got ${after ?? "null"}`);
  }
}

async function verifyWalletState(page: Page, rabbyPage: Page, extId: string, persona: Persona): Promise<string> {
  await switchRabbyAccount(rabbyPage, extId, persona);
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  const accounts = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<string[] | string> } }).ethereum;
    if (!eth) return { accounts: [], chainId: "" };
    const accounts = (await eth.request({ method: "eth_accounts" }).catch(() => [])) as string[];
    const chainId = (await eth.request({ method: "eth_chainId" }).catch(() => "")) as string;
    return { accounts, chainId };
  });
  const expected = accountByPersona[persona].toLowerCase();
  const hasAccount = accounts.accounts.map((x) => x.toLowerCase()).includes(expected);
  const expectedChain = `0x${CHAIN_ID.toString(16)}`;
  if (!hasAccount) throw new Error(`${persona} not active in dApp accounts: ${accounts.accounts.join(", ")}`);
  if (accounts.chainId.toLowerCase() !== expectedChain.toLowerCase()) {
    throw new Error(`${persona} wrong chain: ${accounts.chainId}, expected ${expectedChain}`);
  }
  await snap(page, `wallet-verified-${persona.toLowerCase()}`);
  return `${persona} ${accountByPersona[persona]} on ${CHAIN_NAME}`;
}

async function switchRabbyAccount(rabbyPage: Page, extId: string, persona: Persona): Promise<void> {
  const targets = labelByPersona[persona];
  const expected = accountByPersona[persona].toLowerCase();
  await rabbyPage.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabbyPage.waitForTimeout(1_500);
  await dismissRabbyWhatsNew(rabbyPage);

  const body = ((await rabbyPage.locator("body").textContent().catch(() => "")) ?? "").toLowerCase();
  if (body.includes(expected.slice(0, 8)) || body.includes(expected.slice(0, 6))) {
    return;
  }

  const current = rabbyPage.locator("text=/Private Key \\d|Seed Phrase/i").first();
  if (await current.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await current.click({ force: true }).catch(async () => {
      const bb = await current.boundingBox().catch(() => null);
      if (bb) await rabbyPage.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    });
  } else {
    await rabbyPage.mouse.click(130, 95);
  }
  await rabbyPage.waitForTimeout(1_500);
  await snap(rabbyPage, `rabby-account-menu-${persona.toLowerCase()}`);

  const shortAddress = `${expected.slice(0, 6)}...${expected.slice(-4)}`;
  let row = rabbyPage.locator("div, button").filter({ hasText: new RegExp(shortAddress.replace(".", "\\."), "i") }).last();
  let visible = await row.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!visible) {
    for (const target of targets) {
      const candidate = rabbyPage.locator("div, button").filter({ hasText: new RegExp(target, "i") }).last();
      visible = await candidate.isVisible({ timeout: 1_500 }).catch(() => false);
      if (visible) {
        row = candidate;
        break;
      }
    }
  }
  if (!visible) throw new Error(`Rabby account row not found for ${persona}: ${targets.join(", ")} / ${shortAddress}`);
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
  await ensureWalletChain(page, ctx, extId, known, persona);
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Total Balance|FHE Protected|Dashboard/i").first().waitFor({ state: "visible", timeout: 60_000 });
}

async function ensureShielded(
  page: Page,
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  persona: Persona,
  amount = "2",
): Promise<Hash[]> {
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Deposit to private wallet|Total Balance|FHE Protected/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(2_000);

  const depositSection = page.locator("section, div").filter({ hasText: /Deposit to private wallet/i }).first();
  if (!(await depositSection.isVisible({ timeout: 10_000 }).catch(() => false))) {
    await snap(page, `shield-${persona.toLowerCase()}-no-panel`);
    throw new Error(`Deposit panel not visible for ${persona}`);
  }
  await safeFill(depositSection.locator('input[placeholder="0.00"]').first(), amount);
  await snap(page, `shield-${persona.toLowerCase()}-filled`);
  const before = await getNonce(accountByPersona[persona]);
  const button = depositSection.locator("button:visible:not([disabled])").filter({ hasText: /^Deposit/i }).first();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  await button.click();
  await drainRabbyPopups(ctx, extId, known, `shield-${persona.toLowerCase()}`, 4);
  await page.locator("text=/Shielding completed|Shielded|Recent Activity|Private balance/i").first().waitFor({ state: "visible", timeout: 180_000 }).catch(() => undefined);
  await snap(page, `shield-${persona.toLowerCase()}-final`);
  return await txHashesFrom(accountByPersona[persona], before);
}

async function createClaimLink(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<{ url: string; hashes: Hash[] }> {
  await page.goto(`${VERCEL_URL}/app/claim-link`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  const anyone = page.getByRole("button", { name: /Anyone\s+Open link/i }).first();
  if (await anyone.isVisible({ timeout: 5_000 }).catch(() => false)) await anyone.click({ force: true });
  await safeFill(page.locator('input[placeholder="10.00"], input[placeholder="0.00"]').first(), "0.1");
  await safeFill(page.locator('input[placeholder="Lunch tab"]').first(), `QA claim ${Date.now().toString().slice(-6)}`);
  await snap(page, "claim-create-filled");
  const before = await getNonce(DAVE);
  await page.locator("button:visible:not([disabled])").filter({ hasText: /^Create link$/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "claim-create", 5);
  await page.locator("text=/Link ready/i").first().waitFor({ state: "visible", timeout: 180_000 });
  await snap(page, "claim-create-success");
  const text = (await page.locator("body").textContent().catch(() => "")) ?? "";
  const m = text.match(new RegExp(`${VERCEL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/claim/${CHAIN_ID}/\\d+#[A-Za-z0-9._:-]+`));
  if (!m) throw new Error(`full claim URL missing in success text: ${text.slice(0, 500)}`);
  const hashes = await txHashesFrom(DAVE, before);
  return { url: m[0], hashes };
}

async function claimLinkAsBob(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>, url: string): Promise<Hash[]> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/You have a private payment|Claim private payment/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await snap(page, "claim-bob-ready");
  const before = await getNonce(BOB);
  await page.locator("button:visible:not([disabled])").filter({ hasText: /Claim private payment/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "claim-bob", 4);
  await page.locator("text=/Claimed/i").first().waitFor({ state: "visible", timeout: 180_000 });
  await snap(page, "claim-bob-success");
  return await txHashesFrom(BOB, before);
}

async function claimUsedLinkAsCarol(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>, url: string): Promise<{ ok: boolean; before: number; after: number; text: string }> {
  const before = await getNonce(CAROL);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/private payment|Claim|already|claimed/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await snap(page, "claim-carol-used-ready");
  const claim = page.locator("button:visible:not([disabled])").filter({ hasText: /Claim private payment/i }).first();
  if (await claim.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await claim.click();
    await drainRabbyPopups(ctx, extId, known, "claim-carol-used", 2);
  }
  await page.waitForTimeout(6_000);
  await snap(page, "claim-carol-used-final");
  const after = await getNonce(CAROL);
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return {
    ok: /already|claimed|not.*recipient|different recipient|error|failed|This link/i.test(text) || after === before,
    before,
    after,
    text: text.slice(0, 280),
  };
}

async function createStorefront(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<{ url: string; hashes: Hash[]; title: string }> {
  await page.goto(`${VERCEL_URL}/app/sell`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  const title = `QA Fixed ${Date.now().toString().slice(-6)}`;
  await safeFill(page.locator('input[placeholder*="Hand-bound" i]').first(), title);
  await safeFill(page.locator("textarea").first(), "QA fixed-price buyer path");
  await safeFill(page.locator('input[placeholder="10.00"]').first(), "0.1");
  await safeFill(page.locator('input[placeholder*="@yourhandle" i], input[placeholder*="telegram" i]').first(), "QA delivery");
  await snap(page, "storefront-create-filled");
  const before = await getNonce(DAVE);
  await page.locator("button:visible:not([disabled])").filter({ hasText: /^Create listing$/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "storefront-create", 5);
  await page.locator("text=/Listing live/i").first().waitFor({ state: "visible", timeout: 180_000 });
  await snap(page, "storefront-create-success");
  const text = (await page.locator("body").textContent().catch(() => "")) ?? "";
  const m = text.match(new RegExp(`${VERCEL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/shop/${CHAIN_ID}/\\d+`));
  if (!m) throw new Error(`shop URL missing in success text: ${text.slice(0, 500)}`);
  const hashes = await txHashesFrom(DAVE, before);
  return { url: m[0], hashes, title };
}

/// Dave revisits /app/sell after Bob buys. Verifies the listing is in
/// the "Your listings" section (proves seller-side dashboard reads the
/// chain state correctly), then hard-refreshes and re-verifies (proves
/// the data persists across reloads, not just session state).
async function verifyDaveSeesListing(page: Page, title: string): Promise<{ ok: boolean; afterBuy: string; afterRefresh: string }> {
  await page.goto(`${VERCEL_URL}/app/sell`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.locator(`text=/Your listings/i`).first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
  const afterBuyMatch = await page.locator(`text=${title}`).first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false);
  const afterBuy = await snap(page, "storefront-dave-revisit-after-buy");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.locator(`text=/Your listings/i`).first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
  const afterRefreshMatch = await page.locator(`text=${title}`).first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false);
  const afterRefresh = await snap(page, "storefront-dave-revisit-after-refresh");
  return { ok: afterBuyMatch && afterRefreshMatch, afterBuy, afterRefresh };
}

async function buyStorefrontAsBob(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>, url: string): Promise<Hash[]> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Fixed price|Buy now/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await safeFill(page.locator('input[placeholder="10.00"], input[placeholder="any amount"]').first(), "0.1");
  await snap(page, "storefront-bob-ready");
  const before = await getNonce(BOB);
  await page.locator("button:visible:not([disabled])").filter({ hasText: /^Buy now$/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "storefront-bob", 5);
  // 300s — storefront encrypted-payment lock takes longer than a normal FHE
  // settlement (encrypted listing + escrow lock + buyer ciphertext). Prior
  // 180s timed out exactly when the live UI hit "Payment locked in".
  await page.locator("text=/Payment locked in|Your encrypted payment is on-chain/i").first().waitFor({ state: "visible", timeout: 300_000 });
  await snap(page, "storefront-bob-success");
  return await txHashesFrom(BOB, before);
}

async function viewStorefrontAsCarol(page: Page, url: string): Promise<boolean> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Fixed price|Buy now|Payment locked|Storefront|Listing/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await snap(page, "storefront-carol-nonbuyer");
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return /Payment locked|Fixed price|Buy now|Listing|Storefront/i.test(text);
}

async function createCrowdfund(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<{ url: string; hashes: Hash[]; title: string }> {
  await page.goto(`${VERCEL_URL}/app/fundraise`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  const title = `QA Fund ${Date.now().toString().slice(-6)}`;
  await safeFill(page.locator('input[placeholder*="Save the bees" i]').first(), title);
  await safeFill(page.locator("textarea").first(), "QA crowdfund contributor path");
  await safeFill(page.locator('input[placeholder="500.00"]').first(), "1");
  await snap(page, "fund-create-filled");
  const before = await getNonce(DAVE);
  await page.locator("button:visible:not([disabled])").filter({ hasText: /^Launch campaign$/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "fund-create", 5);
  await page.locator("text=/Campaign live/i").first().waitFor({ state: "visible", timeout: 180_000 });
  await snap(page, "fund-create-success");
  const text = (await page.locator("body").textContent().catch(() => "")) ?? "";
  const m = text.match(new RegExp(`${VERCEL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/fund/${CHAIN_ID}/\\d+`));
  if (!m) throw new Error(`fund URL missing in success text: ${text.slice(0, 500)}`);
  const hashes = await txHashesFrom(DAVE, before);
  return { url: m[0], hashes, title };
}

/// Wave 5.5 — P2P Exchange create-offer smoke test on the current chain.
/// Mirrors Base's prior live proof for Eth Sepolia: Dave creates an
/// encrypted USDC→USDT swap offer through /app/swap. Drains Rabby
/// popups + captures success state. Returns the create tx hashes.
///
/// We test CREATE only here (not fill), because fill requires Bob to
/// hold shielded USDT and ensureShielded() only handles USDC. Adding
/// USDT shield support is a larger fixture lift; for desktop Rabby
/// launch-ready, proving the maker side on both chains + the Base full
/// fill (already done previously) is the practical bar.
async function createP2PSwap(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<{ hashes: Hash[]; created: boolean }> {
  await page.goto(`${VERCEL_URL}/app/swap`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  // The Create tab is the default landing for /app/swap exchange view.
  const giveInput = page.locator('input[aria-label="Amount you give"], input[placeholder="0.00"]').first();
  const wantInput = page.locator('input[aria-label="Amount you want"]').first();
  await giveInput.waitFor({ state: "visible", timeout: 30_000 });
  await safeFill(giveInput, "0.1");
  await safeFill(wantInput, "0.1");
  await snap(page, "p2p-create-filled");
  const before = await getNonce(DAVE);
  await page.locator("button:visible:not([disabled])").filter({ hasText: /^Create Swap Offer$/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "p2p-create", 5);
  // The success state shows "Offer Created!" — wait up to 240s for the
  // P2P encrypted-amount settlement (slower than Storefront because
  // P2PExchange uses FHE.gte + FHE.eq on both legs of the swap).
  const created = await page.locator("text=/Offer Created/i").first().waitFor({ state: "visible", timeout: 240_000 }).then(() => true).catch(() => false);
  await snap(page, "p2p-create-success");
  const hashes = await txHashesFrom(DAVE, before);
  return { hashes, created };
}

/// Dave revisits /app/fundraise after Bob + Carol contribute. Verifies
/// the campaign is in the "Your campaigns" section, then refreshes and
/// re-verifies.
async function verifyDaveSeesCampaign(page: Page, title: string): Promise<{ ok: boolean; afterContribute: string; afterRefresh: string }> {
  await page.goto(`${VERCEL_URL}/app/fundraise`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.locator(`text=/Your campaigns/i`).first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
  const afterContributeMatch = await page.locator(`text=${title}`).first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false);
  const afterContribute = await snap(page, "fund-dave-revisit-after-contribute");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.locator(`text=/Your campaigns/i`).first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
  const afterRefreshMatch = await page.locator(`text=${title}`).first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false);
  const afterRefresh = await snap(page, "fund-dave-revisit-after-refresh");
  return { ok: afterContributeMatch && afterRefreshMatch, afterContribute, afterRefresh };
}

async function contributeAsBob(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>, url: string): Promise<Hash[]> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Encrypted crowdfund|Contribute privately/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await safeFill(page.locator('input[placeholder="any amount"]').first(), "0.1");
  await snap(page, "fund-bob-ready");
  const before = await getNonce(BOB);
  await page.locator("button:visible:not([disabled])").filter({ hasText: /^Contribute privately$/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "fund-bob", 5);
  await page.locator("text=/Contribution submitted/i").first().waitFor({ state: "visible", timeout: 180_000 });
  await snap(page, "fund-bob-success");
  return await txHashesFrom(BOB, before);
}

async function contributeAs(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>, persona: Persona, url: string): Promise<Hash[]> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Encrypted crowdfund|Contribute privately/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await safeFill(page.locator('input[placeholder="any amount"]').first(), "0.1");
  await snap(page, `fund-${persona.toLowerCase()}-ready`);
  const before = await getNonce(accountByPersona[persona]);
  await page.locator("button:visible:not([disabled])").filter({ hasText: /^Contribute privately$/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, `fund-${persona.toLowerCase()}`, 5);
  await page.locator("text=/Contribution submitted/i").first().waitFor({ state: "visible", timeout: 180_000 });
  await snap(page, `fund-${persona.toLowerCase()}-success`);
  return await txHashesFrom(accountByPersona[persona], before);
}

async function runFlow(name: string, fn: () => Promise<FlowResult>): Promise<void> {
  try {
    const result = await fn();
    results.push(result);
    console.log(`GREEN ${name}`);
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "red", hashes: [], note });
    console.log(`RED ${name}: ${note}`);
  }
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(RABBY_PROFILE_DIR)) {
    throw new Error("Rabby extension or profile missing");
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`QA live public links · ${CHAIN_NAME} · ${VERCEL_URL} · output: ${OUT}`);

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
    if (sw) { extId = sw.url().split("/")[2]; break; }
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
  const setupHashes: Partial<Record<Persona, Hash[]>> = {};
  const walletProofs: string[] = [];

  await runFlow("Wallet identity preflight", async () => {
    for (const persona of ["Dave", "Bob", "Carol"] as const) {
      await ensureDappAccount(page, ctx, extId, known, persona);
      walletProofs.push(await verifyWalletState(page, rabbyPage, extId, persona));
    }
    return {
      name: "Wallet identity preflight",
      status: "green",
      hashes: [],
      note: walletProofs.join("; "),
      screenshot: resolve(OUT, "wallet-verified-carol.png"),
    };
  });

  await runFlow("Claim Link recipient", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    setupHashes.Dave ??= await ensureShielded(page, ctx, extId, known, "Dave", "2");
    const created = await createClaimLink(page, ctx, extId, known);
    await switchRabbyAccount(rabbyPage, extId, "Bob");
    await ensureDappAccount(page, ctx, extId, known, "Bob");
    setupHashes.Bob ??= await ensureShielded(page, ctx, extId, known, "Bob", "2");
    const claimHashes = await claimLinkAsBob(page, ctx, extId, known, created.url);
    await switchRabbyAccount(rabbyPage, extId, "Carol");
    await ensureDappAccount(page, ctx, extId, known, "Carol");
    setupHashes.Carol ??= await ensureShielded(page, ctx, extId, known, "Carol", "1");
    const carolBlocked = await claimUsedLinkAsCarol(page, ctx, extId, known, created.url);
    return {
      name: "Claim Link recipient",
      status: created.hashes.length > 0 && claimHashes.length > 0 && carolBlocked.ok ? "green" : "red",
      url: created.url,
      hashes: [...created.hashes, ...claimHashes],
      note: `Dave created link, Bob claimed it, Carol blocked after use (nonce ${carolBlocked.before}->${carolBlocked.after})`,
      screenshot: resolve(OUT, "claim-carol-used-final.png"),
    };
  });

  // Carried between runFlows so the seller/creator revisit can find the
  // exact listing/campaign by title after the buy/contribute has settled.
  let storefrontCreated: { url: string; hashes: Hash[]; title: string } | null = null;
  let crowdfundCreated: { url: string; hashes: Hash[]; title: string } | null = null;

  await runFlow("Storefront buyer", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    setupHashes.Dave ??= await ensureShielded(page, ctx, extId, known, "Dave", "2");
    const created = await createStorefront(page, ctx, extId, known);
    storefrontCreated = created;
    await switchRabbyAccount(rabbyPage, extId, "Bob");
    await ensureDappAccount(page, ctx, extId, known, "Bob");
    setupHashes.Bob ??= await ensureShielded(page, ctx, extId, known, "Bob", "2");
    const buyHashes = await buyStorefrontAsBob(page, ctx, extId, known, created.url);
    await switchRabbyAccount(rabbyPage, extId, "Carol");
    await ensureDappAccount(page, ctx, extId, known, "Carol");
    const carolCanView = await viewStorefrontAsCarol(page, created.url);
    return {
      name: "Storefront buyer",
      status: created.hashes.length > 0 && buyHashes.length > 0 && carolCanView ? "green" : "red",
      url: created.url,
      hashes: [...created.hashes, ...buyHashes],
      note: `Dave created '${created.title}', Bob bought, Carol viewed as non-buyer`,
      screenshot: resolve(OUT, "storefront-carol-nonbuyer.png"),
    };
  });

  // Separate flow so a crash here doesn't lose the buyer-flow proof. The
  // seller-revisit truth is its own row in the report.
  await runFlow("Storefront seller revisit", async () => {
    if (!storefrontCreated) {
      throw new Error("no storefront listing was created — skipping seller revisit");
    }
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    const sellerSide = await verifyDaveSeesListing(page, storefrontCreated.title);
    return {
      name: "Storefront seller revisit",
      status: sellerSide.ok ? "green" : "red",
      url: storefrontCreated.url,
      hashes: [],
      note: `Dave's /app/sell shows listing '${storefrontCreated.title}' (afterBuy=${sellerSide.ok ? "match" : "miss"}, refresh=${sellerSide.ok ? "match" : "miss"})`,
      screenshot: sellerSide.afterRefresh,
    };
  });

  await runFlow("Crowdfund contributor", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    setupHashes.Dave ??= await ensureShielded(page, ctx, extId, known, "Dave", "2");
    const created = await createCrowdfund(page, ctx, extId, known);
    crowdfundCreated = created;
    await switchRabbyAccount(rabbyPage, extId, "Bob");
    await ensureDappAccount(page, ctx, extId, known, "Bob");
    setupHashes.Bob ??= await ensureShielded(page, ctx, extId, known, "Bob", "2");
    const contributeHashes = await contributeAs(page, ctx, extId, known, "Bob", created.url);
    await switchRabbyAccount(rabbyPage, extId, "Carol");
    await ensureDappAccount(page, ctx, extId, known, "Carol");
    setupHashes.Carol ??= await ensureShielded(page, ctx, extId, known, "Carol", "1");
    const carolHashes = await contributeAs(page, ctx, extId, known, "Carol", created.url);
    return {
      name: "Crowdfund contributor",
      status: created.hashes.length > 0 && contributeHashes.length > 0 && carolHashes.length > 0 ? "green" : "red",
      url: created.url,
      hashes: [...created.hashes, ...contributeHashes, ...carolHashes],
      note: `Dave created '${created.title}', Bob and Carol contributed`,
      screenshot: resolve(OUT, "fund-carol-success.png"),
    };
  });

  await runFlow("Crowdfund creator revisit", async () => {
    if (!crowdfundCreated) {
      throw new Error("no crowdfund campaign was created — skipping creator revisit");
    }
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    const creatorSide = await verifyDaveSeesCampaign(page, crowdfundCreated.title);
    return {
      name: "Crowdfund creator revisit",
      status: creatorSide.ok ? "green" : "red",
      url: crowdfundCreated.url,
      hashes: [],
      note: `Dave's /app/fundraise shows campaign '${crowdfundCreated.title}' (afterContribute=${creatorSide.ok ? "match" : "miss"}, refresh=${creatorSide.ok ? "match" : "miss"})`,
      screenshot: creatorSide.afterRefresh,
    };
  });

  await runFlow("P2P Exchange create", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    setupHashes.Dave ??= await ensureShielded(page, ctx, extId, known, "Dave", "2");
    const result = await createP2PSwap(page, ctx, extId, known);
    return {
      name: "P2P Exchange create",
      status: result.created && result.hashes.length > 0 ? "green" : "red",
      url: `${VERCEL_URL}/app/swap`,
      hashes: result.hashes,
      note: result.created
        ? "Dave created encrypted P2P offer (0.1 USDC → 0.1 USDT); 'Offer Created' success captured"
        : "P2P create did not reach success state — see p2p-create-success.png",
      screenshot: resolve(OUT, "p2p-create-success.png"),
    };
  });

  await runFlow("Offramp create", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    setupHashes.Dave ??= await ensureShielded(page, ctx, extId, known, "Dave", "2");
    await page.goto(`${VERCEL_URL}/app/offramp`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await page.locator('[data-testid="offramp-new-offer"]').first().waitFor({ state: "visible", timeout: 30_000 });
    await page.locator('[data-testid="offramp-new-offer"]').first().click();
    await page.locator('[data-testid="offramp-create-modal"]').waitFor({ state: "visible", timeout: 10_000 });
    // PhonePe UPI handle needs the `name@provider` shape per the rail's
    // handlePattern regex /^[\w.\-]+@[\w.\-]+$/i; bare `qa-NNN` got
    // silently rejected with a toast.error and the modal stayed open.
    await safeFill(page.locator('[data-testid="offramp-create-handle"]'), `qa${Date.now().toString().slice(-6)}@upi`);
    await safeFill(page.locator('[data-testid="offramp-create-usdc"]'), "1");
    await safeFill(page.locator('[data-testid="offramp-create-fiat"]'), "1");
    await safeFill(page.locator('[data-testid="offramp-create-rate"]'), "1.0000");
    await snap(page, "offramp-create-filled");
    const before = await getNonce(DAVE);
    await page.locator('[data-testid="offramp-create-submit"]').click();
    // Offramp createOffer typically does: cofhe encrypt → vault approval (if
    // first time) → createOffer tx. 6 popups to drain handles both first-
    // run (approval present) and repeat-run (approval cached) paths.
    await drainRabbyPopups(ctx, extId, known, "offramp-create", 6);
    // Wait for modal to close + the new offer to be visible in the book or
    // in Dave's "My offers" list.
    const success = await page.locator('text=/My offers|Offer created|Offer Live/i').first()
      .waitFor({ state: "visible", timeout: 240_000 })
      .then(() => true)
      .catch(() => false);
    await snap(page, "offramp-create-after");
    const hashes = await txHashesFrom(DAVE, before);
    return {
      name: "Offramp create",
      status: success && hashes.length > 0 ? "green" : "red",
      url: `${VERCEL_URL}/app/offramp`,
      hashes,
      note: success
        ? `Dave created encrypted offramp offer (1 USDC for $1 fiat); modal closed + offer visible. Mock-mode signing fix (commit 3d178b4) makes proof submission possible — full take+proof harness deferred to next iteration.`
        : "Offramp create did not reach success state — see offramp-create-after.png",
      screenshot: resolve(OUT, "offramp-create-after.png"),
    };
  });

  const md = [
    "# QA live public links",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${VERCEL_URL}`,
    `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
    "",
    "## Setup shield transactions",
    "",
    `- Dave: ${(setupHashes.Dave ?? []).map((h) => `[${h.slice(0, 10)}...](${EXPLORER_URL}/tx/${h})`).join(", ") || "-"}`,
    `- Bob: ${(setupHashes.Bob ?? []).map((h) => `[${h.slice(0, 10)}...](${EXPLORER_URL}/tx/${h})`).join(", ") || "-"}`,
    `- Carol: ${(setupHashes.Carol ?? []).map((h) => `[${h.slice(0, 10)}...](${EXPLORER_URL}/tx/${h})`).join(", ") || "-"}`,
    "",
    "## Wallet preflight",
    "",
    ...walletProofs.map((line) => `- ${line}`),
    "",
    "## Public-link flows",
    "",
    "| Flow | Status | URL | Tx hashes | Note |",
    "|---|---|---|---|---|",
    ...results.map((r) => {
      const hashes = r.hashes.length
        ? r.hashes.map((h) => `[${h.slice(0, 10)}...](${EXPLORER_URL}/tx/${h})`).join("<br>")
        : "-";
      return `| ${r.name} | ${r.status} | ${r.url ?? "-"} | ${hashes} | ${r.note.replace(/\|/g, "/")} |`;
    }),
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  await ctx.close().catch(() => undefined);

  if (results.some((r) => r.status !== "green")) process.exit(2);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(99);
});
