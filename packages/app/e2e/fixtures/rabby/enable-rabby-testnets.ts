/**
 * One-shot interactive helper to enable Testnet visibility in the
 * persistent Rabby profile (.rabby-profile-blank).
 *
 *   pnpm exec tsx packages/app/e2e/fixtures/rabby/enable-rabby-testnets.ts
 *
 * Why this exists:
 *   Rabby's testnet-visibility toggle lives in Settings, and Rabby's
 *   React app routes via hash but its hashchange listener is set up
 *   AFTER first mount — so navigating via `goto chrome-extension://...
 *   index.html#/settings` from outside the SPA renders blank. We can't
 *   reliably automate the gear-icon click either; selectors drift
 *   across Rabby builds.
 *
 *   The pragmatic fix: open Rabby once with the persistent profile,
 *   prompt the operator to flip the toggle by hand, then close. The
 *   setting persists in the profile's IndexedDB forever.
 *
 * Steps the operator follows when this script runs:
 *   1. Chromium opens with Rabby loaded + the persistent profile.
 *   2. Unlock Rabby (password defaults to RabbyPass123!QA, override via
 *      RABBY_PASSWORD env).
 *   3. Click the gear icon at the top-right of Rabby's home tab.
 *   4. Find "Enable Testnets" (or "Show Testnets") in the list and
 *      flip the toggle to ON.
 *   5. Close the Chromium window. The persistent profile is saved.
 *
 * After this is done once, Phase 9 Rabby smoke can drive Connect end-
 * to-end. The setting survives across smoke runs because the profile
 * dir is checked in / kept on disk.
 */
import { chromium } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const RABBY_EXT_DIR = path.resolve(__dirname, "ext");
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ??
  (fs.existsSync(path.resolve(REPO_ROOT, ".rabby-profile-blank"))
    ? path.resolve(REPO_ROOT, ".rabby-profile-blank")
    : path.resolve(REPO_ROOT, ".rabby-profile"));

async function main(): Promise<void> {
  if (!fs.existsSync(RABBY_EXT_DIR)) {
    console.error(`FATAL: Rabby ext not found at ${RABBY_EXT_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(RABBY_PROFILE_DIR) || fs.readdirSync(RABBY_PROFILE_DIR).length === 0) {
    console.error(
      `FATAL: Rabby profile not seeded at ${RABBY_PROFILE_DIR}\n` +
        `Run setup-rabby-profile.ts first to import Dave's seed.`,
    );
    process.exit(2);
  }

  const ctx = await chromium.launchPersistentContext(RABBY_PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${RABBY_EXT_DIR}`,
      `--load-extension=${RABBY_EXT_DIR}`,
      "--no-sandbox",
    ],
  });

  // Resolve the Rabby extension ID via service worker URL.
  let extId = "";
  for (let i = 0; i < 30; i++) {
    const sw = ctx.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (sw) {
      extId = sw.url().split("/")[2];
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!extId) {
    console.error("FATAL: Rabby service worker did not register within 24s");
    await ctx.close();
    process.exit(3);
  }

  const home = await ctx.newPage();
  await home.goto(`chrome-extension://${extId}/index.html`).catch(() => {});

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Rabby is open. Follow these steps:");
  console.log("");
  console.log("    1. Unlock Rabby (password defaults to RabbyPass123!QA).");
  console.log("    2. Click the gear icon at the top-right of the home tab.");
  console.log("    3. Find 'Enable Testnets' (or 'Show Testnets') and");
  console.log("       toggle it ON.");
  console.log("    4. Close the Chromium window when done.");
  console.log("");
  console.log("  Profile dir: " + RABBY_PROFILE_DIR);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  // Wait for the user to close the window. The persistent profile saves
  // their toggle automatically on close.
  await new Promise<void>((resolve) => {
    ctx.on("close", () => resolve());
  });
  console.log("✓ Profile saved. Phase 9 Rabby smoke can now proceed.");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(99);
});
