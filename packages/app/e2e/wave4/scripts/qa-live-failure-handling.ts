import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Hash } from "viem";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";

import {
  unlockRabby,
  dismissRabbyWhatsNew,
  waitForRabbyPopup,
  waitAndConfirmRabbyPopup,
  confirmRabbyPopup,
} from "../../fixtures/rabby/rabby-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://www.myblank.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_SOURCE_PROFILE = process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111 && CHAIN_ID !== 421614)
  throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
const IS_ETH = CHAIN_ID === 11155111;
const CHAIN_SLUG = CHAIN_ID === 11155111 ? "eth" : CHAIN_ID === 84532 ? "base" : "arb";
const CHAIN_NAME =
  CHAIN_ID === 11155111 ? "Ethereum Sepolia" : CHAIN_ID === 84532 ? "Base Sepolia" : "Arbitrum Sepolia";
const VIEM_CHAIN = CHAIN_ID === 11155111 ? sepolia : CHAIN_ID === 84532 ? baseSepolia : arbitrumSepolia;
const OTHER_CHAIN_NAME = IS_ETH ? "Base Sepolia" : "Ethereum Sepolia";
const OTHER_CHAIN_ID = IS_ETH ? 84532 : 11155111;
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
const OUT = resolve(REPO, `packages/app/test-results/qa-live-failure-${CHAIN_SLUG}`);
const PROFILE = resolve(OUT, "rabby-profile");

const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;
const BOB = "0x0D1883c48E14d733D464478f53706D92b7648b9d" as Address;
const SENDER = (process.env.SENDER ?? "Bob") as "Dave" | "Bob";
const RECIPIENT = (SENDER === "Bob" ? DAVE : BOB) as Address;
const USED_CLAIM_URL = process.env.USED_CLAIM_URL ??
  (IS_ETH
    ? "https://www.myblank.app/claim/11155111/10#b.LYonSy2rbCW0r9J9jZe_yfW7nxmPXYSpZOuv8cAftLY"
    : "https://www.myblank.app/claim/84532/34#b.oMy69j2Gdhks0edI8edDYkVTmZm8Zlkl0rL2CVU8rdM");

const publicClient = createPublicClient({
  chain: VIEM_CHAIN,
  transport: http(RPC_URL),
});

type Persona = "Dave" | "Bob";
type TxHit = { nonce: number; hash: Hash; status: "success" | "reverted"; to: Address | null };
type Check = { name: string; status: "green" | "red"; detail: string; screenshot?: string };

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
  await loc.type(value, { delay: 25 });
  await loc.press("Tab").catch(() => undefined);
}

async function rawClick(page: Page, x: number, y: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 80));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await cdp.detach().catch(() => undefined);
}

async function rejectRabbyPopup(
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  label: string,
): Promise<{ sawPopup: boolean; clicked: boolean; closed: boolean }> {
  const existing = ctx.pages().find((p) => {
    if (p.isClosed()) return false;
    const url = p.url();
    return url.includes(extId) && url.includes("notification.html");
  });
  const popup = existing ?? (await waitForRabbyPopup(ctx, extId, known, 45_000));
  if (!popup) return { sawPopup: false, clicked: false, closed: false };
  known.add(popup);
  await popup.waitForTimeout(2_000);
  await popup.screenshot({ path: resolve(OUT, `${label}-before-reject.png`) }).catch(() => undefined);
  const candidates = [/^Reject$/i, /^Cancel$/i, /^Deny$/i, /^Close$/i];
  for (const re of candidates) {
    const btn = popup.getByRole("button", { name: re }).first();
    if (!(await btn.isVisible({ timeout: 2_000 }).catch(() => false))) continue;
    const box = await btn.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (box) await rawClick(popup, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    else await btn.click({ force: true }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2_000));
    if (!popup.isClosed()) {
      await popup.screenshot({ path: resolve(OUT, `${label}-after-reject.png`) }).catch(() => undefined);
    }
    return { sawPopup: true, clicked: true, closed: popup.isClosed() };
  }
  await popup.keyboard.press("Escape").catch(() => undefined);
  await popup.waitForTimeout(1_000);
  return { sawPopup: true, clicked: false, closed: popup.isClosed() };
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
    const min = latest > 200n ? latest - 200n : 0n;
    const found: TxHit[] = [];
    for (let n = latest; n >= min; n--) {
      const block = await publicClient.getBlock({ blockNumber: n, includeTransactions: true }).catch(() => null);
      if (!block) continue;
      for (const tx of block.transactions) {
        if (tx.from.toLowerCase() !== address.toLowerCase() || tx.nonce < fromNonce) continue;
        const receipt = await publicClient.getTransactionReceipt({ hash: tx.hash }).catch(() => null);
        found.push({ nonce: tx.nonce, hash: tx.hash, to: tx.to, status: receipt?.status ?? "success" });
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
  const rows = rabbyPage.locator("div, button").filter({ hasText: new RegExp(target, "i") });
  const count = await rows.count().catch(() => 0);
  if (count === 0) throw new Error(`Rabby account row not found for ${target}`);
  const row = rows.nth(Math.max(0, count - 1));
  const box = await row.boundingBox({ timeout: 5_000 }).catch(() => null);
  if (box) await rabbyPage.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 38));
  else await row.click({ force: true });
  await rabbyPage.waitForTimeout(2_500);
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
  await drainRabbyPopups(ctx, extId, known, `switch-${CHAIN_ID}`, 2);
  const after = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string[]> } }).ethereum;
    if (!eth) return [];
    return await eth.request({ method: "eth_accounts" }).catch(() => []);
  });
  if (!after.map((x) => x.toLowerCase()).includes(expected)) {
    throw new Error(`dApp account mismatch for ${persona}: ${after.join(", ")}`);
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Total Balance|Dashboard|Send Money/i").first().waitFor({ state: "visible", timeout: 60_000 });
}

async function fillSend(page: Page, amount: string, note: string): Promise<void> {
  const url = new URL(`${VERCEL_URL}/app/send/amount`);
  url.searchParams.set("to", RECIPIENT);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  const amountInput = page.locator('input[placeholder="0.00"]').first();
  if (await amountInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await safeFill(amountInput, amount);
  } else {
    const labelFor = (ch: string) => (ch === "." ? "Decimal point" : ch);
    for (const ch of amount) {
      const key = page.locator(`button[aria-label="${labelFor(ch)}"]:visible`).first();
      await key.waitFor({ state: "visible", timeout: 10_000 });
      await key.click();
    }
  }
  const addNote = page.getByRole("button", { name: /add a note/i }).first();
  if (await addNote.isVisible({ timeout: 1_000 }).catch(() => false)) await addNote.click({ force: true });
  const noteInput = page.locator('input[aria-label="Payment note"], input[placeholder="What is this for?"]').first();
  if (await noteInput.isVisible({ timeout: 2_000 }).catch(() => false)) await safeFill(noteInput, note);
  await page.locator("main button:visible:not([disabled])").filter({ hasText: /^(Continue|Review|Next|Send)/i }).last().click();
  await page.waitForURL(/\/app\/send\/confirm/, { timeout: 15_000 }).catch(() => undefined);
}

async function bodyText(page: Page): Promise<string> {
  return ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
}

async function walletChainId(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string> } }).ethereum;
    if (!eth) return "";
    return await eth.request({ method: "eth_chainId" }).catch(() => "");
  });
}

async function switchWalletToTarget(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<void> {
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.evaluate(async (chainIdHex) => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
    if (eth) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] }).catch(() => undefined);
  }, `0x${CHAIN_ID.toString(16)}`);
  await drainRabbyPopups(ctx, extId, known, `return-to-${CHAIN_ID}`, 3);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(RABBY_SOURCE_PROFILE)) {
    throw new Error("Rabby extension or profile missing");
  }
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  cpSync(RABBY_SOURCE_PROFILE, PROFILE, { recursive: true });
  console.log(`QA live failure handling · ${CHAIN_NAME} · ${SENDER} · ${VERCEL_URL}`);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
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

  const checks: Check[] = [];
  const rabbyPage = await ctx.newPage();
  const page = await ctx.newPage();
  const known = new Set<Page>(ctx.pages());
  const senderAddress = accountByPersona[SENDER];

  try {
    await rabbyPage.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
    await rabbyPage.waitForTimeout(2_000);
    await unlockRabby(rabbyPage, RABBY_PASSWORD);
    await dismissRabbyWhatsNew(rabbyPage);
    await switchRabbyAccount(rabbyPage, extId, SENDER);
    await ensureDappAccount(page, ctx, extId, known, SENDER);
    await snap(page, "dashboard-ready");

    const beforeRejectNonce = await publicClient.getTransactionCount({ address: senderAddress, blockTag: "pending" });
    await fillSend(page, "0.01", `QA reject ${Date.now()}`);
    await snap(page, "reject-send-confirm");
    await page.locator("main button").filter({ hasText: /Confirm.*Send|^Send/i }).last().click();
    const rejected = await rejectRabbyPopup(ctx, extId, known, "send-reject");
    await page.waitForTimeout(5_000);
    await snap(page, "send-after-wallet-reject");
    const afterRejectNonce = await publicClient.getTransactionCount({ address: senderAddress, blockTag: "pending" });
    const rejectText = await bodyText(page);
    const retryVisible = await page.locator("main button").filter({ hasText: /Confirm.*Send|Try again|Send/i }).last().isVisible({ timeout: 2_000 }).catch(() => false);
    checks.push({
      name: "Rejected Rabby send",
      status: rejected.sawPopup && rejected.clicked && afterRejectNonce === beforeRejectNonce && retryVisible ? "green" : "red",
      detail: `popup=${rejected.sawPopup}, clicked=${rejected.clicked}, nonce ${beforeRejectNonce}->${afterRejectNonce}, retryVisible=${retryVisible}, text="${rejectText.slice(0, 180).replace(/\|/g, "/")}"`,
      screenshot: "send-after-wallet-reject.png",
    });

    await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('[aria-label^="Network:"]').first().click({ force: true });
    await page.getByRole("option", { name: new RegExp(OTHER_CHAIN_NAME, "i") }).first().click({ force: true });
    const chainRejected = await rejectRabbyPopup(ctx, extId, known, "chain-switch-reject");
    await page.waitForTimeout(3_000);
    await snap(page, "after-chain-switch-reject");
    const chainIdAfterSwitch = await walletChainId(page);
    const chainText = await bodyText(page);
    checks.push({
      name: "Wrong-chain switch recovery",
      status:
        (chainRejected.sawPopup && chainRejected.clicked && chainIdAfterSwitch === `0x${CHAIN_ID.toString(16)}`) ||
        (!chainRejected.sawPopup && chainIdAfterSwitch === `0x${OTHER_CHAIN_ID.toString(16)}` && /Sepolia|Base/i.test(chainText))
          ? "green"
          : "red",
      detail: `popup=${chainRejected.sawPopup}, clicked=${chainRejected.clicked}, walletChain=${chainIdAfterSwitch}, original=0x${CHAIN_ID.toString(16)}, requested=0x${OTHER_CHAIN_ID.toString(16)}`,
      screenshot: "after-chain-switch-reject.png",
    });
    await switchWalletToTarget(page, ctx, extId, known);

    await page.goto(USED_CLAIM_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4_000);
    await snap(page, "used-claim-link");
    const usedText = await bodyText(page);
    const usedOk = /already|claimed|used|redeemed|expired|unavailable/i.test(usedText) && !/Unhandled|TypeError|ReferenceError|Something went wrong/i.test(usedText);
    checks.push({
      name: "Already-used claim link",
      status: usedOk ? "green" : "red",
      detail: usedText.slice(0, 260).replace(/\|/g, "/"),
      screenshot: "used-claim-link.png",
    });

    const beforeDoubleNonce = await publicClient.getTransactionCount({ address: senderAddress, blockTag: "pending" });
    const doubleNote = `QA duplicate ${CHAIN_NAME} ${Date.now()}`;
    await fillSend(page, "0.01", doubleNote);
    await snap(page, "duplicate-send-confirm");
    const confirm = page.locator("main button").filter({ hasText: /Confirm.*Send|^Send/i }).last();
    await Promise.allSettled([confirm.click({ force: true }), confirm.click({ force: true })]);
    const duplicateClicks = await drainRabbyPopups(ctx, extId, known, "duplicate-send", 5);
    await page.waitForTimeout(10_000);
    const hits = await txsFrom(senderAddress, beforeDoubleNonce);
    await snap(page, "duplicate-send-result");
    const oneSuccessful = hits.filter((h) => h.status === "success").length === 1;
    checks.push({
      name: "Duplicate send click",
      status: duplicateClicks > 0 && oneSuccessful ? "green" : "red",
      detail: `beforeNonce=${beforeDoubleNonce}, popupsClicked=${duplicateClicks}, txs=${hits.map((h) => `${h.nonce}:${h.status}:${h.hash}`).join(", ") || "none"}`,
      screenshot: "duplicate-send-result.png",
    });
  } finally {
    await ctx.close().catch(() => undefined);
  }

  const md = [
    "# QA live failure handling",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${VERCEL_URL}`,
    `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
    `Wallet: ${SENDER} (${senderAddress})`,
    "",
    "| Check | Status | Detail | Screenshot |",
    "|---|---|---|---|",
    ...checks.map((c) => `| ${c.name} | ${c.status} | ${c.detail.replace(/\n/g, " ").replace(/\|/g, "/")} | ${c.screenshot ?? "-"} |`),
    "",
    "## Explorer",
    "",
    ...checks
      .flatMap((c) => Array.from(c.detail.matchAll(/0x[a-fA-F0-9]{64}/g)).map((m) => `- [${m[0]}](${EXPLORER_URL}/tx/${m[0]})`)),
    "",
    `Output dir: ${OUT}`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(md);
  if (checks.some((c) => c.status === "red")) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
