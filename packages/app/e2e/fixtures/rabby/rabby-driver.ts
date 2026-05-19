// Wave 4 E2E support, Rabby launcher + popup driver.
//
// Why Rabby instead of MetaMask: the project owner's prior Playwright work
// (oglabs/scripts/qa/wallet-e2e/run-prod-rabby-v*) demonstrated that
// MetaMask's MV3 popup loop is unreliable under automation while Rabby's
// notification.html surface yields to CDP-raw clicks consistently. This
// driver ports that pattern to Blank's wave4 harness.
//
// Profile mode: persistent. Set RABBY_PROFILE_DIR (default
// ${repo}/.rabby-profile) to a directory that already contains Dave's
// imported seed + the dApp's site-permission grant. First-time setup
// happens through e2e/fixtures/rabby/setup-rabby-profile.ts which walks
// the user through Rabby's import flow once; later runs just unlock.
//
// CDP-raw click is the critical strategy. Playwright's `click()` regularly
// silently drops on Rabby's notification.html because the popup React tree
// repaints between hover + press events. Dispatching the raw Input
// events via CDPSession bypasses that and lands the click reliably.

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const RABBY_EXT_DIR = path.resolve(__dirname, "ext");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
export const DEFAULT_RABBY_PROFILE_DIR = path.resolve(REPO_ROOT, ".rabby-profile");

export interface RabbyHandles {
  context: BrowserContext;
  rabbyPage: Page;
  rabbyExtensionId: string;
  shotsDir: string;
  profileDir: string;
}

/**
 * Launch Chromium with Rabby side-loaded. Uses a persistent profile dir so
 * Dave's imported seed survives between phases + chains. Caller is
 * responsible for first-time setup (seed import) via setup-rabby-profile.
 */
export async function launchRabby(opts: {
  shotsDir: string;
  headless?: boolean;
  profileDir?: string;
  viewport?: { width: number; height: number };
}): Promise<RabbyHandles> {
  if (!fs.existsSync(RABBY_EXT_DIR)) {
    throw new Error(
      `Rabby extension dist not found at ${RABBY_EXT_DIR}. ` +
        `Copy the unpacked extension (e.g. from oglabs's wallet-e2e/rabby/extension/) ` +
        `or unpack a fresh Rabby.zip into that directory.`,
    );
  }
  const profileDir = opts.profileDir ?? DEFAULT_RABBY_PROFILE_DIR;
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(opts.shotsDir, { recursive: true });

  const viewport = opts.viewport ?? { width: 1280, height: 800 };

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? false, // Rabby's MV3 SW needs a real Chromium
    viewport,
    recordVideo: { dir: opts.shotsDir, size: viewport },
    args: [
      `--disable-extensions-except=${RABBY_EXT_DIR}`,
      `--load-extension=${RABBY_EXT_DIR}`,
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });

  // Wait for the Rabby service worker to register. The SW URL holds the
  // canonical extension ID we need for notification.html popup detection.
  let extensionId = "";
  const swStart = Date.now();
  while (Date.now() - swStart < 30_000) {
    const sw = context.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (sw) {
      extensionId = sw.url().split("/")[2];
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!extensionId) {
    throw new Error("Rabby service worker did not register within 30s. Is the extension dist valid?");
  }

  // Open Rabby's home tab. If the profile is already seeded this lands on
  // the unlock-password screen; otherwise it shows Rabby's first-run
  // onboarding (Get Started / Import Seed Phrase / Connect Hardware).
  const rabbyPage = await context.newPage();
  await rabbyPage.goto(`chrome-extension://${extensionId}/index.html`).catch(() => {});
  await rabbyPage.waitForTimeout(3_000);

  return { context, rabbyPage, rabbyExtensionId: extensionId, shotsDir: opts.shotsDir, profileDir };
}

/**
 * If the Rabby home page is showing the unlock screen, type the password +
 * press Enter. No-op when the profile is already unlocked or first-run.
 */
export async function unlockRabby(rabbyPage: Page, password: string): Promise<boolean> {
  const pw = rabbyPage.locator('input[type="password"]').first();
  const visible = await pw.isVisible({ timeout: 3_000 }).catch(() => false);
  if (!visible) return false;
  await pw.click({ timeout: 3_000 });
  await rabbyPage.keyboard.type(password, { delay: 50 });
  await rabbyPage.keyboard.press("Enter");
  await rabbyPage.waitForTimeout(3_500);
  return true;
}

/**
 * Enable Rabby's testnet visibility (Settings → "Enable Testnets")
 * once per profile so the Connect popup's chain dropdown actually
 * lists Sepolia + Base Sepolia. Without this, the Testnets tab in
 * the chain switcher shows "No chains" and the Connect button stays
 * disabled. Idempotent — no-op if already enabled.
 *
 * Ported from scripts/rabby-live-smoke.ts step 5b.
 */
export async function enableRabbyTestnets(
  rabbyPage: Page,
  extensionId: string,
): Promise<boolean> {
  await rabbyPage.goto(`chrome-extension://${extensionId}/index.html#/settings`).catch(() => {});
  await rabbyPage.waitForTimeout(3_500);

  // First, find the row whose label mentions "testnet". Rabby copies the
  // label text inside a div/label sibling of the actual <button
  // role="switch"> or <input type="checkbox">. We scope to the row,
  // then find the switch inside it, then probe its aria-checked.
  const row = rabbyPage
    .locator("div, label")
    .filter({ hasText: /testnet/i })
    .first();
  if (!(await row.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await rabbyPage.goto(`chrome-extension://${extensionId}/index.html`).catch(() => {});
    return false;
  }

  // Detect current state via aria-checked OR via Rabby's Ant Design
  // class convention (`.ant-switch-checked` when on).
  const sw = row
    .locator('[role="switch"], button.ant-switch, .ant-switch, input[type="checkbox"]')
    .first();
  let alreadyOn = false;
  if (await sw.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const aria = await sw.getAttribute("aria-checked").catch(() => null);
    if (aria === "true") {
      alreadyOn = true;
    } else {
      const cls = await sw.getAttribute("class").catch(() => "");
      if (cls && /\bant-switch-checked\b/.test(cls)) alreadyOn = true;
    }
  }
  if (alreadyOn) {
    await rabbyPage.goto(`chrome-extension://${extensionId}/index.html`).catch(() => {});
    await rabbyPage.waitForTimeout(800);
    return false; // no-op, already on
  }

  // Click the switch — prefer hitting the actual control. Fall back to
  // the right edge of the row if the switch isn't directly clickable.
  let toggled = false;
  if (await sw.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await sw.click({ timeout: 2_500, force: true }).catch(() => {});
    toggled = true;
  } else {
    const bb = await row.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (bb) {
      await rabbyPage.mouse.click(Math.round(bb.x + bb.width - 24), Math.round(bb.y + bb.height / 2));
      toggled = true;
    }
  }
  await rabbyPage.waitForTimeout(1_500);
  await rabbyPage.goto(`chrome-extension://${extensionId}/index.html`).catch(() => {});
  await rabbyPage.waitForTimeout(1_000);
  return toggled;
}

/**
 * Dismiss Rabby's "What's new" patch-notes modal if it surfaces on the
 * home tab after unlock. The modal blocks no further interaction on the
 * home tab itself (notification popups still surface) but its presence
 * makes screenshots harder to read and risks intercepting future clicks
 * if the test ever interacts with the home tab. Idempotent.
 */
export async function dismissRabbyWhatsNew(rabbyPage: Page): Promise<boolean> {
  if (rabbyPage.isClosed()) return false;
  const closeCandidates = [
    rabbyPage.getByRole("button", { name: /^close|^dismiss|^got it/i }).first(),
    rabbyPage.locator('[aria-label="Close"]').first(),
    rabbyPage.locator('button:has(svg[data-icon="close"])').first(),
  ];
  for (const c of closeCandidates) {
    if (await c.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await c.click({ timeout: 2_000, force: true }).catch(() => {});
      await rabbyPage.waitForTimeout(800);
      return true;
    }
  }
  // Fallback: the modal has a visible "What's new" heading and the X is
  // at top-right of the card. Click the heading first to ensure focus,
  // then press Escape.
  const heading = rabbyPage.getByText(/What.?s new/i).first();
  if (await heading.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await rabbyPage.keyboard.press("Escape").catch(() => {});
    await rabbyPage.waitForTimeout(600);
    return true;
  }
  return false;
}

/**
 * Block until Rabby surfaces a new notification.html popup OR the timeout
 * elapses. The popup is a separate Page object inside the same
 * BrowserContext; this scans all open pages on each iteration.
 */
export async function waitForRabbyPopup(
  ctx: BrowserContext,
  extId: string,
  knownPages: Set<Page>,
  timeoutMs = 30_000,
): Promise<Page | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const p of ctx.pages()) {
      if (knownPages.has(p)) continue;
      if (p.isClosed()) {
        knownPages.add(p);
        continue;
      }
      const url = p.url();
      if (url.includes(extId) && url.includes("notification.html")) {
        knownPages.add(p);
        return p;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** Rabby's primary-CTA labels in the order we should try them. */
const RABBY_PRIMARY_CTAS = ["Sign", "Confirm", "Approve", "Connect", "Allow", "Switch network"];

/**
 * On Rabby's Connect popup the chain chip defaults to Ethereum mainnet.
 * Blank's wagmi config only allows Sepolia + Base Sepolia, so the
 * Connect CTA stays disabled until we switch. Ported from
 * `scripts/rabby-live-smoke.ts::selectRabbyChain` — that pattern was
 * proven across both chains. Returns true if the chain switch landed,
 * false if no switch was attempted (popup may already be on the right
 * chain or the dropdown widget wasn't found).
 *
 * @param chainName "Ethereum Sepolia" or "Base Sepolia"
 */
export async function selectRabbyChain(popup: Page, chainName: string): Promise<boolean> {
  // Let the popup finish rendering its dApp metadata. Rabby fetches
  // "Listed by" / "Site popularity" on open and the chain chip text
  // only finalises after that returns.
  await popup.waitForTimeout(4_500);

  // Step 1: open the chain dropdown. The chip text varies: "Ethereum"
  // when default, or the previously-selected chain. Match either the
  // default mainnet label or any chain chip in the popup header.
  const trig = popup.getByText(/^(Ethereum|Sepolia|Base|Polygon|Optimism)/i).first();
  if (!(await trig.isVisible({ timeout: 6_000 }).catch(() => false))) {
    return false;
  }
  const bb = await trig.boundingBox({ timeout: 2_000 }).catch(() => null);
  if (bb) {
    await popup.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  } else {
    await trig.click({ force: true }).catch(() => {});
  }
  await popup.waitForTimeout(2_000);

  // Step 2: Rabby may default to the Mainnets tab. Click Testnets if
  // present so Sepolia surfaces.
  const testnetTab = popup.getByText("Testnets", { exact: true }).first();
  if (await testnetTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const tBb = await testnetTab.boundingBox({ timeout: 1_500 }).catch(() => null);
    if (tBb) await popup.mouse.click(tBb.x + tBb.width / 2, tBb.y + tBb.height / 2);
    else await testnetTab.click({ force: true }).catch(() => {});
    await popup.waitForTimeout(1_500);
  }

  // Step 3: search field filters the list. Type a partial chain name.
  const searchInput = popup
    .locator('input[type="text"], input[placeholder*="Search" i], input[placeholder*="search" i]')
    .first();
  if (await searchInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await searchInput.fill("Sepolia").catch(() => {});
    await popup.waitForTimeout(1_200);
  }

  // Step 4: pick the row. Rabby labels Eth Sepolia as "Sepolia" and
  // Base Sepolia as "Base Sepolia".
  const target = chainName.includes("Base") ? "Base Sepolia" : "Sepolia";
  const targetLoc = popup.getByText(target, { exact: false }).first();
  if (await targetLoc.isVisible({ timeout: 2_500 }).catch(() => false)) {
    const tb = await targetLoc.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (tb) await popup.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    else await targetLoc.click({ force: true }).catch(() => {});
    await popup.waitForTimeout(2_000);
    return true;
  }
  return false;
}

async function cdpRawClick(popup: Page, x: number, y: number): Promise<boolean> {
  try {
    const cdp = await popup.context().newCDPSession(popup);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await new Promise((r) => setTimeout(r, 50));
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 80));
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await cdp.detach().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive a Rabby popup through every stage of its primary CTA until the
 * popup closes (success) or a 60-second click-budget exhausts. Each stage
 * advance is captured as a screenshot tagged with `label`.
 *
 * Rabby's SIWE flow notably has TWO stages on the same Sign button: stage
 * 1 surfaces "Sign", clicking changes the label to "Confirm" without
 * closing the popup, clicking again broadcasts the tx. The CTA-text loop
 * handles both transparently.
 */
export async function confirmRabbyPopup(
  popup: Page,
  shotsDir: string,
  label: string,
  opts: { chainName?: string } = {},
): Promise<{ clicks: number; closed: boolean }> {
  // For Connect popups, switch chain BEFORE looking for CTAs — the
  // Connect button stays disabled until the chain matches the dApp's
  // wagmi config. `label.includes("connect")` is the convention used
  // by the spec to identify these.
  if (opts.chainName && /connect/i.test(label)) {
    await selectRabbyChain(popup, opts.chainName).catch(() => false);
  }

  const start = Date.now();
  let clicks = 0;
  let lastClick = Date.now();

  while (Date.now() - start < 60_000) {
    if (popup.isClosed()) return { clicks, closed: true };
    if (Date.now() - lastClick > 10_000 && clicks > 0) break;

    let clickedThisIter = false;
    for (const txt of RABBY_PRIMARY_CTAS) {
      const btn = popup.getByRole("button", { name: txt, exact: true }).first();
      const visible = await btn.isVisible({ timeout: 1_500 }).catch(() => false);
      if (!visible) continue;
      const enabled = await btn.isEnabled({ timeout: 500 }).catch(() => true);
      if (!enabled) {
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      const bbox = await btn.boundingBox({ timeout: 2_000 }).catch(() => null);
      if (!bbox) continue;
      const cx = Math.round(bbox.x + bbox.width / 2);
      const cy = Math.round(bbox.y + bbox.height / 2);
      if (await cdpRawClick(popup, cx, cy)) {
        clicks++;
        lastClick = Date.now();
        clickedThisIter = true;
        await popup
          .screenshot({ path: path.join(shotsDir, `${label}-click-${clicks}.png`) })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 3_500));
        break;
      }
    }
    if (!clickedThisIter) await new Promise((r) => setTimeout(r, 1_500));
  }
  return { clicks, closed: popup.isClosed() };
}

/**
 * Convenience: wait for the next popup AND drive it to close.
 * Returns null if no popup surfaced within `timeoutMs`.
 */
export async function waitAndConfirmRabbyPopup(
  ctx: BrowserContext,
  extId: string,
  knownPages: Set<Page>,
  shotsDir: string,
  label: string,
  timeoutMs = 30_000,
  opts: { chainName?: string } = {},
): Promise<{ popup: Page | null; clicks: number; closed: boolean }> {
  const popup = await waitForRabbyPopup(ctx, extId, knownPages, timeoutMs);
  if (!popup) return { popup: null, clicks: 0, closed: false };
  const result = await confirmRabbyPopup(popup, shotsDir, label, opts);
  return { popup, ...result };
}
