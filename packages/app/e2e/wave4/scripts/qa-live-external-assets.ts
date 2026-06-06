import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, erc20Abi, formatUnits, http, type Address, type Hash } from "viem";
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
const OUT = resolve(REPO, "packages/app/test-results/qa-live-external-assets");

const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;
const ETH_ID = 11155111;
const BASE_ID = 84532;
const ARB_ID = 421614;

const CIRCLE_USDC: Record<number, Address> = {
  [ETH_ID]: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  [BASE_ID]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  [ARB_ID]: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
};
const WETH: Record<number, Address> = {
  [ETH_ID]: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  [BASE_ID]: "0x4200000000000000000000000000000000000006",
  [ARB_ID]: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
};
const RPC: Record<number, string> = {
  [ETH_ID]: "https://ethereum-sepolia.publicnode.com",
  [BASE_ID]: "https://base-sepolia-rpc.publicnode.com",
  [ARB_ID]: "https://sepolia-rollup.arbitrum.io/rpc",
};
const EXPLORER: Record<number, string> = {
  [ETH_ID]: "https://sepolia.etherscan.io",
  [BASE_ID]: "https://sepolia.basescan.org",
  [ARB_ID]: "https://sepolia.arbiscan.io",
};

const ethClient = createPublicClient({ chain: sepolia, transport: http(RPC[ETH_ID]) });
const baseClient = createPublicClient({ chain: baseSepolia, transport: http(RPC[BASE_ID]) });
const arbClient = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC[ARB_ID]) });
const clientByChain = { [ETH_ID]: ethClient, [BASE_ID]: baseClient, [ARB_ID]: arbClient };

type ProofResult = {
  name: string;
  status: "green" | "red";
  hashes: Array<{ chainId: number; hash: Hash; label: string }>;
  note: string;
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
  await loc.type(value, { delay: 35 });
  await loc.press("Tab").catch(() => undefined);
}

async function switchRabbyAccount(rabbyPage: Page, extId: string): Promise<void> {
  await rabbyPage.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabbyPage.waitForTimeout(1_500);
  await dismissRabbyWhatsNew(rabbyPage);
  const body = ((await rabbyPage.locator("body").textContent().catch(() => "")) ?? "").toLowerCase();
  if (body.includes(DAVE.toLowerCase().slice(0, 8)) || body.includes("private key 1")) return;
  const current = rabbyPage.locator("text=/Private Key \\d|Seed Phrase/i").first();
  if (await current.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await current.click({ force: true }).catch(() => undefined);
  } else {
    await rabbyPage.mouse.click(130, 95);
  }
  await rabbyPage.waitForTimeout(1_500);
  const row = rabbyPage.locator("div, button").filter({ hasText: /Private Key 1/i }).last();
  const box = await row.boundingBox({ timeout: 5_000 }).catch(() => null);
  if (box) await rabbyPage.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 38));
  else await row.click({ force: true });
  await rabbyPage.waitForTimeout(2_500);
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
    const result = existing
      ? { popup: existing, ...(await confirmRabbyPopup(existing, OUT, `${label}-${i + 1}`)) }
      : await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `${label}-${i + 1}`, 45_000);
    if (result.popup) known.add(result.popup);
    if (result.clicks === 0) break;
    total += result.clicks;
  }
  return total;
}

async function ensureDappAccount(
  page: Page,
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  chainId: number,
): Promise<void> {
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((id) => localStorage.setItem("blank:active_chain_id", String(id)), chainId);
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
    await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "connect-dave", 45_000, {
      chainName: chainId === ETH_ID ? "Ethereum Sepolia" : chainId === BASE_ID ? "Base Sepolia" : "Arbitrum Sepolia",
    });
    await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "siwe-dave", 25_000);
  }
  await ensureWalletChain(page, ctx, extId, known, chainId);
  const accounts = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string[]> } }).ethereum;
    if (!eth) return [];
    return await eth.request({ method: "eth_accounts" }).catch(() => []);
  });
  if (!accounts.map((x) => x.toLowerCase()).includes(DAVE.toLowerCase())) {
    await page.evaluate(async () => {
      const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string[]> } }).ethereum;
      if (eth) await eth.request({ method: "eth_requestAccounts" });
    }).catch(() => undefined);
    await drainRabbyPopups(ctx, extId, known, "request-dave", 2);
  }
}

async function ensureWalletChain(
  page: Page,
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  chainId: number,
): Promise<void> {
  const targetHex = `0x${chainId.toString(16)}`;
  const before = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<string> } }).ethereum;
    if (!eth) return null;
    return await eth.request({ method: "eth_chainId" }).catch(() => null);
  });
  if (before?.toLowerCase() !== targetHex.toLowerCase()) {
    await page.evaluate(async (hex) => {
      const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
      if (!eth) throw new Error("window.ethereum missing");
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    }, targetHex).catch(() => undefined);
    await drainRabbyPopups(ctx, extId, known, `switch-${chainId}`, 2);
  }
  const after = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<string> } }).ethereum;
    if (!eth) return null;
    return await eth.request({ method: "eth_chainId" }).catch(() => null);
  });
  if (after?.toLowerCase() !== targetHex.toLowerCase()) {
    throw new Error(`wallet chain mismatch: expected ${targetHex}, got ${after ?? "null"}`);
  }
}

async function txsFrom(chainId: number, fromNonce: number): Promise<Hash[]> {
  const client = clientByChain[chainId as keyof typeof clientByChain];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const latest = await client.getBlockNumber();
    const min = latest > 180n ? latest - 180n : 0n;
    const found: Array<{ nonce: number; hash: Hash }> = [];
    for (let n = latest; n >= min; n--) {
      const block = await client.getBlock({ blockNumber: n, includeTransactions: true }).catch(() => null);
      if (!block) continue;
      for (const tx of block.transactions) {
        if (tx.from.toLowerCase() === DAVE.toLowerCase() && tx.nonce >= fromNonce) {
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

async function balance(chainId: number, token: Address): Promise<bigint> {
  const client = clientByChain[chainId as keyof typeof clientByChain];
  return await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [DAVE] });
}

async function driveBridge(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<ProofResult> {
  await ensureDappAccount(page, ctx, extId, known, ETH_ID);
  await page.goto(`${VERCEL_URL}/app/bridge`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate(() => localStorage.setItem("blank:active_chain_id", String(11155111)));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("h1", { hasText: /Bridge USDC/i }).waitFor({ state: "visible", timeout: 60_000 });
  await snap(page, "bridge-landing");

  const ethNonceBefore = await ethClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  const baseNonceBefore = await baseClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  const ethUsdcBefore = await balance(ETH_ID, CIRCLE_USDC[ETH_ID]);
  const baseUsdcBefore = await balance(BASE_ID, CIRCLE_USDC[BASE_ID]);

  await safeFill(page.locator('input[placeholder="0.00"]').first(), "1");
  await snap(page, "bridge-amount-filled");
  await page.locator("button:visible:not([disabled])").filter({ hasText: /Ready to bridge/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "bridge-start", 4);
  await page.locator("text=/Attestation ready|Switch to .*Claim/i").first().waitFor({ state: "visible", timeout: 900_000 });
  await snap(page, "bridge-ready-to-claim");

  await page.locator("button:visible:not([disabled])").filter({ hasText: /Claim/i }).first().click();
  await drainRabbyPopups(ctx, extId, known, "bridge-claim", 4);
  await page.locator("text=/Bridge complete/i").first().waitFor({ state: "visible", timeout: 240_000 });
  const finalShot = await snap(page, "bridge-complete");

  const [ethHashes, baseHashes] = await Promise.all([
    txsFrom(ETH_ID, ethNonceBefore),
    txsFrom(BASE_ID, baseNonceBefore),
  ]);
  const ethUsdcAfter = await balance(ETH_ID, CIRCLE_USDC[ETH_ID]);
  const baseUsdcAfter = await balance(BASE_ID, CIRCLE_USDC[BASE_ID]);
  const ok =
    ethHashes.length >= 2 &&
    baseHashes.length >= 1 &&
    ethUsdcAfter < ethUsdcBefore &&
    baseUsdcAfter > baseUsdcBefore;

  return {
    name: "Circle CCTP Bridge",
    status: ok ? "green" : "red",
    hashes: [
      ...ethHashes.map((hash, i) => ({ chainId: ETH_ID, hash, label: i === 0 ? "approve/burn" : "burn/approve" })),
      ...baseHashes.map((hash) => ({ chainId: BASE_ID, hash, label: "mint" })),
    ],
    note: `Eth USDC ${formatUnits(ethUsdcBefore, 6)} -> ${formatUnits(ethUsdcAfter, 6)}, Base USDC ${formatUnits(baseUsdcBefore, 6)} -> ${formatUnits(baseUsdcAfter, 6)}`,
    screenshot: finalShot,
  };
}

async function driveSwap(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<ProofResult> {
  await ensureDappAccount(page, ctx, extId, known, ETH_ID);
  await page.goto(`${VERCEL_URL}/app/swap`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate(() => localStorage.setItem("blank:active_chain_id", String(11155111)));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("h1", { hasText: /Exchange/i }).waitFor({ state: "visible", timeout: 60_000 });
  await page.locator('[data-testid="exchange-tab-dex"]').click();
  await snap(page, "swap-dex-landing");

  const ethNonceBefore = await ethClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  const wethBefore = await balance(ETH_ID, WETH[ETH_ID]);
  const usdcBefore = await balance(ETH_ID, CIRCLE_USDC[ETH_ID]);

  await safeFill(page.locator('[data-testid="dex-amount-in"]').first(), "0.0001");
  await page.locator('[data-testid="dex-amount-out"]').waitFor({ state: "visible", timeout: 45_000 });
  await snap(page, "swap-quote-ready");
  await page.locator('[data-testid="dex-swap-button"]:visible:not([disabled])').first().click();
  await drainRabbyPopups(ctx, extId, known, "swap", 5);
  await page.locator("text=/Swap complete/i").first().waitFor({ state: "visible", timeout: 240_000 });
  const finalShot = await snap(page, "swap-complete");

  const hashes = await txsFrom(ETH_ID, ethNonceBefore);
  const wethAfter = await balance(ETH_ID, WETH[ETH_ID]);
  const usdcAfter = await balance(ETH_ID, CIRCLE_USDC[ETH_ID]);
  const ok = hashes.length >= 1 && wethAfter < wethBefore && usdcAfter > usdcBefore;
  return {
    name: "Uniswap DEX Swap",
    status: ok ? "green" : "red",
    hashes: hashes.map((hash, i) => ({ chainId: ETH_ID, hash, label: i === 0 ? "approve/swap" : "swap" })),
    note: `WETH ${formatUnits(wethBefore, 18)} -> ${formatUnits(wethAfter, 18)}, USDC ${formatUnits(usdcBefore, 6)} -> ${formatUnits(usdcAfter, 6)}`,
    screenshot: finalShot,
  };
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(RABBY_PROFILE_DIR)) {
    throw new Error("Rabby extension or profile missing");
  }
  mkdirSync(OUT, { recursive: true });
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
  await switchRabbyAccount(rabbyPage, extId);
  const known = new Set<Page>(ctx.pages());
  const page = await ctx.newPage();

  const results: ProofResult[] = [];
  try {
    results.push(await driveBridge(page, ctx, extId, known));
  } catch (err) {
    results.push({
      name: "Circle CCTP Bridge",
      status: "red",
      hashes: [],
      note: err instanceof Error ? err.message : String(err),
      screenshot: await snap(page, "bridge-error"),
    });
  }
  try {
    results.push(await driveSwap(page, ctx, extId, known));
  } catch (err) {
    results.push({
      name: "Uniswap DEX Swap",
      status: "red",
      hashes: [],
      note: err instanceof Error ? err.message : String(err),
      screenshot: await snap(page, "swap-error"),
    });
  } finally {
    await ctx.close().catch(() => undefined);
  }

  const md = [
    "# QA live external assets",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${VERCEL_URL}`,
    `Wallet: Dave ${DAVE}`,
    "",
    "| Flow | Status | Tx hashes | Balance truth | Screenshot |",
    "|---|---|---|---|---|",
    ...results.map((r) => {
      const hashes = r.hashes.length
        ? r.hashes.map((h) => `[${h.label} ${h.hash.slice(0, 10)}...](${EXPLORER[h.chainId]}/tx/${h.hash})`).join("<br>")
        : "-";
      return `| ${r.name} | ${r.status} | ${hashes} | ${r.note.replace(/\|/g, "/")} | ${r.screenshot ?? "-"} |`;
    }),
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(md);
  if (results.some((r) => r.status !== "green")) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
