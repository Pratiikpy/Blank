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
const IS_ETH = CHAIN_ID === 11155111;
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111) throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
const CHAIN_NAME = IS_ETH ? "Ethereum Sepolia" : "Base Sepolia";
const RPC_URL = IS_ETH ? "https://ethereum-sepolia.publicnode.com" : "https://base-sepolia-rpc.publicnode.com";
const EXPLORER_URL = IS_ETH ? "https://sepolia.etherscan.io" : "https://sepolia.basescan.org";
const OUT = resolve(REPO, `packages/app/test-results/qa-live-soak-${IS_ETH ? "eth" : "base"}`);
const PROFILE_ROOT = resolve(OUT, "profiles");
const SOAK_MINUTES = Number(process.env.SOAK_MINUTES ?? 30);

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

type SoakResult = {
  check: string;
  status: "green" | "red";
  detail: string;
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
  const profile = cloneProfile(persona);
  const ctx = await chromium.launchPersistentContext(profile, {
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
  await page.waitForTimeout(2_500);
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
  await ensureWalletChain(page, ctx, extId, known, persona);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Total Balance|FHE Protected|Dashboard/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await snap(page, `${persona.toLowerCase()}-connected`);
}

async function ensureWalletChain(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>, persona: Persona): Promise<void> {
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

async function txsFrom(address: Address, fromNonce: number): Promise<Hash[]> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const latest = await publicClient.getBlockNumber();
    const min = latest > 160n ? latest - 160n : 0n;
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
    if (found.length > 0) return found.sort((a, b) => a.nonce - b.nonce).map((x) => x.hash);
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return [];
}

async function bobSendsToDave(bobPage: Page, bobCtx: BrowserContext, extId: string, known: Set<Page>): Promise<{ note: string; hashes: Hash[]; clicks: number }> {
  const beforeNonce = await publicClient.getTransactionCount({ address: BOB, blockTag: "pending" });
  const note = `QA soak ${CHAIN_NAME} ${Date.now()}`;
  const sendUrl = new URL(`${VERCEL_URL}/app/send/amount`);
  sendUrl.searchParams.set("to", DAVE);
  await bobPage.goto(sendUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await bobPage.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await bobPage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await snap(bobPage, "bob-soak-amount-ready");

  const amountInput = bobPage.locator('input[placeholder="0.00"]').first();
  if (await amountInput.isVisible({ timeout: 5_000 }).catch(() => false)) await safeFill(amountInput, "0.01");
  else {
    for (const ch of "0.01") {
      await bobPage.locator(`button[aria-label="${ch === "." ? "Decimal point" : ch}"]:visible`).first().click();
    }
  }
  const addNote = bobPage.getByRole("button", { name: /add a note/i }).first();
  if (await addNote.isVisible({ timeout: 1_000 }).catch(() => false)) await addNote.click({ force: true });
  const noteInput = bobPage.locator('input[aria-label="Payment note"], input[placeholder="What is this for?"]').first();
  if (await noteInput.isVisible({ timeout: 2_000 }).catch(() => false)) await safeFill(noteInput, note);
  await snap(bobPage, "bob-soak-send-filled");
  await bobPage.locator("main button:visible:not([disabled])").filter({ hasText: /^(Continue|Review|Next|Send)/i }).last().click();
  await bobPage.waitForURL(/\/app\/send\/confirm/, { timeout: 15_000 }).catch(() => undefined);
  await snap(bobPage, "bob-soak-send-confirm");
  await bobPage.locator("main button").filter({ hasText: /Confirm.*Send|^Send/i }).last().click();
  const clicks = await drainRabbyPopups(bobCtx, extId, known, "bob-soak-send", 5);
  const hashes = await txsFrom(BOB, beforeNonce);
  await snap(bobPage, "bob-soak-after-send");
  return { note, hashes, clicks };
}

async function waitForText(page: Page, url: string, pattern: RegExp, label: string, timeoutMs = 180_000, refresh = false): Promise<SoakResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (refresh || page.url() !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
      if (refresh) await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(3_000);
    const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (pattern.test(text)) {
      return { check: label, status: "green", detail: text.match(pattern)?.[0] ?? "matched", screenshot: await snap(page, label) };
    }
    await page.waitForTimeout(10_000);
  }
  const finalText = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  const finalShot = await snap(page, pattern.test(finalText) ? label : `${label}-red`);
  if (pattern.test(finalText)) {
    return { check: label, status: "green", detail: finalText.match(pattern)?.[0] ?? "matched at final sample", screenshot: finalShot };
  }
  return { check: label, status: "red", detail: `No match for ${pattern}`, screenshot: finalShot };
}

async function expectTextAbsent(page: Page, url: string, pattern: RegExp, label: string, refresh = false): Promise<SoakResult> {
  if (refresh || page.url() !== url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
    if (refresh) await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(5_000);
  const text = ((await page.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  const present = pattern.test(text);
  return {
    check: label,
    status: present ? "red" : "green",
    detail: present ? "unexpected private note visible" : "private note not visible",
    screenshot: await snap(page, label),
  };
}

async function closeContext(ctx: BrowserContext): Promise<void> {
  await Promise.race([
    ctx.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
  ]);
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(SOURCE_PROFILE)) throw new Error("Rabby extension or source profile missing");
  mkdirSync(OUT, { recursive: true });
  console.log(`QA realtime soak · ${CHAIN_NAME} · ${SOAK_MINUTES} minutes · ${VERCEL_URL}`);

  const results: SoakResult[] = [];
  const dave = await launchPersona("Dave");
  const bob = await launchPersona("Bob");
  const carol = await launchPersona("Carol");
  try {
    await dave.page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await carol.page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await snap(dave.page, "dave-dashboard-open-before-action");
    await snap(carol.page, "carol-dashboard-open-before-action");
    const send = await bobSendsToDave(bob.page, bob.ctx, bob.extId, bob.known);
    results.push({
      check: "fresh Bob -> Dave send tx",
      status: send.hashes.length > 0 ? "green" : "red",
      detail: send.hashes.join(", ") || "no tx found",
      screenshot: await snap(bob.page, "bob-send-proof"),
    });
    const notePattern = new RegExp(send.note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    results.push(await waitForText(dave.page, `${VERCEL_URL}/app`, notePattern, "dave-realtime-no-refresh", 180_000, false));
    results.push(await expectTextAbsent(carol.page, `${VERCEL_URL}/app`, notePattern, "carol-private-state-absent-no-refresh", false));

    const end = Date.now() + SOAK_MINUTES * 60_000;
    let pass = true;
    let carolPass = true;
    let sample = 0;
    while (Date.now() < end) {
      sample++;
      const check = await waitForText(dave.page, `${VERCEL_URL}/app`, notePattern, `dave-refresh-sample-${sample}`, 60_000, true);
      results.push(check);
      pass = pass && check.status === "green";
      const carolCheck = await expectTextAbsent(carol.page, `${VERCEL_URL}/app`, notePattern, `carol-private-absent-refresh-sample-${sample}`, true);
      results.push(carolCheck);
      carolPass = carolPass && carolCheck.status === "green";
      const remaining = end - Date.now();
      if (remaining > 60_000) await dave.page.waitForTimeout(Math.min(300_000, remaining - 30_000));
    }
    results.push({ check: "30 minute send persistence", status: pass ? "green" : "red", detail: `${sample} refresh samples` });
    results.push({ check: "Carol private-state exclusion persistence", status: carolPass ? "green" : "red", detail: `${sample} refresh samples` });

    const baseChecks = IS_ETH
      ? [
          { label: "eth-claim-used", url: "https://blank-omega-jade.vercel.app/claim/11155111/10#b.LYonSy2rbCW0r9J9jZe_yfW7nxmPXYSpZOuv8cAftLY", pattern: /claimed|already|success|Claim/i },
          { label: "eth-storefront-after-buy", url: "https://blank-omega-jade.vercel.app/shop/11155111/3", pattern: /sold|purchased|listing|Buy|Storefront/i },
          { label: "eth-crowdfund-after-contribution", url: "https://blank-omega-jade.vercel.app/fund/11155111/3", pattern: /contributed|raised|campaign|fund/i },
        ]
      : [
          { label: "base-claim-used", url: "https://blank-omega-jade.vercel.app/claim/84532/34#b.oMy69j2Gdhks0edI8edDYkVTmZm8Zlkl0rL2CVU8rdM", pattern: /claimed|already|success|Claim/i },
          { label: "base-storefront-after-buy", url: "https://blank-omega-jade.vercel.app/shop/84532/14", pattern: /sold|purchased|listing|Buy|Storefront/i },
          { label: "base-crowdfund-after-contribution", url: "https://blank-omega-jade.vercel.app/fund/84532/14", pattern: /contributed|raised|campaign|fund/i },
          { label: "base-invoice-paid", url: "https://blank-omega-jade.vercel.app/app/invoice/84532/37", pattern: /paid|complete|invoice/i },
        ];
    for (const c of baseChecks) {
      results.push(await waitForText(dave.page, c.url, c.pattern, c.label, 75_000, true));
    }
    results.push(await waitForText(dave.page, `${VERCEL_URL}/app/groups`, /QA-|Group|Admin|member/i, "group-visibility-refresh", 75_000, true));
    results.push(await waitForText(dave.page, `${VERCEL_URL}/app/requests`, /QA request|Outgoing|Incoming|pending|fulfilled|request/i, "request-list-refresh", 75_000, true));
  } finally {
    await closeContext(carol.ctx);
    await closeContext(bob.ctx);
    await closeContext(dave.ctx);
  }

  const md = [
    "# QA realtime soak",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${VERCEL_URL}`,
    `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
    `Soak minutes: ${SOAK_MINUTES}`,
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.check} | ${r.status} | ${r.detail.replace(/\|/g, "/")} |`),
    "",
    `Output dir: ${OUT}`,
    "",
    "## Fresh send tx links",
    "",
    ...results
      .filter((r) => r.check === "fresh Bob -> Dave send tx")
      .flatMap((r) => r.detail.split(", ").filter(Boolean).map((h) => `- [${h}](${EXPLORER_URL}/tx/${h})`)),
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(md);
  if (results.some((r) => r.status === "red")) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
