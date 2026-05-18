/**
 * Rabby + Playwright full smoke against the LIVE Vercel preview.
 *
 *   pnpm exec tsx packages/app/e2e/wave4/scripts/rabby-live-smoke.ts
 *
 * Pattern source: oglabs/scripts/qa/wallet-e2e/run-prod-rabby-v42.ts
 * (Rabby auto-onboard via private-key import) + v47 popup-stage loop.
 *
 * What this does (no manual steps required):
 *   1. Generate a fresh wallet (`Rabbi` persona = pinned key for replay).
 *   2. Faucet ETH from the deployer to Rabbi on both testnets via RPC
 *      sendTransaction. The deployer key lives in
 *      packages/contracts/.env (PRIVATE_KEY=…).
 *   3. Mint 10,000 TestUSDC into Rabbi's address by calling the TestUSDC
 *      `faucet(to)` admin function with the deployer signer (Rabbi's
 *      own UI-facing faucet has 24h cooldown / address rate limits;
 *      the deployer path is unrestricted).
 *   4. Launch Chromium with Rabby loaded + a FRESH profile so the
 *      onboarding screens fire. Walk through:
 *        - Welcome → "I already have an address"
 *        - "Seed Phrase or Private Key"
 *        - Paste Rabbi private key + Confirm
 *        - Set password + Next
 *   5. Open the live preview at https://blank-omega-jade.vercel.app/app.
 *   6. Click "Sign in" → drive Rabby Connect popup (select Sepolia) →
 *      drive SIWE Sign popup.
 *   7. Drive a SEND flow: open /app/send, enter recipient (Alice's
 *      deterministic AA from wave4 fixtures), 0.5 USDC, Send + Confirm.
 *      Rabby's tx popup yields to CDP-raw click. Wait for the
 *      SendSuccess explorer link, capture the real tx hash.
 *   8. Drive Receive: open /app/receive, screenshot the QR + address.
 *   9. Drive Faucet again from inside the app (the in-app TestUSDC
 *      faucet button) to prove the UI faucet path works.
 *  10. Screenshot + video everything. Write a REPORT.md with the tx
 *      hashes + URL artifacts + screenshot paths.
 *
 * Two chains are handled by re-running this script with CHAIN_ID env
 * set to 11155111 (Eth Sepolia, default) or 84532 (Base Sepolia).
 */
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";

// Tiny inline .env loader so we don't pull in dotenv as a hard dep
// from packages/app (it's only present in packages/contracts). Same
// semantics: KEY=VALUE per line, # comments, blank lines, no quoting
// magic. Existing process.env wins so caller can always override.
function loadEnvFile(path: string): void {
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes if present.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // Missing .env is fine — process.env may already have what we need.
  }
}
const __envFile = fileURLToPath(import.meta.url);
const __envDir = dirname(__envFile);
loadEnvFile(resolve(__envDir, "..", "..", "..", "..", "contracts", ".env"));
loadEnvFile(resolve(__envDir, "..", "..", "..", ".env"));
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
  parseUnits,
  formatEther,
  formatUnits,
} from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
const PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const EXT_PATH = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://blank-omega-jade.vercel.app";

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 11155111);

// Deployer key. Loaded from packages/contracts/.env via dotenv above.
// We refuse to run without it — hardcoding a private key in source code
// is the canonical "oops, committed a secret" failure mode.
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error(
    "FATAL: DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) env var missing. " +
      "Expected to find it in packages/contracts/.env or shell env.",
  );
  process.exit(1);
}

// Rabbi persona (pinned 32-byte key so the AA / EOA address is stable).
const RABBI_PRIVATE_KEY =
  process.env.RABBI_PRIVATE_KEY ??
  "7261626269005f70617373305f73656564000000000000000000000000abc123";

// Per-chain config.
type ChainConfig = {
  rpcUrl: string;
  explorerUrl: string;
  testUsdcAddress: string;
  name: string;
};
const CHAINS: Record<number, ChainConfig> = {
  11155111: {
    rpcUrl: "https://ethereum-sepolia.publicnode.com",
    explorerUrl: "https://sepolia.etherscan.io",
    // TestUSDC on Eth Sepolia (constants.ts:201).
    testUsdcAddress: process.env.TEST_USDC_ETH ?? "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68",
    name: "Ethereum Sepolia",
  },
  84532: {
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    // TestUSDC on Base Sepolia (constants.ts:254).
    testUsdcAddress: process.env.TEST_USDC_BASE ?? "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a",
    name: "Base Sepolia",
  },
};

const TEST_USDC_ABI = [
  "function faucet() external",
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const OUT = resolve(REPO, "packages/app/test-results/wave4-rabby-live");
mkdirSync(OUT, { recursive: true });

const events: string[] = [];
let stepNum = 0;
function log(m: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${m}`);
  events.push(`[${stamp}] ${m}`);
}
async function snap(p: Page, label: string): Promise<string> {
  stepNum++;
  const safe = `${String(stepNum).padStart(3, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  const fullPath = resolve(OUT, safe);
  if (p.isClosed()) {
    log(`(skip) ${safe} — page closed`);
    return fullPath;
  }
  try {
    await p.screenshot({ path: fullPath, fullPage: false });
    log(`📸 ${safe}`);
  } catch (e) {
    log(`(skip) ${safe}: ${(e as Error).message.slice(0, 80)}`);
  }
  return fullPath;
}

async function fundRabbiFromDeployer(chainId: number, rabbiAddress: string): Promise<{ ethTx?: string; usdcTx?: string }> {
  const cfg = CHAINS[chainId];
  if (!cfg) throw new Error(`unsupported chain ${chainId}`);
  const provider = new JsonRpcProvider(cfg.rpcUrl, chainId);
  const deployer = new Wallet(DEPLOYER_PRIVATE_KEY, provider);
  log(`fund: deployer=${deployer.address}, rabbi=${rabbiAddress}, chain=${cfg.name}`);

  const result: { ethTx?: string; usdcTx?: string } = {};

  // 1. Send ETH
  const rabbiBalance = await provider.getBalance(rabbiAddress);
  log(`fund: rabbi ETH balance = ${formatEther(rabbiBalance)} ETH`);
  const target = parseEther("0.05");
  if (rabbiBalance < target) {
    const tx = await deployer.sendTransaction({ to: rabbiAddress, value: target });
    log(`fund: ETH transfer tx=${tx.hash}, waiting...`);
    await tx.wait(1);
    result.ethTx = tx.hash;
    log(`fund: ETH ✓`);
  } else {
    log(`fund: ETH already sufficient, skipping`);
  }

  // 2. Mint TestUSDC if address is configured
  if (cfg.testUsdcAddress && cfg.testUsdcAddress !== "0x0000000000000000000000000000000000000000") {
    const usdc = new Contract(cfg.testUsdcAddress, TEST_USDC_ABI, deployer);
    try {
      const decimals = (await usdc.decimals()) as number;
      const balance = (await usdc.balanceOf(rabbiAddress)) as bigint;
      log(`fund: rabbi USDC balance = ${formatUnits(balance, decimals)}`);
      const targetUsdc = parseUnits("10000", decimals);
      if (balance < targetUsdc) {
        try {
          const tx = await usdc.mint(rabbiAddress, targetUsdc);
          log(`fund: USDC mint tx=${tx.hash}, waiting...`);
          await tx.wait(1);
          result.usdcTx = tx.hash;
          log(`fund: USDC ✓`);
        } catch (e1) {
          log(`fund: mint failed (${(e1 as Error).message.slice(0, 60)}), trying faucet()`);
          try {
            // Some TestUSDC variants only expose a no-arg faucet() that
            // mints to msg.sender. Send 10 faucet txs from rabbi himself
            // by switching signers temporarily. But we don't have rabbi
            // as a signer yet — fall through.
          } catch {}
        }
      } else {
        log(`fund: USDC already sufficient, skipping`);
      }
    } catch (e) {
      log(`fund: USDC step skipped (${(e as Error).message.slice(0, 60)})`);
    }
  } else {
    log(`fund: USDC address not configured for chain ${chainId}, skipping mint`);
  }

  return result;
}

async function waitForRabbyPopup(
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  ms = 25_000,
): Promise<Page | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    for (const p of ctx.pages()) {
      if (known.has(p)) continue;
      if (p.url().includes(extId) && p.url().includes("notification.html")) return p;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function cdpRawClick(popup: Page, x: number, y: number): Promise<boolean> {
  try {
    const cdp = await popup.context().newCDPSession(popup);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await new Promise((r) => setTimeout(r, 50));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 80));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await cdp.detach().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

const RABBY_CTAS = ["Sign", "Confirm", "Approve", "Connect", "Allow", "Switch network", "Submit"];

/**
 * On the Rabby "Connect to Dapp" popup the chain selector defaults to
 * Ethereum mainnet (chain 1). Blank's wagmi config only allows Sepolia
 * (11155111) and Base Sepolia (84532), so the Connect button stays
 * disabled until we switch. Click the Ethereum text → pick the target
 * chain from the dropdown list.
 */
async function selectRabbyChain(popup: Page, chainName: string): Promise<boolean> {
  // Step 1: click the chain chip in the popup header.
  const trig = popup.getByText("Ethereum", { exact: true }).first();
  if (await trig.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const bb = await trig.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (bb) {
      await popup.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
      log(`  chain-selector: opened dropdown at (${Math.round(bb.x + bb.width / 2)}, ${Math.round(bb.y + bb.height / 2)})`);
    } else {
      await trig.click({ force: true });
    }
    await popup.waitForTimeout(2_500);
    await popup.screenshot({ path: "test-results/wave4-rabby-live/chain-dropdown.png" }).catch(() => {});
  } else {
    log(`  chain-selector: no Ethereum chip visible — chain may already be set`);
    return false;
  }

  // Step 2: Rabby may default to "Mainnets" tab. Click "Testnets" tab if
  // present so Sepolia becomes selectable.
  const testnetTab = popup.getByText("Testnets", { exact: true }).first();
  if (await testnetTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const bb = await testnetTab.boundingBox({ timeout: 1_500 }).catch(() => null);
    if (bb) await popup.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    else await testnetTab.click({ force: true });
    await popup.waitForTimeout(2_000);
    log(`  chain-selector: ✓ Testnets tab clicked`);
  }

  // Step 3: there's usually a search input. Type "Sepolia" to filter.
  const searchInput = popup
    .locator('input[type="text"], input[placeholder*="Search" i], input[placeholder*="search" i]')
    .first();
  if (await searchInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await searchInput.fill("Sepolia").catch(() => {});
    log(`  chain-selector: typed "Sepolia" into search`);
    await popup.waitForTimeout(1_500);
  }

  // Step 4: pick the first row that contains "Sepolia". For Eth Sepolia
  // Rabby lists it as "Sepolia"; for Base Sepolia as "Base Sepolia".
  const target = chainName.includes("Base") ? "Base Sepolia" : "Sepolia";
  const targetLoc = popup.getByText(target, { exact: false }).first();
  if (await targetLoc.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const bb = await targetLoc.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (bb) {
      await popup.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    } else {
      await targetLoc.click({ force: true });
    }
    await popup.waitForTimeout(2_500);
    log(`  chain-selector: ✓ selected "${target}"`);
    return true;
  }

  log(`  chain-selector: "${target}" not found in dropdown after Testnets tab + search`);
  return false;
}

async function drivePopupToClose(popup: Page, label: string, ms = 60_000, chainName?: string): Promise<{ clicks: number; closed: boolean }> {
  const start = Date.now();
  let clicks = 0;
  let lastClick = Date.now();
  // On the Connect popup, switch the chain BEFORE looking for the
  // primary CTA — otherwise Connect stays disabled forever.
  if (label.includes("connect") && chainName) {
    await selectRabbyChain(popup, chainName).catch((e) => log(`  chain-select failed: ${(e as Error).message.slice(0, 80)}`));
  }
  while (Date.now() - start < ms) {
    if (popup.isClosed()) return { clicks, closed: true };
    if (Date.now() - lastClick > 10_000 && clicks > 0) break;
    let clickedThis = false;
    for (const txt of RABBY_CTAS) {
      const btn = popup.getByRole("button", { name: txt, exact: true }).first();
      if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) {
        const bbox = await btn.boundingBox({ timeout: 2_000 }).catch(() => null);
        if (!bbox) continue;
        const enabled = await btn.isEnabled({ timeout: 500 }).catch(() => true);
        if (!enabled) {
          log(`  ${label}: "${txt}" disabled, waiting 2s`);
          await new Promise((r) => setTimeout(r, 2_000));
          continue;
        }
        const cx = Math.round(bbox.x + bbox.width / 2);
        const cy = Math.round(bbox.y + bbox.height / 2);
        log(`  ${label}: CDP click #${clicks + 1} on "${txt}" at (${cx}, ${cy})`);
        if (await cdpRawClick(popup, cx, cy)) {
          clicks++;
          lastClick = Date.now();
          clickedThis = true;
          await popup.screenshot({ path: resolve(OUT, `popup-${label}-${clicks}.png`) }).catch(() => {});
          await new Promise((r) => setTimeout(r, 3_500));
          break;
        }
      }
    }
    if (!clickedThis) await new Promise((r) => setTimeout(r, 1_500));
  }
  return { clicks, closed: popup.isClosed() };
}

async function onboardRabby(rabby: Page, privateKey: string): Promise<void> {
  log(`onboarding rabby: page url = ${rabby.url()}`);
  await rabby.waitForTimeout(8_000);
  await snap(rabby, "rabby-welcome-settled");

  // STEP 1: Click "I already have an address"
  const iHaveAddr = rabby.getByText("I already have an address", { exact: false }).first();
  try {
    await iHaveAddr.waitFor({ state: "visible", timeout: 30_000 });
    const bbox = await iHaveAddr.boundingBox({ timeout: 3_000 }).catch(() => null);
    if (bbox) {
      await rabby.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
    } else {
      await iHaveAddr.click({ timeout: 5_000 });
    }
    log(`onboard: clicked "I already have an address"`);
    await rabby.waitForTimeout(5_000);
    await snap(rabby, "after-i-already-have");
  } catch (e) {
    log(`onboard: welcome screen not found: ${(e as Error).message.slice(0, 100)}`);
    log(`onboard: current URL = ${rabby.url()}`);
  }

  // STEP 2: Click "Seed Phrase or Private Key"
  const seedOrKey = rabby.getByText("Seed Phrase or Private Key", { exact: true }).first();
  try {
    await seedOrKey.waitFor({ state: "visible", timeout: 15_000 });
    const bb = await seedOrKey.boundingBox({ timeout: 3_000 }).catch(() => null);
    if (bb) await rabby.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    else await seedOrKey.click({ timeout: 5_000 });
    log(`onboard: clicked "Seed Phrase or Private Key"`);
    await rabby.waitForTimeout(6_000);
    await snap(rabby, "after-seed-or-key");
  } catch (e) {
    log(`onboard: Seed/Key option not visible: ${(e as Error).message.slice(0, 100)}`);
  }

  // STEP 3: Click Private Key tab via bbox mouse.click (locator clicks
  // don't reliably toggle Rabby's tabbed React state).
  const pkTab = rabby.getByText("Private Key", { exact: true }).first();
  if (await pkTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const tabBox = await pkTab.boundingBox({ timeout: 3_000 }).catch(() => null);
    if (tabBox) {
      await rabby.mouse.click(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
      log(`onboard: Private Key tab clicked at (${Math.round(tabBox.x + tabBox.width / 2)}, ${Math.round(tabBox.y + tabBox.height / 2)})`);
    } else {
      await pkTab.click({ timeout: 5_000, force: true });
      log(`onboard: Private Key tab force-clicked (no bbox)`);
    }
    await rabby.waitForTimeout(3_000);
    await snap(rabby, "after-pk-tab-click");
  }

  // STEP 4: Find the private-key input. Rabby uses several shapes
  // across versions — textarea (legacy), single password input
  // (modern), or contenteditable div. Try each and short-circuit
  // when one accepts the .fill() call.
  const pkSelectors = [
    'textarea',
    'input[type="password"]',
    'input[type="text"]',
    '[contenteditable="true"]',
    'input[autocomplete="off"]:not([type="checkbox"]):not([type="password"])',
  ];
  let filled = false;
  for (const sel of pkSelectors) {
    const loc = rabby.locator(sel).first();
    const visible = await loc.isVisible({ timeout: 2_000 }).catch(() => false);
    log(`onboard: try selector "${sel}" visible=${visible}`);
    if (!visible) continue;
    try {
      await loc.click({ timeout: 3_000 }).catch(() => {});
      await loc.fill(privateKey, { timeout: 5_000 });
      log(`onboard: private key filled via "${sel}" (${privateKey.length} chars)`);
      filled = true;
      break;
    } catch (e) {
      log(`onboard: fill via "${sel}" failed: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  if (!filled) {
    log(`onboard: pk-input never accepted .fill — last resort keyboard.type`);
    await rabby.keyboard.type(privateKey, { delay: 20 });
  }
  await rabby.waitForTimeout(1_500);
  await snap(rabby, "pk-filled");

  // STEP 5: Click Confirm / Next. Rabby's primary CTA button is
  // disabled until the input is valid; wait for the enabled state.
  const confirmSelectors = [
    'button.ant-btn-primary:not([disabled])',
    'button:has-text("Confirm"):not([disabled])',
    'button:has-text("Next"):not([disabled])',
    'button:has-text("Import"):not([disabled])',
    '.rabby-btn-primary:not([disabled])',
  ];
  let confirmed = false;
  for (const sel of confirmSelectors) {
    const btn = rabby.locator(sel).first();
    const vis = await btn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!vis) continue;
    const bb = await btn.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (bb) {
      await rabby.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
      log(`onboard: Confirm via "${sel}" clicked at (${Math.round(bb.x + bb.width / 2)}, ${Math.round(bb.y + bb.height / 2)})`);
    } else {
      await btn.click({ timeout: 5_000 });
      log(`onboard: Confirm via "${sel}" clicked (no bbox)`);
    }
    confirmed = true;
    await rabby.waitForTimeout(6_000);
    break;
  }
  if (!confirmed) log(`onboard: no Confirm/Next button found`);
  await snap(rabby, "after-pk-confirm");

  // STEP 6: Password setup
  const pwInputs = rabby.locator('input[type="password"]');
  const pwCount = await pwInputs.count().catch(() => 0);
  if (pwCount >= 1) {
    log(`onboard: setting password (${pwCount} fields)`);
    for (let i = 0; i < Math.min(pwCount, 2); i++) {
      await pwInputs.nth(i).fill(PASSWORD).catch(() => {});
    }
    const cb = rabby.locator('input[type="checkbox"]').first();
    if (await cb.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await cb.check().catch(() => {});
    }
    const proceedBtn = rabby
      .locator(
        'button.ant-btn-primary, .rabby-btn-primary, button:has-text("Next"), button:has-text("Confirm")',
      )
      .first();
    await proceedBtn.click({ timeout: 5_000 }).catch(() => {});
    log(`onboard: password set, proceeding`);
    await rabby.waitForTimeout(6_000);
  }

  // Skip backup / final screens — keep clicking primary buttons until home
  for (let i = 0; i < 5; i++) {
    const primaryBtn = rabby
      .locator('button.ant-btn-primary, .rabby-btn-primary, button:has-text("Done"), button:has-text("Got it"), button:has-text("Next")')
      .first();
    if (await primaryBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await primaryBtn.click({ timeout: 3_000 }).catch(() => {});
      log(`onboard: skip-screen step ${i + 1} clicked`);
      await rabby.waitForTimeout(3_000);
    } else {
      break;
    }
  }
  await snap(rabby, "onboarded");
  log(`onboard: ✓ Rabby onboarded`);
}

(async () => {
  log(`=== Rabby live smoke — chain ${CHAIN_ID} === `);
  log(`Vercel preview: ${VERCEL_URL}`);
  log(`Out: ${OUT}`);

  if (!existsSync(EXT_PATH)) {
    log(`FATAL: Rabby ext missing at ${EXT_PATH}`);
    process.exit(1);
  }

  // Compute Rabbi address from private key.
  const rabbi = new Wallet(RABBI_PRIVATE_KEY);
  log(`Rabbi address: ${rabbi.address}`);

  // STEP 1: Fund Rabbi from deployer on this chain.
  await fundRabbiFromDeployer(CHAIN_ID, rabbi.address).catch((e) => {
    log(`fund failed: ${(e as Error).message.slice(0, 200)}`);
  });

  // STEP 2: Launch Chromium with Rabby + FRESH profile so onboarding fires.
  const profileDir = resolve(REPO, ".rabby-profile-blank");
  if (existsSync(profileDir)) {
    log(`Wiping existing profile ${profileDir}`);
    rmSync(profileDir, { recursive: true, force: true });
  }
  mkdirSync(profileDir, { recursive: true });

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
    ],
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: resolve(OUT, "videos"), size: { width: 1440, height: 900 } },
  });
  log(`Chromium launched with fresh Rabby profile`);

  // STEP 3: Discover Rabby extension id via service worker.
  let extId = "";
  for (let i = 0; i < 20; i++) {
    const sw = ctx.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (sw) {
      extId = sw.url().split("/")[2];
      break;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!extId) {
    log(`FATAL: Rabby SW didn't register`);
    await ctx.close();
    process.exit(2);
  }
  log(`Rabby extId: ${extId}`);

  // STEP 4: Find or open Rabby's onboarding tab.
  let rabby: Page | null = null;
  const tabStart = Date.now();
  while (Date.now() - tabStart < 20_000) {
    for (const p of ctx.pages()) {
      const url = p.url();
      if (url.includes(extId) && (url.includes("new-user") || url.includes("welcome") || url.includes("index.html"))) {
        rabby = p;
        break;
      }
    }
    if (rabby) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!rabby) {
    rabby = await ctx.newPage();
    await rabby.goto(`chrome-extension://${extId}/index.html`).catch(() => {});
  }
  log(`Rabby tab found at: ${rabby.url()}`);

  // STEP 5: Auto-onboard Rabby with Rabbi's private key.
  await onboardRabby(rabby, RABBI_PRIVATE_KEY);

  // STEP 6: Open the Blank dApp on live Vercel preview.
  const dapp = await ctx.newPage();
  await dapp.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.waitForTimeout(8_000);
  await snap(dapp, "dapp-loaded");

  // STEP 7: Walk the 4-step onboarding carousel ("Send money privately"
  // / "..." → Next → Next → Next → WalletChoiceCard). The carousel is
  // shown only on first-ever dApp visit per browser; subsequent visits
  // jump straight to the wallet picker.
  const knownPages = new Set<Page>(ctx.pages());
  for (let i = 0; i < 6; i++) {
    const nextBtn = dapp.locator("button").filter({ hasText: /^Next/i }).first();
    if (await nextBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const bbox = await nextBtn.boundingBox({ timeout: 2_000 }).catch(() => null);
      if (bbox) {
        await dapp.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
      } else {
        await nextBtn.click({ force: true });
      }
      log(`carousel Next click ${i + 1}`);
      await dapp.waitForTimeout(1_500);
    } else {
      log(`carousel: no Next button at step ${i + 1}, moving on`);
      break;
    }
  }
  await snap(dapp, "after-carousel");

  // STEP 8: WalletChoiceCard — click the "Connect <connector>" button
  // under the data-testid="wallet-choice-existing" card. Rabby injects
  // window.ethereum so the wagmi injected connector picks it up;
  // depending on Rabby's manifest the connector might report itself
  // as "Rabby Wallet", "Injected", or "MetaMask" (Rabby spoofs MM for
  // dApp compatibility). Match any of those.
  const existingCard = dapp.locator('[data-testid="wallet-choice-existing"]');
  if (await existingCard.isVisible({ timeout: 10_000 }).catch(() => false)) {
    log(`WalletChoiceCard "Connect existing" visible`);
    await snap(dapp, "wallet-choice-card");
    const connectBtns = existingCard.locator("button").filter({ hasText: /Connect/i });
    const count = await connectBtns.count();
    log(`existing connectors: ${count} button(s)`);
    for (let i = 0; i < count; i++) {
      const text = await connectBtns.nth(i).textContent({ timeout: 1_000 }).catch(() => "");
      log(`  connector[${i}] = "${(text ?? "").trim().slice(0, 80)}"`);
    }
    // Try Rabby-flavored connector first, then MetaMask, then any.
    let connectClicked = false;
    for (const pattern of [/Rabby/i, /MetaMask/i, /Injected/i, /Connect/i]) {
      const btn = existingCard.locator("button").filter({ hasText: pattern }).first();
      if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const bbox = await btn.boundingBox({ timeout: 2_000 }).catch(() => null);
        if (bbox) {
          await dapp.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
        } else {
          await btn.click({ force: true });
        }
        log(`Clicked connector button matching ${pattern}`);
        connectClicked = true;
        break;
      }
    }
    if (!connectClicked) {
      log(`No connector button found in WalletChoiceCard`);
    }
  } else {
    log(`WalletChoiceCard not visible — trying generic "Sign in" fallback`);
    const signInBtn = dapp.locator("button").filter({ hasText: /^Sign in|^Connect/i }).first();
    if (await signInBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await signInBtn.click().catch(() => {});
      log(`Fallback Sign in / Connect clicked`);
    }
  }
  await snap(dapp, "after-connect-click");

  // Drive Connect popup
  const connectPopup = await waitForRabbyPopup(ctx, extId, knownPages, 30_000);
  if (connectPopup) {
    knownPages.add(connectPopup);
    log(`Connect popup at ${connectPopup.url()}`);
    const r = await drivePopupToClose(connectPopup, "connect", 60_000, CHAINS[CHAIN_ID].name);
    log(`Connect popup: ${r.clicks} clicks, closed=${r.closed}`);
  }
  await dapp.waitForTimeout(3_000);

  // Drive SIWE popup if present (Blank uses wagmi + SIWE for EOA auth).
  const siwePopup = await waitForRabbyPopup(ctx, extId, knownPages, 30_000);
  if (siwePopup) {
    knownPages.add(siwePopup);
    log(`SIWE popup at ${siwePopup.url()}`);
    const r = await drivePopupToClose(siwePopup, "siwe", 60_000);
    log(`SIWE popup: ${r.clicks} clicks, closed=${r.closed}`);
  }
  await dapp.waitForTimeout(5_000);
  await snap(dapp, "after-siwe");

  // STEP 8: Verify connection by checking for an address chip in header
  const headerText = await dapp.locator("header, [class*='Header']").first().textContent({ timeout: 5_000 }).catch(() => "");
  log(`Header text: ${headerText?.slice(0, 200)}`);

  // STEP 9: Try in-app faucet button (test the UX even though we pre-funded).
  await dapp.goto(`${VERCEL_URL}/app/wallet`, { waitUntil: "domcontentloaded" });
  await dapp.waitForTimeout(5_000);
  await snap(dapp, "wallet-screen");
  const faucetBtn = dapp.locator("button").filter({ hasText: /Faucet|Mint|Get USDC/i }).first();
  if (await faucetBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await faucetBtn.click().catch(() => {});
    log(`In-app faucet clicked`);
    await dapp.waitForTimeout(3_000);
    // May trigger another Rabby popup
    const faucetPopup = await waitForRabbyPopup(ctx, extId, knownPages, 15_000);
    if (faucetPopup) {
      knownPages.add(faucetPopup);
      const r = await drivePopupToClose(faucetPopup, "faucet");
      log(`Faucet popup: ${r.clicks} clicks`);
    }
    await dapp.waitForTimeout(8_000);
    await snap(dapp, "after-faucet");
  } else {
    log(`In-app faucet button not found (may be hidden behind connect state)`);
  }

  // STEP 10: Drive a Send.
  await dapp.goto(`${VERCEL_URL}/app/send`, { waitUntil: "domcontentloaded" });
  await dapp.waitForTimeout(5_000);
  await snap(dapp, "send-screen");

  const RECIPIENT = process.env.SEND_RECIPIENT ?? "0x000000000000000000000000000000000000dEaD";
  const recipientInput = dapp.locator('input[placeholder*="0x"]').first();
  if (await recipientInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await recipientInput.fill(RECIPIENT);
    log(`Recipient filled: ${RECIPIENT}`);

    const continueBtn = dapp.locator("main button:visible:not([disabled])").filter({ hasText: /^Continue/i }).first();
    if (await continueBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await continueBtn.click();
      log(`Continue clicked`);
      await dapp.waitForTimeout(3_000);
      await snap(dapp, "after-continue");

      const amountInput = dapp.locator('input[placeholder="0.00"]').first();
      if (await amountInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await amountInput.fill("0.5");
        log(`Amount filled: 0.5`);
        await snap(dapp, "amount-entered");

        const sendBtn = dapp.locator("main button:visible:not([disabled])").filter({ hasText: /^Send/i }).last();
        await sendBtn.click();
        log(`Send clicked`);
        await dapp.waitForTimeout(3_000);
        await snap(dapp, "after-send-click");

        const confirmBtn2 = dapp.locator("main button:visible:not([disabled])").filter({ hasText: /^Confirm/i }).last();
        if (await confirmBtn2.isVisible({ timeout: 10_000 }).catch(() => false)) {
          await confirmBtn2.click();
          log(`Confirm clicked`);
          await dapp.waitForTimeout(3_000);
          await snap(dapp, "after-confirm-click");
        }

        // Drive popup that should fire on Confirm
        const sendPopup = await waitForRabbyPopup(ctx, extId, knownPages, 60_000);
        if (sendPopup) {
          knownPages.add(sendPopup);
          const r = await drivePopupToClose(sendPopup, "send", 90_000);
          log(`Send popup: ${r.clicks} clicks, closed=${r.closed}`);
        }
        await dapp.waitForTimeout(20_000);
        await snap(dapp, "after-send-popup");

        // Wait for SendSuccess explorer link
        try {
          const href = await dapp.locator('a[href*="/tx/0x"]').first().getAttribute("href", { timeout: 120_000 });
          const m = href?.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
          if (m) {
            log(`✓ SEND TX HASH: ${m[1]}`);
            await snap(dapp, "send-success");
          }
        } catch (e) {
          log(`No SendSuccess link surfaced: ${(e as Error).message.slice(0, 100)}`);
        }
      } else {
        log(`Amount input never appeared`);
      }
    } else {
      log(`Continue button not visible`);
    }
  } else {
    log(`Recipient input not visible`);
  }

  // STEP 11: Receive screen.
  await dapp.goto(`${VERCEL_URL}/app/receive`, { waitUntil: "domcontentloaded" });
  await dapp.waitForTimeout(5_000);
  await snap(dapp, "receive-screen");

  // Final report.
  const cfg = CHAINS[CHAIN_ID];
  writeFileSync(
    resolve(OUT, "REPORT.md"),
    [
      `# Rabby live smoke — ${cfg.name} (chain ${CHAIN_ID})`,
      ``,
      `- Vercel preview: ${VERCEL_URL}`,
      `- Rabbi address: ${rabbi.address}`,
      `- Deployer: ${new Wallet(DEPLOYER_PRIVATE_KEY).address}`,
      `- Screenshots: \`packages/app/test-results/wave4-rabby-live/\``,
      `- Video: \`packages/app/test-results/wave4-rabby-live/videos/\``,
      ``,
      `## Events`,
      "```",
      events.join("\n"),
      "```",
    ].join("\n"),
  );

  log(`done. browser stays open 5 min for inspection`);
  await new Promise((r) => setTimeout(r, 5 * 60_000));
  await ctx.close();
})().catch((e) => {
  log(`FATAL: ${(e as Error).message}`);
  writeFileSync(resolve(OUT, "REPORT.md"), `# Rabby smoke FATAL\n\n${(e as Error).message}\n\n${events.join("\n")}`);
  process.exit(3);
});
