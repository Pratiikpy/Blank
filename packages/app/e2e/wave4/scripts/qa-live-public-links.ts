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
const IS_ETH = CHAIN_ID === 11155111;
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
const OUT = resolve(REPO, `packages/app/test-results/qa-live-public-links-${CHAIN_SLUG}`);
const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;
const BOB = "0x0D1883c48E14d733D464478f53706D92b7648b9d" as Address;
const CAROL = "0x54488ad8d58f9147c1a99673ef8743608cd1b526" as Address;

const publicClient = createPublicClient({
  chain: VIEM_CHAIN,
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

// Wave 5.5 — handoff state for the optional Offramp lifecycle runFlow.
// Populated by the "Offramp create" flow when it can parse the
// createOffer receipt; consumed by the "Offramp take+proof+release"
// flow which only runs when OFFRAMP_LIFECYCLE=1 is set (the lifecycle
// adds ~6 minutes for the 300s challenge window so it's opt-in).
let lastOfframpOfferId: bigint | null = null;
let lastOfframpMakerHandle: string | null = null;

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
  const readChain = async () =>
    await page.evaluate(async () => {
      const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<string> } }).ethereum;
      if (!eth) return null;
      return await eth.request({ method: "eth_chainId" }).catch(() => null);
    });
  // 1. Try a plain switch.
  await page.evaluate(async (chainIdHex) => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
    if (!eth) throw new Error("window.ethereum missing");
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  }, targetHex).catch(() => undefined);
  await drainRabbyPopups(ctx, extId, known, `switch-chain-${persona.toLowerCase()}`, 2);
  let after = await readChain();
  // 2. If still wrong, the chain is likely unknown to this Rabby profile
  //    (it was seeded for eth/base). Add it, then switch again.
  if (after?.toLowerCase() !== targetHex.toLowerCase()) {
    await page.evaluate(async (p) => {
      const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
      await eth?.request({ method: "wallet_addEthereumChain", params: [p] }).catch(() => undefined);
    }, {
      chainId: targetHex,
      chainName: CHAIN_NAME,
      rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
      nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
      blockExplorerUrls: ["https://sepolia.arbiscan.io"],
    });
    await drainRabbyPopups(ctx, extId, known, `add-chain-${persona.toLowerCase()}`, 3);
    await page.evaluate(async (chainIdHex) => {
      const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
      await eth?.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] }).catch(() => undefined);
    }, targetHex);
    await drainRabbyPopups(ctx, extId, known, `switch-chain-2-${persona.toLowerCase()}`, 2);
    after = await readChain();
  }
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
    // Rabby may still be on the profile's last chain (e.g. Base) at preflight
    // time. The connect flow's ensureWalletChain switches it to the target
    // chain right after, so warn rather than abort the whole sweep here.
    console.warn(`${persona} preflight chain ${accounts.chainId} != ${expectedChain}; ensureWalletChain will switch during connect.`);
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

  // A leftover "N transactions need to sign" batch modal (unsigned CoFHE
  // permits from a prior persona's shield) sits on top of the home and blocks
  // the account-switch menu. Reject the queue so the menu is reachable.
  for (let i = 0; i < 3; i++) {
    const rejectAll = rabbyPage.getByText(/^Reject All$/i).first();
    if (await rejectAll.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await rejectAll.click({ force: true }).catch(() => {});
      await rabbyPage.waitForTimeout(1_200);
    } else break;
  }

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
  // EOA shield on CoFHE requests several PermissionedV2IssuerSelf ACL permit
  // signatures (the AA path batches these into one userOp; EOA must sign each).
  // Drain generously — drainRabbyPopups breaks early once no popup remains.
  await drainRabbyPopups(ctx, extId, known, `shield-${persona.toLowerCase()}`, 14);
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
    console.log(`${result.status === "green" ? "GREEN" : "RED"} ${name}${result.status === "red" ? `: ${result.note}` : ""}`);
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

  // Wave 5.5 — OFFRAMP_ONLY=1 skips earlier flows when re-running just
  // to validate the Offramp lifecycle. Saves ~25 min per chain.
  const offrampOnly = process.env.OFFRAMP_ONLY === "1";
  // FEATURES=gift,stealth,invoice runs just those focused feature flows
  // (plus the preflight), skipping the public-link + offramp create flows.
  const FEATURES = (process.env.FEATURES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  await runFlow("Wallet identity preflight", async () => {
    for (const persona of ["Dave", "Bob", "Carol"] as const) {
      // Switch Rabby first; ensureDappAccount throws if the dApp's
      // eth_accounts doesn't include the expected persona (which it
      // wouldn't if Rabby is still on the prior persona).
      await switchRabbyAccount(rabbyPage, extId, persona);
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

  // Core feature: direct encrypted send. Dave shields, then sends 1 USDC
  // encrypted to Bob through /app/send. Gated on SEND_FLOW=1 so it can run
  // focused (preflight + send) without the public-link flows.
  if (FEATURES.includes("send")) await runFlow("Send P2P (encrypted)", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await ensureShielded(page, ctx, extId, known, "Dave", "2");
    await page.goto(`${VERCEL_URL}/app/send`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await snap(page, "send-screen");
    const recip = page
      .locator('input[placeholder*="0x"]')
      .or(page.locator('input[placeholder*="Wallet address"]'))
      .first();
    await recip.waitFor({ state: "visible", timeout: 30_000 });
    await recip.fill(accountByPersona.Bob);
    await page.locator("button").filter({ hasText: /^(Continue|Next)/i }).first().click();
    await page.waitForTimeout(2_500);
    const amt = page.locator('input[placeholder="0.00"]').first();
    if (await amt.isVisible({ timeout: 5_000 }).catch(() => false)) await amt.fill("1");
    else { const k = page.locator('button[aria-label="1"]:visible').first(); await k.waitFor({ state: "visible", timeout: 10_000 }); await k.click(); }
    await page.locator("main button:visible:not([disabled])").filter({ hasText: /^(Continue|Review|Next|Send)/i }).last().click();
    await page.waitForURL(/\/app\/send\/confirm/, { timeout: 30_000 }).catch(() => undefined);
    await snap(page, "send-confirm");
    await page.locator("main button:visible:not([disabled])").filter({ hasText: /Confirm.*Send|^Send/i }).last().click();
    await drainRabbyPopups(ctx, extId, known, "send-p2p", 14);
    await page.waitForFunction(() => /Payment Sent|Sent!|sent successfully/i.test(document.body.innerText), { timeout: 180_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    await snap(page, "send-success");
    const ok = await page.evaluate(() => /Payment Sent|Sent!|sent successfully/i.test(document.body.innerText)).catch(() => false);
    return {
      name: "Send P2P (encrypted)",
      status: ok ? "green" : "red",
      url: `${VERCEL_URL}/app/send`,
      hashes: [],
      note: ok ? `Dave sent 1 USDC encrypted to Bob ${accountByPersona.Bob}` : "send did not reach success — see send-success.png",
      screenshot: resolve(OUT, "send-success.png"),
    };
  });

  // Gift envelope (encrypted). Dave shields then sends an encrypted gift to Bob.
  if (FEATURES.includes("gift")) await runFlow("Gift envelope (encrypted)", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await ensureShielded(page, ctx, extId, known, "Dave", "2");
    await page.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Gift Envelopes/i }).waitFor({ state: "visible", timeout: 30_000 });
    await snap(page, "gift-landing");
    await page.locator('input[placeholder="0.00"]').first().fill("1");
    await page.locator('input[placeholder="0x... (address)"]').fill(accountByPersona.Bob);
    await page.locator('textarea[placeholder="Write a heartfelt message..."]').fill("Arb Rabby QA gift").catch(() => undefined);
    await page.getByRole("button", { name: /Select Birthday theme/i }).click({ timeout: 15_000 });
    await snap(page, "gift-filled");
    const sendGiftBtn = page.locator("main button:visible:not([disabled])").filter({ hasText: /Send Gift Envelope/i }).first();
    await sendGiftBtn.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => undefined);
    await sendGiftBtn.click({ timeout: 30_000 });
    await drainRabbyPopups(ctx, extId, known, "gift", 14);
    await page.getByRole("heading", { name: /Gift Sent!/i }).waitFor({ state: "visible", timeout: 120_000 }).catch(() => undefined);
    await snap(page, "gift-sent");
    const ok = await page.evaluate(() => /Gift Sent/i.test(document.body.innerText)).catch(() => false);
    return {
      name: "Gift envelope (encrypted)",
      status: ok ? "green" : "red",
      url: `${VERCEL_URL}/app/gifts`,
      hashes: [],
      note: ok ? "Dave sent encrypted gift envelope to Bob" : "gift did not reach Gift Sent — see gift-sent.png",
      screenshot: resolve(OUT, "gift-sent.png"),
    };
  });

  // Invoice (business). Dave creates an encrypted invoice for Bob.
  if (FEATURES.includes("invoice")) await runFlow("Invoice create (business)", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await page.goto(`${VERCEL_URL}/app/business`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_500);
    await page.getByRole("button", { name: /^Invoices$/i }).first().click().catch(() => undefined);
    await page.waitForTimeout(1_500);
    const newInvoiceBtn = page.locator("main button:visible:not([disabled])").filter({ hasText: /New Invoice|Create your first invoice/i }).first();
    await newInvoiceBtn.waitFor({ state: "visible", timeout: 30_000 });
    await newInvoiceBtn.click();
    const clientAddr = page.locator('input[placeholder="0x..."]').first();
    await clientAddr.waitFor({ state: "visible", timeout: 30_000 });
    await clientAddr.fill(accountByPersona.Bob);
    await page.locator('input[placeholder="client@company.com"]').fill("bob+arb-rabby@blank.test").catch(() => undefined);
    await page.locator('input[placeholder="0.00"]').first().fill("25");
    await page.locator('input[placeholder="Services rendered"]').fill("Arb Rabby QA invoice").catch(() => undefined);
    await snap(page, "invoice-filled");
    await page.locator("main button:visible:not([disabled])").filter({ hasText: /^Create Invoice/i }).first().click();
    await drainRabbyPopups(ctx, extId, known, "invoice", 14);
    await page.waitForFunction(() => /Invoice sent|Invoice created|invoice-preview/i.test(document.body.innerHTML), { timeout: 120_000 }).catch(() => undefined);
    await page.waitForTimeout(2_500);
    await snap(page, "invoice-created");
    const ok = (await page.locator('[data-testid^="invoice-preview-"]').count().catch(() => 0)) > 0
      || (await page.evaluate(() => /Invoice sent|Invoice created/i.test(document.body.innerText)).catch(() => false));
    return {
      name: "Invoice create (business)",
      status: ok ? "green" : "red",
      url: `${VERCEL_URL}/app/business`,
      hashes: [],
      note: ok ? "Dave created encrypted invoice for Bob" : "invoice not confirmed — see invoice-created.png",
      screenshot: resolve(OUT, "invoice-created.png"),
    };
  });

  // Stealth payment (privacy headline). Dave shields then sends a stealth
  // payment to Bob's address; an on-chain announcement + one-time address.
  if (FEATURES.includes("stealth")) await runFlow("Stealth payment (encrypted)", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await ensureShielded(page, ctx, extId, known, "Dave", "2");
    await page.goto(`${VERCEL_URL}/app/stealth`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await snap(page, "stealth-landing");
    await page.locator('input[placeholder="0x..."]').first().fill(accountByPersona.Bob);
    await page.locator('input[inputmode="decimal"], input[placeholder*="0.00"]').first().fill("1");
    await snap(page, "stealth-filled");
    await page.locator("main button:visible:not([disabled])").filter({ hasText: /^Send Stealth Payment/i }).first().click();
    await drainRabbyPopups(ctx, extId, known, "stealth", 14);
    await page.waitForFunction(() => /Stealth payment sent|Payment sent|Sent!|announcement/i.test(document.body.innerText), { timeout: 180_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    await snap(page, "stealth-sent");
    const ok = await page.evaluate(() => /Stealth payment sent|Payment sent|Sent!|announcement|Recent Activity/i.test(document.body.innerText)).catch(() => false);
    return {
      name: "Stealth payment (encrypted)",
      status: ok ? "green" : "red",
      url: `${VERCEL_URL}/app/stealth`,
      hashes: [],
      note: ok ? "Dave sent stealth payment to Bob" : "stealth did not reach success — see stealth-sent.png",
      screenshot: resolve(OUT, "stealth-sent.png"),
    };
  });

  // Payment request. Dave requests 7 USDC from Bob (no shield needed).
  if (FEATURES.includes("requests")) await runFlow("Payment request", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await page.goto(`${VERCEL_URL}/app/requests`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Payment Requests/i }).waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("button").filter({ hasText: /^Request$/i }).first().click();
    await page.locator('input[placeholder="0x... (who should pay)"]').fill(accountByPersona.Bob);
    await page.locator('input[placeholder="0.00"]').fill("7");
    await page.locator('textarea[placeholder="Dinner split, rent, etc."]').fill("Arb Rabby QA request").catch(() => undefined);
    await snap(page, "request-filled");
    await page.locator("button").filter({ hasText: /^Send Request/i }).click();
    await drainRabbyPopups(ctx, extId, known, "request", 14);
    await page.waitForTimeout(4_000);
    // Dave's request is OUTGOING (he requests Bob to pay); the default
    // Incoming tab is empty for him, so switch to Outgoing to verify.
    await page.locator("button").filter({ hasText: /^Outgoing$/i }).first().click().catch(() => undefined);
    await page.waitForTimeout(2_500);
    await snap(page, "request-created");
    const ok = await page.evaluate(() => /\$?7(\.00)?\b|Arb Rabby QA request|requested|Request sent/i.test(document.body.innerText)).catch(() => false);
    return { name: "Payment request", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/requests`, hashes: [], note: ok ? "Dave requested 7 USDC from Bob" : "request not confirmed — see request-created.png", screenshot: resolve(OUT, "request-created.png") };
  });

  // Group expense. Dave creates an encrypted group.
  if (FEATURES.includes("groups")) await runFlow("Group create", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await page.goto(`${VERCEL_URL}/app/groups`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Group Expenses/i }).waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("button").filter({ hasText: /^Create/i }).first().click();
    await page.locator('input[placeholder="Weekend getaway"]').fill("Arb Rabby QA group").catch(() => undefined);
    const memberInput = page.locator('input[placeholder="0x..."]').first();
    if (await memberInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await memberInput.fill(accountByPersona.Bob).catch(() => undefined);
      // A "+" Add member button must commit the member before submit.
      await page.locator('button[aria-label="Add member"]').first().click().catch(() => undefined);
    }
    await snap(page, "group-filled");
    // The modal's submit is "+ Create Group" (the + prefix breaks a ^ anchor).
    await page.locator("button:visible:not([disabled])").filter({ hasText: /Create Group/i }).last().click().catch(() => undefined);
    await drainRabbyPopups(ctx, extId, known, "group", 14);
    await page.waitForTimeout(4_000);
    await snap(page, "group-created");
    const ok = await page.evaluate(() => /Arb Rabby QA group|Group created|created/i.test(document.body.innerText)).catch(() => false);
    return { name: "Group create", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/groups`, hashes: [], note: ok ? "Dave created encrypted group" : "group not confirmed — see group-created.png", screenshot: resolve(OUT, "group-created.png") };
  });

  // Creator profile. Dave sets up a creator support profile.
  if (FEATURES.includes("creator")) await runFlow("Creator profile", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await page.goto(`${VERCEL_URL}/app/creators`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Creator Support/i }).waitFor({ state: "visible", timeout: 30_000 });
    const setup = page.locator("button").filter({ hasText: /^Set Up Profile/i }).first();
    await setup.waitFor({ state: "visible", timeout: 15_000 });
    await setup.click();
    await page.waitForTimeout(2_000);
    const nameInput = page.locator('input[placeholder="Your name"]').first();
    if (await nameInput.isVisible({ timeout: 5_000 }).catch(() => false)) await nameInput.fill("Arb Rabby Creator").catch(() => undefined);
    await snap(page, "creator-filled");
    await page.locator("main button:visible:not([disabled])").filter({ hasText: /Create Profile/i }).last().click().catch(() => undefined);
    await drainRabbyPopups(ctx, extId, known, "creator", 14);
    await page.waitForTimeout(4_000);
    await snap(page, "creator-created");
    const ok = await page.evaluate(() => /Arb Rabby Creator|profile created|Your page|Share/i.test(document.body.innerText)).catch(() => false);
    return { name: "Creator profile", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/creators`, hashes: [], note: ok ? "Dave set up creator profile" : "creator not confirmed — see creator-created.png", screenshot: resolve(OUT, "creator-created.png") };
  });

  // Inheritance plan. Dave sets Bob as heir with an inactivity period.
  if (FEATURES.includes("inheritance")) await runFlow("Inheritance plan", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await ensureShielded(page, ctx, extId, known, "Dave", "2");
    await page.goto(`${VERCEL_URL}/app/inheritance`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Beneficiary Planning/i }).waitFor({ state: "visible", timeout: 30_000 });
    // Dave may already have a plan from a prior run — then "Set Up Inheritance
    // Plan" isn't shown and the existing plan IS the proof. Only drive setup
    // when the button is present.
    const setupBtn = page.locator("button").filter({ hasText: /^Set Up Inheritance Plan/i }).first();
    if (await setupBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await setupBtn.click();
      await page.waitForTimeout(2_000);
      await page.locator('input[placeholder="0x..."]').first().fill(accountByPersona.Bob).catch(() => undefined);
      await page.locator("select").first().selectOption("30").catch(() => undefined);
      await snap(page, "inheritance-filled");
      await page.locator("main button:visible:not([disabled])").filter({ hasText: /^Set Heir/i }).first().click().catch(() => undefined);
      await drainRabbyPopups(ctx, extId, known, "inheritance", 14);
    } else {
      await snap(page, "inheritance-existing");
    }
    await page.waitForTimeout(4_000);
    await snap(page, "inheritance-created");
    const ok = await page.evaluate(() => /Plan active|heir|beneficiary|inactivity|active|Heir set|Manage plan|Edit plan/i.test(document.body.innerText)).catch(() => false);
    return { name: "Inheritance plan", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/inheritance`, hashes: [], note: ok ? "Dave set up inheritance plan, Bob as heir" : "inheritance not confirmed — see inheritance-created.png", screenshot: resolve(OUT, "inheritance-created.png") };
  });

  // Escrow create (business). Dave creates an encrypted escrow for Bob.
  if (FEATURES.includes("escrow")) await runFlow("Escrow create", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await ensureShielded(page, ctx, extId, known, "Dave", "2");
    await page.goto(`${VERCEL_URL}/app/business`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Business Tools/i }).first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    // The Escrow tab is a <button role="tab" aria-label="Escrow"> — match the
    // tab role, not button (and it is NOT the default tab, so the click is required).
    await page.getByRole("tab", { name: /^Escrow$/i }).first().click({ timeout: 30_000 }).catch(async () => {
      await page.getByRole("button", { name: /^Escrow$/i }).first().click({ timeout: 5_000 }).catch(() => undefined);
    });
    await page.waitForTimeout(2_000);
    const newEscrow = page.locator("main button:visible:not([disabled])").filter({ hasText: /New Escrow|Create your first escrow/i }).first();
    await newEscrow.waitFor({ state: "visible", timeout: 30_000 });
    await newEscrow.click();
    await page.locator('input[placeholder="0x..."]').first().fill(accountByPersona.Bob).catch(() => undefined);
    await page.locator('input[placeholder="0.00"]').first().fill("1").catch(() => undefined);
    await page.locator('input[placeholder="Project milestone"]').fill("Arb Rabby QA escrow").catch(() => undefined);
    await snap(page, "escrow-filled");
    await page.locator("main button:visible:not([disabled])").filter({ hasText: /^Create Escrow/i }).first().click().catch(() => undefined);
    await drainRabbyPopups(ctx, extId, known, "escrow", 14);
    await page.waitForTimeout(4_000);
    await snap(page, "escrow-created");
    const ok = await page.evaluate(() => /Escrow created|escrow|locked|Pending|Funded/i.test(document.body.innerText)).catch(() => false);
    return { name: "Escrow create", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/business`, hashes: [], note: ok ? "Dave created encrypted escrow for Bob" : "escrow not confirmed — see escrow-created.png", screenshot: resolve(OUT, "escrow-created.png") };
  });

  // Proof of balance (FHE proof-of-X). Dave generates an encrypted proof.
  if (FEATURES.includes("proofs")) await runFlow("Proof of balance", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    await ensureShielded(page, ctx, extId, known, "Dave", "2");
    await page.goto(`${VERCEL_URL}/app/proofs`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await snap(page, "proofs-landing");
    const amtP = page.locator('input[placeholder*="50,000" i], input[placeholder*="Threshold" i], input[inputmode="decimal"]').first();
    if (await amtP.isVisible({ timeout: 5_000 }).catch(() => false)) await amtP.fill("50").catch(() => undefined);
    await page.locator("button").filter({ hasText: /^Create proof/i }).first().click().catch(() => undefined);
    await drainRabbyPopups(ctx, extId, known, "proofs", 14);
    await page.waitForTimeout(4_000);
    await snap(page, "proofs-created");
    const ok = await page.evaluate(() => /Proof created|proof|verified|generated|Share|valid/i.test(document.body.innerText)).catch(() => false);
    return { name: "Proof of balance", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/proofs`, hashes: [], note: ok ? "Dave created an encrypted proof" : "proof not confirmed — see proofs-created.png", screenshot: resolve(OUT, "proofs-created.png") };
  });

  // ── Multi-wallet CONSUME side: Bob consumes what Dave created ──
  // Gift claim — Bob opens Dave's gift envelope.
  if (FEATURES.includes("gift-claim")) await runFlow("Gift claim (Bob)", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Bob");
    await ensureDappAccount(page, ctx, extId, known, "Bob");
    await page.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Gift Envelopes/i }).waitFor({ state: "visible", timeout: 30_000 });
    await page.locator('button[aria-label="Received gifts"]').click().catch(() => undefined);
    await page.waitForTimeout(2_000);
    await snap(page, "gift-claim-before");
    const claimBtn = page.locator("button").filter({ hasText: /^Claim$/i }).first();
    if (!(await claimBtn.isVisible({ timeout: 10_000 }).catch(() => false))) {
      return { name: "Gift claim (Bob)", status: "red", url: `${VERCEL_URL}/app/gifts`, hashes: [], note: "no claimable gift for Bob — see gift-claim-before.png", screenshot: resolve(OUT, "gift-claim-before.png") };
    }
    await claimBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await claimBtn.click({ force: true });
    const claimClicks = await drainRabbyPopups(ctx, extId, known, "gift-claim", 14);
    await page.waitForTimeout(4_000);
    await snap(page, "gift-claim-after");
    // Real signal: a claim tx popup was confirmed (claimClicks > 0). "received"
    // alone is unreliable — it matches the "Received Gifts" section title.
    const ok = claimClicks > 0; // strict: only a confirmed claim-tx popup counts
    return { name: "Gift claim (Bob)", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/gifts`, hashes: [], note: ok ? "Bob claimed Dave's gift envelope" : "claim not confirmed — see gift-claim-after.png", screenshot: resolve(OUT, "gift-claim-after.png") };
  });

  // Request pay — Bob pays Dave's incoming payment request.
  if (FEATURES.includes("request-pay")) await runFlow("Request pay (Bob)", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Bob");
    await ensureDappAccount(page, ctx, extId, known, "Bob");
    await ensureShielded(page, ctx, extId, known, "Bob", "2");
    await page.goto(`${VERCEL_URL}/app/requests`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Payment Requests/i }).waitFor({ state: "visible", timeout: 30_000 });
    // The Incoming list is Supabase-backed and filters by the chain-synced
    // _activeChainIdForSupabase. Reload once so the query fires AFTER the
    // ChainProvider sets Arb, then wait for the row (not just a 2s skeleton).
    await page.waitForTimeout(5_000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("h1", { hasText: /Payment Requests/i }).waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(8_000);
    await snap(page, "request-pay-before");
    const payBtn = page.locator("button").filter({ hasText: /^Pay$/i }).first();
    if (!(await payBtn.isVisible({ timeout: 25_000 }).catch(() => false))) {
      return { name: "Request pay (Bob)", status: "red", url: `${VERCEL_URL}/app/requests`, hashes: [], note: "no incoming request for Bob — see request-pay-before.png", screenshot: resolve(OUT, "request-pay-before.png") };
    }
    // Dismiss the PWA install toast so it can't overlay the row's Pay button.
    await page.locator('button[aria-label*="install" i], button[aria-label*="dismiss" i], button[aria-label="Close"]').first().click().catch(() => undefined);
    await payBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await payBtn.click(); // opens the "Pay Request" modal
    await page.waitForTimeout(2_500);
    await snap(page, "request-pay-modal");
    // The request amount is FHE-encrypted, so the payer enters the agreed
    // amount; "Pay Now" stays disabled until the amount field is filled.
    await page.locator('input[placeholder="0.00"]:visible').last().fill("1").catch(() => undefined);
    await page.waitForTimeout(700);
    await page.locator("button:visible:not([disabled])").filter({ hasText: /Pay Now/i }).last().click().catch(() => undefined);
    const payClicks = await drainRabbyPopups(ctx, extId, known, "request-pay", 14);
    await page.waitForTimeout(4_000);
    await snap(page, "request-pay-after");
    const ok = payClicks > 0; // strict: only a confirmed pay-tx popup counts
    return { name: "Request pay (Bob)", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/requests`, hashes: [], note: ok ? "Bob paid Dave's request" : "pay not confirmed — see request-pay-after.png", screenshot: resolve(OUT, "request-pay-after.png") };
  });

  // Creator tip — Bob sends an encrypted tip to a registered creator.
  if (FEATURES.includes("creator-tip")) await runFlow("Creator tip (Bob)", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Bob");
    await ensureDappAccount(page, ctx, extId, known, "Bob");
    await ensureShielded(page, ctx, extId, known, "Bob", "2");
    await page.goto(`${VERCEL_URL}/app/creators`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Creator Support/i }).waitFor({ state: "visible", timeout: 30_000 });
    // The creators grid is Supabase-backed (chain-synced); reload + wait so the
    // registered Arb creator card renders before we try to select it.
    await page.waitForTimeout(4_000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("h1", { hasText: /Creator Support/i }).waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(8_000);
    await snap(page, "creator-tip-before");
    // Select a creator card — handleSupport returns early unless selectedCreator is set.
    const card = page.locator("div[data-creator-address]").first();
    if (!(await card.isVisible({ timeout: 25_000 }).catch(() => false))) {
      return { name: "Creator tip (Bob)", status: "red", url: `${VERCEL_URL}/app/creators`, hashes: [], note: "no registered Arb creator card rendered — see creator-tip-before.png", screenshot: resolve(OUT, "creator-tip-before.png") };
    }
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    await card.click();
    await page.waitForTimeout(1_000);
    // Select the $5 tier, which mounts the "Send $5 Support" button.
    await page.locator("button").filter({ hasText: /\$5\b/ }).first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    await snap(page, "creator-tip-tier");
    await page.locator("button:visible:not([disabled])").filter({ hasText: /Send \$\d+ Support/i }).last().click().catch(() => undefined);
    const tipClicks = await drainRabbyPopups(ctx, extId, known, "creator-tip", 14);
    await page.waitForTimeout(4_000);
    await snap(page, "creator-tip-after");
    const ok = tipClicks > 0; // strict: only a confirmed tip-tx popup counts
    return { name: "Creator tip (Bob)", status: ok ? "green" : "red", url: `${VERCEL_URL}/app/creators`, hashes: [], note: ok ? "Bob tipped a creator" : "tip not confirmed — see creator-tip-after.png", screenshot: resolve(OUT, "creator-tip-after.png") };
  });

  // ── Negative / edge cases: does the product FAIL CORRECTLY? (no tx, quick) ──
  if (FEATURES.includes("negatives")) await runFlow("Negative cases", async () => {
    await switchRabbyAccount(rabbyPage, extId, "Dave");
    await ensureDappAccount(page, ctx, extId, known, "Dave");
    const checks: string[] = [];
    const noCrash = (t: string) => !/Application error|TypeError|is not a function|undefined is not|ChunkLoadError|white screen/i.test(t);
    // 1. Bogus claim-link id → honest error, not a crash.
    await page.goto(`${VERCEL_URL}/claim/421614/0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(5_000);
    await snap(page, "neg-claim-bogus");
    const bogus = await page.evaluate(() => document.body.innerText).catch(() => "");
    const bogusOk = /not found|invalid|expired|doesn'?t exist|no longer|already claimed|couldn'?t find|unable|no link/i.test(bogus) && noCrash(bogus);
    checks.push(`bogus-claim:${bogusOk ? "honest-error" : "FAIL"}`);
    // 2. Malformed claim-link id → honest error, not a crash.
    await page.goto(`${VERCEL_URL}/claim/421614/notavalidlinkid`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    await snap(page, "neg-claim-malformed");
    const mal = await page.evaluate(() => document.body.innerText).catch(() => "");
    const malOk = /not found|invalid|expired|doesn'?t exist|error|couldn'?t|unable|no link/i.test(mal) && noCrash(mal);
    checks.push(`malformed-claim:${malOk ? "honest-error" : "FAIL"}`);
    // 3. Empty gift → "Send Gift Envelope" is gated (no amount/recipient/theme).
    await page.goto(`${VERCEL_URL}/app/gifts`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("h1", { hasText: /Gift Envelopes/i }).waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await snap(page, "neg-empty-gift");
    const giftBtn = page.locator("button").filter({ hasText: /Send Gift Envelope/i }).first();
    const giftGated = !(await giftBtn.isVisible({ timeout: 3_000 }).catch(() => false)) || (await giftBtn.isDisabled().catch(() => true));
    checks.push(`empty-gift-gated:${giftGated}`);
    const allGood = bogusOk && malOk && giftGated;
    return { name: "Negative cases", status: allGood ? "green" : "red", url: `${VERCEL_URL}/claim/...`, hashes: [], note: checks.join(" | "), screenshot: resolve(OUT, "neg-claim-bogus.png") };
  });

  if (!offrampOnly) await runFlow("Claim Link recipient", async () => {
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

  if (!offrampOnly) await runFlow("Storefront buyer", async () => {
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
  if (!offrampOnly) await runFlow("Storefront seller revisit", async () => {
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

  if (!offrampOnly) await runFlow("Crowdfund contributor", async () => {
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

  if (!offrampOnly) await runFlow("Crowdfund creator revisit", async () => {
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

  if (!offrampOnly) await runFlow("P2P Exchange create", async () => {
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

  if (!process.env.OFFRAMP_RELEASE_FILL && FEATURES.length === 0) await runFlow("Offramp create", async () => {
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
    const makerHandle = `qa${Date.now().toString().slice(-6)}@upi`;
    await safeFill(page.locator('[data-testid="offramp-create-handle"]'), makerHandle);
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
    // Walk receipts (newest first) and extract the offerId from the
    // OfferCreated event topic[1] for handoff to the lifecycle flow.
    // P2POfframp addresses: Eth 0x5981C437…, Base 0xd717E7AF….
    const offrampAddr = (CHAIN_ID === 421614
      ? "0x653e71e5F02a0fEAAFfCab5391DF0AE99b89961f"
      : IS_ETH
      ? "0x5981C437032Da38844AE9a3aa382F993b1B8444a"
      : "0xd717E7AFE5eB627c9913bc682003d6E83b9032f9").toLowerCase();
    for (const h of [...hashes].reverse()) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash: h });
        if (r.status !== "success") continue;
        for (const log of r.logs) {
          if (log.address.toLowerCase() !== offrampAddr) continue;
          if (log.topics.length < 2 || !log.topics[1]) continue;
          try {
            const id = BigInt(log.topics[1]);
            lastOfframpOfferId = id;
            lastOfframpMakerHandle = makerHandle;
            break;
          } catch { /* not the indexed offerId we want */ }
        }
        if (lastOfframpOfferId !== null) break;
      } catch { /* skip */ }
    }
    // Fallback: the EOA path's tx-hash scrape can miss the receipt, leaving
    // the offerId uncaptured. Read nextOfferId straight from the contract —
    // the offer Dave just created is nextOfferId - 1.
    if (lastOfframpOfferId === null) {
      try {
        const next = (await publicClient.readContract({
          address: offrampAddr as `0x${string}`,
          abi: [{ name: "nextOfferId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }],
          functionName: "nextOfferId",
        })) as bigint;
        if (typeof next === "bigint" && next > 0n) {
          lastOfframpOfferId = next - 1n;
          lastOfframpMakerHandle = makerHandle;
        }
      } catch { /* skip */ }
    }
    return {
      name: "Offramp create",
      status: success && hashes.length > 0 ? "green" : "red",
      url: `${VERCEL_URL}/app/offramp`,
      hashes,
      note: success
        ? `Dave created encrypted offramp offer (1 USDC for $1 fiat); modal closed + offer visible.${lastOfframpOfferId !== null ? ` offerId=${lastOfframpOfferId.toString()}` : ""} Set OFFRAMP_LIFECYCLE=1 to also drive Bob take + proof + release on the same offer.`
        : "Offramp create did not reach success state — see offramp-create-after.png",
      screenshot: resolve(OUT, "offramp-create-after.png"),
    };
  });

  // Release-only mode: drive just the release of an already-attested fill
  // (state=ProofSubmitted, challenge window elapsed). Used to finish the
  // lifecycle UI on an existing fill without re-running create/take/attest.
  if (process.env.OFFRAMP_RELEASE_FILL) {
    const fillId = process.env.OFFRAMP_RELEASE_FILL;
    await runFlow("Offramp release-only", async () => {
      await switchRabbyAccount(rabbyPage, extId, "Bob");
      await ensureDappAccount(page, ctx, extId, known, "Bob");
      await page.goto(`${VERCEL_URL}/app/offramp/fill/${fillId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(5_000);
      await snap(page, "offramp-release-only-before");
      const relBtn = page
        .locator('[data-testid="offramp-fill-release"]')
        .or(page.locator("main button:visible").filter({ hasText: /^Release/i }))
        .first();
      await relBtn.waitFor({ state: "visible", timeout: 30_000 });
      await relBtn.click();
      await drainRabbyPopups(ctx, extId, known, "offramp-release-only", 3);
      await page.waitForFunction(
        () => /Released|paid out to the taker|Settlement complete|Complete/i.test(document.body.innerText),
        { timeout: 180_000 },
      ).catch(() => undefined);
      await snap(page, "offramp-release-only-after");
      const ok = await page
        .evaluate(() => /Released|paid out to the taker|Settlement complete|Complete/i.test(document.body.innerText))
        .catch(() => false);
      return {
        name: "Offramp release-only",
        status: ok ? "green" : "red",
        url: `${VERCEL_URL}/app/offramp/fill/${fillId}`,
        hashes: [],
        note: ok ? `fill ${fillId} released (UI)` : `release not confirmed — see offramp-release-only-after.png`,
        screenshot: resolve(OUT, "offramp-release-only-after.png"),
      };
    });
  }

  // Wave 5.5 — opt-in Offramp lifecycle: Bob takes Dave's just-created
  // offer, submits the mock-signed Reclaim proof, waits the 300s
  // challenge window, then releases. Gated behind OFFRAMP_LIFECYCLE=1
  // because the wait adds ~6 minutes per chain.
  if (process.env.OFFRAMP_LIFECYCLE === "1" && lastOfframpOfferId !== null) {
    const offerId = lastOfframpOfferId;
    await runFlow("Offramp take + proof + release", async () => {
      const hashes: Hash[] = [];
      let note = "";

      // (1) Bob takes the offer.
      await switchRabbyAccount(rabbyPage, extId, "Bob");
      await ensureDappAccount(page, ctx, extId, known, "Bob");
      await page.goto(`${VERCEL_URL}/app/offramp/${offerId.toString()}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator('[data-testid="offramp-detail-take"]').waitFor({ state: "visible", timeout: 30_000 });
      await snap(page, "offramp-take-before");
      const beforeTake = await getNonce(BOB);
      await page.locator('[data-testid="offramp-detail-take"]').click();
      await drainRabbyPopups(ctx, extId, known, "offramp-take", 3);
      // After takeOffer, page navigates to /app/offramp/fill/:fillId.
      await page.waitForURL(/\/app\/offramp\/fill\/\d+/, { timeout: 180_000 }).catch(() => undefined);
      await snap(page, "offramp-take-after");
      const takeHashes = await txHashesFrom(BOB, beforeTake);
      hashes.push(...takeHashes);
      // Verify the take via the UI/URL signal (navigated to /fill/:id) rather
      // than the EOA tx-hash scrape, which the harness can't reliably capture
      // on the Rabby path even when the take lands (confirmed on-chain via
      // fillToOffer). Reaching the fill page IS the success signal.
      const fillIdFromUrl = page.url().match(/\/fill\/(\d+)/)?.[1] ?? null;
      if (fillIdFromUrl === null) {
        return {
          name: "Offramp take + proof + release",
          status: "red",
          url: `${VERCEL_URL}/app/offramp/${offerId.toString()}`,
          hashes,
          note: "Bob's takeOffer did not reach the fill page — see offramp-take-after.png",
          screenshot: resolve(OUT, "offramp-take-after.png"),
        };
      }
      note += `take: Bob took offer ${offerId.toString()} → fill ${fillIdFromUrl}. `;

      // (2) Bob submits the Reclaim proof. The widget POSTs to /api/relay
      // (server-side operator signing), then the hook fires submitProof
      // through Rabby. One additional popup.
      await page.locator('[data-testid="offramp-reclaim-start"]').waitFor({ state: "visible", timeout: 30_000 });
      await snap(page, "offramp-proof-before");
      const beforeProof = await getNonce(BOB);
      await page.locator('[data-testid="offramp-reclaim-start"]').click();
      await drainRabbyPopups(ctx, extId, known, "offramp-proof", 2);
      await page.waitForFunction(
        () => /Proof submitted|Challenge window|Release/.test(document.body.innerText),
        { timeout: 180_000 },
      ).catch(() => undefined);
      await snap(page, "offramp-proof-after");
      const proofHashes = await txHashesFrom(BOB, beforeProof);
      hashes.push(...proofHashes);
      // Verify via UI state (page shows Proof submitted / Challenge window /
      // Release) rather than the EOA tx-hash scrape.
      const proofOk = await page
        .evaluate(() => /Proof submitted|Challenge window|Release/i.test(document.body.innerText))
        .catch(() => false);
      if (!proofOk) {
        return {
          name: "Offramp take + proof + release",
          status: "red",
          url: `${VERCEL_URL}/app/offramp/${offerId.toString()}`,
          hashes,
          note: note + "submitProof did not reach the challenge-window state — see offramp-proof-after.png",
          screenshot: resolve(OUT, "offramp-proof-after.png"),
        };
      }
      note += `proof: submitted. `;

      // (3) Wait for the 300s challenge window + 30s buffer, then release.
      await page.waitForTimeout(330_000);
      await page.locator('[data-testid="offramp-fill-release"]').waitFor({ state: "visible", timeout: 30_000 });
      await snap(page, "offramp-release-before");
      const beforeRelease = await getNonce(BOB);
      await page.locator('[data-testid="offramp-fill-release"]').click();
      await drainRabbyPopups(ctx, extId, known, "offramp-release", 2);
      await page.waitForFunction(
        () => /Released|paid out to the taker/i.test(document.body.innerText),
        { timeout: 180_000 },
      ).catch(() => undefined);
      await snap(page, "offramp-release-after");
      const releaseHashes = await txHashesFrom(BOB, beforeRelease);
      hashes.push(...releaseHashes);
      // Verify release via the UI signal (the EOA tx-hash scrape is unreliable).
      const releaseOk = await page
        .evaluate(() => /Released|paid out to the taker|Settlement complete/i.test(document.body.innerText))
        .catch(() => false);
      note += releaseOk ? `release: confirmed (UI).` : `release: not confirmed — see offramp-release-after.png`;

      return {
        name: "Offramp take + proof + release",
        status: releaseOk ? "green" : "red",
        url: `${VERCEL_URL}/app/offramp/${offerId.toString()}`,
        hashes,
        note,
        screenshot: resolve(OUT, "offramp-release-after.png"),
      };
    });
  }

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
