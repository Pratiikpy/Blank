import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

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
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111) throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
const CHAIN_NAME = CHAIN_ID === 11155111 ? "Ethereum Sepolia" : "Base Sepolia";
const OUT = resolve(REPO, `packages/app/test-results/qa-live-mobile-sweep-${CHAIN_ID === 11155111 ? "eth" : "base"}`);

const ROUTES: Array<{ path: string; label: string }> = [
  { path: "/app", label: "01-dashboard" },
  { path: "/app/wallet", label: "02-wallet" },
  { path: "/app/send", label: "03-send" },
  { path: "/app/receive", label: "04-receive" },
  { path: "/app/history", label: "05-history" },
  { path: "/app/business", label: "06-business-tools" },
  { path: "/app/groups", label: "07-groups" },
  { path: "/app/creators", label: "08-creator-support" },
  { path: "/app/stealth", label: "09-stealth" },
  { path: "/app/stealth/inbox", label: "10-stealth-inbox" },
  { path: "/app/stealth/setup", label: "11-stealth-setup" },
  { path: "/app/inheritance", label: "12-inheritance" },
  { path: "/app/proofs", label: "13-proofs" },
  { path: "/app/gifts", label: "14-gifts" },
  { path: "/app/sell", label: "15-storefront-create" },
  { path: "/app/fundraise", label: "16-crowdfund-create" },
  { path: "/app/requests", label: "17-requests" },
  { path: "/app/contacts", label: "18-contacts" },
  { path: "/app/analytics", label: "19-analytics" },
  { path: "/app/agents", label: "20-agents" },
  { path: "/app/explore", label: "21-explore" },
  { path: "/app/profile", label: "22-profile" },
  { path: "/app/burners", label: "23-burners" },
  { path: "/app/scheduled", label: "24-scheduled" },
  { path: "/app/claim-link", label: "25-claim-link" },
  { path: "/app/swap", label: "26-swap" },
  { path: "/app/bridge", label: "27-bridge" },
  { path: "/app/privacy", label: "28-privacy" },
  { path: "/app/settings", label: "29-settings" },
  { path: "/app/help", label: "30-help" },
];

type RouteReport = {
  route: string;
  status: "ok" | "red";
  notes: string[];
  screenshot: string;
};

async function snap(page: Page, label: string): Promise<string> {
  const file = resolve(OUT, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return file;
}

async function drainRabbyPopups(ctx: BrowserContext, extId: string, known: Set<Page>, label: string, maxPopups = 3): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxPopups; i++) {
    const existing = ctx.pages().find((p) => {
      if (p.isClosed()) return false;
      const url = p.url();
      return url.includes(extId) && url.includes("notification.html");
    });
    const r = existing
      ? { popup: existing, ...(await confirmRabbyPopup(existing, OUT, `${label}-${i + 1}`)) }
      : await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `${label}-${i + 1}`, 30_000, { chainName: CHAIN_NAME });
    if (r.popup) known.add(r.popup);
    if (r.clicks === 0) break;
    total += r.clicks;
  }
  return total;
}

async function ensureWalletChain(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<void> {
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
  await drainRabbyPopups(ctx, extId, known, "mobile-switch-chain", 2);
}

async function connectRabby(page: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<void> {
  await page.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  for (let i = 0; i < 5; i++) {
    const card = page.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_000 }).catch(() => false)) break;
    const next = page.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 1_000 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(700);
  }
  const card = page.locator('[data-testid="wallet-choice-existing"]').first();
  if (await card.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await card.locator("button").filter({ hasText: /Rabby/i }).first().click({ force: true });
    await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "mobile-connect", 45_000, { chainName: CHAIN_NAME });
    await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "mobile-siwe", 25_000);
  }
  await ensureWalletChain(page, ctx, extId, known);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("text=/Total Balance|FHE Protected|Dashboard|Send Money/i").first().waitFor({ state: "visible", timeout: 60_000 });
  await snap(page, "00-connected-mobile");
}

async function analyze(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const notes: string[] = [];
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > window.innerWidth + 4) {
      notes.push(`horizontal overflow ${root.scrollWidth}px > ${window.innerWidth}px`);
    }
    const body = document.body.innerText || "";
    const errorMatch = body.match(/Something went wrong|Failed to load|Unhandled exception|TypeError|ReferenceError|\bNaN\b/i);
    if (errorMatch) notes.push(`error-like text visible: ${errorMatch[0]}`);
    const offenders: string[] = [];
    const selectors = "button, [role='button'], input, textarea, select, h1, h2, h3, nav a, nav button";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selectors))) {
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (el.closest("[aria-hidden='true']") || el.classList.contains("sr-only")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const rawLabel = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.tagName).trim();
      if (!rawLabel) continue;
      if (/^\d+$/.test(rawLabel)) continue;
      if (/^[•\s.]+$/.test(rawLabel)) continue;
      if (el.scrollWidth > el.clientWidth + 3 || el.scrollHeight > el.clientHeight + 3) {
        const label = rawLabel.replace(/\s+/g, " ").slice(0, 40);
        offenders.push(label);
      }
    }
    if (offenders.length) notes.push(`clipped controls/text: ${offenders.slice(0, 5).join(", ")}`);
    return notes;
  });
}

async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(RABBY_PROFILE_DIR)) throw new Error("Rabby extension or profile missing");
  mkdirSync(OUT, { recursive: true });
  console.log(`QA live mobile sweep · ${CHAIN_NAME} · ${VERCEL_URL}`);

  const ctx = await chromium.launchPersistentContext(RABBY_PROFILE_DIR, {
    headless: false,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
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

  const home = await ctx.newPage();
  await home.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await home.waitForTimeout(2_000);
  await unlockRabby(home, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(home);
  const known = new Set<Page>(ctx.pages());
  const page = await ctx.newPage();
  await connectRabby(page, ctx, extId, known);

  const bottomNavVisible = await page.locator('nav[aria-label="Main navigation"]').isVisible({ timeout: 5_000 }).catch(() => false);
  const reports: RouteReport[] = [];
  for (const route of ROUTES) {
    const url = `${VERCEL_URL}${route.path}`;
    const notes: string[] = [];
    let screenshot = "";
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID).catch(() => undefined);
      await page.waitForTimeout(2_500);
      const notFound = await page
        .locator("text=/^(404|404\\s+Page\\s+not\\s+found|Page\\s+not\\s+found)$/i")
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      if (notFound) notes.push("404 rendered");
      const hasHeading = await page.locator("h1, h2, h3, [role='heading']").first().isVisible({ timeout: 2_000 }).catch(() => false);
      if (!hasHeading) notes.push("no visible heading");
      notes.push(...(await analyze(page)));
      screenshot = await snap(page, route.label);
    } catch (err) {
      notes.push(err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160));
      screenshot = await snap(page, `${route.label}-error`);
    }
    const status = notes.length ? "red" : "ok";
    reports.push({ route: route.path, status, notes, screenshot });
    console.log(`[${status}] ${route.path} ${notes.join("; ")}`);
  }

  const md = [
    "# QA live mobile Rabby sweep",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${VERCEL_URL}`,
    `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
    `Viewport: 390x844, touch/mobile emulation, Rabby connected`,
    `Bottom nav visible on dashboard: ${bottomNavVisible ? "yes" : "no"}`,
    "",
    "| Route | Status | Notes |",
    "|---|---|---|",
    ...reports.map((r) => `| \`${r.route}\` | ${r.status} | ${r.notes.join("; ").replace(/\|/g, "/") || "-"} |`),
    "",
    "## Summary",
    `- ok: ${reports.filter((r) => r.status === "ok").length}`,
    `- red: ${reports.filter((r) => r.status === "red").length}`,
    `- output: ${OUT}`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  await ctx.close().catch(() => undefined);
  console.log(md);
  if (reports.some((r) => r.status === "red") || !bottomNavVisible) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
