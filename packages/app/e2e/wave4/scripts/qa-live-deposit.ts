/**
 * QA: drive Deposit / Shield flow on live Vercel with Rabby.
 *
 *   pnpm exec tsx packages/app/e2e/wave4/scripts/qa-live-deposit.ts
 *
 * Connects Rabby (reusing Phase 9 primitives), navigates to /app
 * dashboard, finds the "DEPOSIT TO PRIVATE WALLET" panel, enters an
 * amount, clicks Deposit, drives Rabby approve + shield popups,
 * captures both tx hashes.
 *
 * This is the foundational flow for nearly every other feature —
 * encrypted Send, Stealth Send, Gifts, Inheritance, Proofs all need
 * shielded balance to operate. If this works for Dave's Rabby EOA on
 * live Vercel, the dApp's encryption pipeline + Rabby integration
 * are end-to-end healthy.
 */
import { chromium, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, http, type Address, type Hash } from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import {
  unlockRabby,
  dismissRabbyWhatsNew,
  waitAndConfirmRabbyPopup,
} from "../../fixtures/rabby/rabby-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://blank-omega-jade.vercel.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const OUT = resolve(REPO, "packages/app/test-results/qa-live-deposit");
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111) throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
const IS_ETH = CHAIN_ID === 11155111;
const CHAIN_NAME = IS_ETH ? "Ethereum Sepolia" : "Base Sepolia";
const RPC_URL = IS_ETH ? "https://ethereum-sepolia.publicnode.com" : "https://sepolia.base.org";
const EXPLORER_URL = IS_ETH ? "https://sepolia.etherscan.io" : "https://sepolia.basescan.org";
const BLOCKSCOUT_URL = IS_ETH ? "https://eth-sepolia.blockscout.com" : "https://base-sepolia.blockscout.com";
const DAVE = "0x7eF99105308230eab5B8E4765842bc2BF7B1D175" as Address;

const AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1";

const publicClient = createPublicClient({
  chain: IS_ETH ? sepolia : baseSepolia,
  transport: http(RPC_URL),
});

async function switchDappChain(page: Page, extId: string, knownPages: Set<Page>): Promise<void> {
  const targetHex = `0x${CHAIN_ID.toString(16)}`;
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await page.evaluate(async (chainIdHex) => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
    if (!eth) throw new Error("window.ethereum missing");
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  }, targetHex).catch(() => undefined);
  await waitAndConfirmRabbyPopup(page.context(), extId, knownPages, OUT, "rabby-switch-chain", 20_000, {
    chainName: CHAIN_NAME,
  }).catch(() => ({ clicks: 0, closed: false }));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
}

async function assertDappChain(page: Page): Promise<string> {
  const chainId = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string }): Promise<string> } }).ethereum;
    if (!eth) return "";
    return await eth.request({ method: "eth_chainId" }).catch(() => "");
  });
  const expected = `0x${CHAIN_ID.toString(16)}`;
  if (chainId.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Wrong dApp chain: ${chainId || "missing"}, expected ${expected}`);
  }
  return chainId;
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
  console.log(`QA Deposit → Shield · ${CHAIN_NAME} · ${VERCEL_URL} · amount=${AMOUNT} USDC`);
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

  const home = await ctx.newPage();
  await home.goto(`chrome-extension://${extId}/index.html`).catch(() => {});
  await home.waitForTimeout(2_000);
  await unlockRabby(home, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(home);

  const dapp = await ctx.newPage();
  await dapp.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.waitForTimeout(3_000);
  await dapp.screenshot({ path: resolve(OUT, "01-app-loaded.png"), fullPage: true });

  const knownPages = new Set<Page>(ctx.pages());

  // Walk onboarding carousel (idempotent — breaks early if already past).
  for (let i = 0; i < 6; i++) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_500 }).catch(() => false)) break;
    const next = dapp.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 2_000 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => {});
    await dapp.waitForTimeout(1_200);
  }

  // Connect via WalletChoiceCard if dashboard isn't already mounted.
  const dashboardLanded = await dapp
    .locator("text=/Good afternoon|Total Balance|FHE Protected/i")
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  if (!dashboardLanded) {
    const existingCard = dapp.locator('[data-testid="wallet-choice-existing"]');
    await existingCard.waitFor({ state: "visible", timeout: 15_000 });
    const connect = existingCard.locator("button").filter({ hasText: /Rabby/i }).first();
    await connect.click({ force: true });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-connect", 30_000, {
      chainName: CHAIN_NAME,
    });
    await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-siwe", 20_000);
  }
  await switchDappChain(dapp, extId, knownPages);
  const actualChainHex = await assertDappChain(dapp);
  await dapp.waitForTimeout(3_000);
  await dapp.screenshot({ path: resolve(OUT, "02-dashboard.png"), fullPage: true });
  console.log(`✓ Rabby connected, dashboard visible, chain=${actualChainHex}`);

  // Find the Deposit panel. The dashboard renders a "DEPOSIT TO PRIVATE
  // WALLET" section with an amount input + "Get Test USDC" + "Deposit"
  // buttons. The amount input has the same placeholder pattern used
  // throughout the app: "0.00". The Deposit button text is "Deposit".
  console.log("→ Locating Deposit panel...");

  // Scope to the deposit section so we don't accidentally hit other
  // numeric inputs (e.g. Withdraw panel).
  const depositSection = dapp
    .locator("section, div")
    .filter({ hasText: /Deposit to private wallet/i })
    .first();

  if (!(await depositSection.isVisible({ timeout: 5_000 }).catch(() => false))) {
    console.error("✘ Deposit panel not visible — dashboard layout may have changed");
    await dapp.screenshot({ path: resolve(OUT, "03-no-deposit-panel.png"), fullPage: true });
    await ctx.close();
    process.exit(10);
  }

  // Capture state before action.
  await dapp.screenshot({ path: resolve(OUT, "03-pre-deposit.png"), fullPage: true });

  // Fill the deposit amount. Use a section-scoped query.
  const amountInput = depositSection.locator('input[placeholder="0.00"]').first();
  await amountInput.waitFor({ state: "visible", timeout: 10_000 });
  await amountInput.fill(AMOUNT);
  console.log(`✓ Entered ${AMOUNT} USDC in Deposit input`);
  await dapp.screenshot({ path: resolve(OUT, "04-amount-filled.png"), fullPage: true });

  // Click Deposit button.
  const depositBtn = depositSection.locator("button").filter({ hasText: /^Deposit/i }).first();
  await depositBtn.waitFor({ state: "visible", timeout: 5_000 });
  const isEnabled = await depositBtn.isEnabled().catch(() => false);
  if (!isEnabled) {
    console.error("✘ Deposit button is disabled — Dave may not have plaintext USDC balance");
    await dapp.screenshot({ path: resolve(OUT, "05-deposit-disabled.png"), fullPage: true });
    await ctx.close();
    process.exit(11);
  }
  const beforeNonce = await publicClient.getTransactionCount({ address: DAVE, blockTag: "pending" });
  await depositBtn.click();
  console.log("✓ Deposit button clicked");
  await dapp.waitForTimeout(2_000);
  await dapp.screenshot({ path: resolve(OUT, "05-post-deposit-click.png"), fullPage: true });

  // Drive Rabby popups in sequence. First popup is usually approve()
  // for the TestUSDC → vault allowance. Second is the shield()
  // call itself. Some flows bundle both in one popup; handle both.
  console.log("→ Driving Rabby popup #1 (approve or shield)...");
  const popup1 = await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-deposit-1", 60_000);
  console.log(`  popup1: ${popup1.clicks} click(s), closed=${popup1.closed}`);

  // Sometimes a second popup fires for the actual shield after approve.
  console.log("→ Driving Rabby popup #2 (shield, if approve was separate)...");
  const popup2 = await waitAndConfirmRabbyPopup(ctx, extId, knownPages, OUT, "rabby-deposit-2", 30_000);
  console.log(`  popup2: ${popup2.clicks} click(s), closed=${popup2.closed}`);

  // Wait for success state — either an explorer link surfaces, the
  // dashboard balance updates, or the panel resets.
  console.log("→ Waiting for shield success state...");
  let txHash = "";
  for (let i = 0; i < 24; i++) {
    const href = await dapp
      .locator('a[href*="/tx/0x"]')
      .first()
      .getAttribute("href", { timeout: 5_000 })
      .catch(() => null);
    if (href) {
      const m = href.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
      if (m) {
        txHash = m[1];
        console.log(`✓ Tx hash captured: ${txHash}`);
        break;
      }
    }
    await dapp.waitForTimeout(5_000);
  }
  const txHashes = await txsFrom(DAVE, beforeNonce);
  if (!txHash && txHashes.length > 0) txHash = txHashes[txHashes.length - 1];
  const bodyText = ((await dapp.locator("body").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  const successState = /Shielding complete|Shielded\s+1\s+USDC|Deposited to vault/i.test(bodyText);

  await dapp.screenshot({ path: resolve(OUT, "06-final-state.png"), fullPage: true });

  // Write report.
  const md = [
    `# QA Deposit → Shield (live Vercel)`,
    `Generated: ${new Date().toISOString()}`,
    `URL base: ${VERCEL_URL}`,
    `Wallet: Dave (Rabby EOA)`,
    `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
    `Amount: ${AMOUNT} USDC`,
    ``,
    `## Result`,
    ``,
    txHash || successState
      ? `🟢 GREEN — ${txHash ? `Tx hash: [\`${txHash}\`](${EXPLORER_URL}/tx/${txHash})` : "Success state visible"}`
      : `🔴 RED — No tx hash captured within budget`,
    txHashes.length
      ? `\n## Chain transactions\n\n${txHashes.map((h) => `- [${h}](${EXPLORER_URL}/tx/${h})`).join("\n")}`
      : "",
    ``,
    `## Rabby popups`,
    ``,
    `- Popup 1 (approve/shield): ${popup1.clicks} clicks, closed=${popup1.closed}`,
    `- Popup 2 (shield, if separate): ${popup2.clicks} clicks, closed=${popup2.closed}`,
    ``,
    `## Screenshots`,
    ``,
    `- \`01-app-loaded.png\` — initial /app load`,
    `- \`02-dashboard.png\` — post-connect dashboard`,
    `- \`03-pre-deposit.png\` — dashboard with Deposit panel`,
    `- \`04-amount-filled.png\` — Deposit input filled with ${AMOUNT}`,
    `- \`05-post-deposit-click.png\` — after Deposit button click`,
    `- \`06-final-state.png\` — final dApp state`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(`\n✓ Report: ${resolve(OUT, "REPORT.md")}`);

  await ctx.close();
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(99);
});
