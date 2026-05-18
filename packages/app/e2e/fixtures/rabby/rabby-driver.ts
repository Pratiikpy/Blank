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
): Promise<{ clicks: number; closed: boolean }> {
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
): Promise<{ popup: Page | null; clicks: number; closed: boolean }> {
  const popup = await waitForRabbyPopup(ctx, extId, knownPages, timeoutMs);
  if (!popup) return { popup: null, clicks: 0, closed: false };
  const result = await confirmRabbyPopup(popup, shotsDir, label);
  return { popup, ...result };
}
