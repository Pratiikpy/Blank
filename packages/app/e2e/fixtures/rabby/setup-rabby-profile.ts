/**
 * One-time Rabby profile seeder for Wave 4 Phase 9 smoke.
 *
 *   pnpm exec tsx packages/app/e2e/fixtures/rabby/setup-rabby-profile.ts
 *
 * What this does:
 *   1. Launches Chromium with the Rabby extension and a persistent
 *      profile at ${repo}/.rabby-profile (creates it fresh if absent).
 *   2. Opens Rabby's first-run screen + leaves the browser open for
 *      interactive seed-import. The user types the seed phrase, sets
 *      the password (default RabbyPass123!QA), and clicks through
 *      the network-pick screen.
 *   3. Once the user closes the browser, the profile dir holds the
 *      seeded wallet state. Subsequent test runs only need to unlock.
 *
 * Why a persistent profile + manual seed step:
 *   Rabby's onboarding UI is opinionated (12-word entropy detection,
 *   network picker, security checks). Scripting it through Playwright
 *   would be brittle and version-coupled. A one-time interactive
 *   seed-in beats a fragile re-onboard on every test run.
 *
 * Seed expectations:
 *   Dave's deterministic key is derived in e2e/wave4/fixtures/wallets.ts
 *   via keccak256(deployer || "dave"). Use a Rabby-friendly seed
 *   phrase (BIP-39 24 words OR import as private key) so the address
 *   matches Dave's expected address there. If you prefer importing
 *   raw private key, Rabby supports it via Add address > Import
 *   private key.
 *
 *   Default test seed: the standard "test test ... junk" 12-word
 *   mnemonic at index 0 → 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 *   You can override by editing the wallets.ts Dave fixture.
 */
import "dotenv/config";
import { chromium } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const RABBY_EXT_DIR = path.resolve(__dirname, "ext");
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ?? path.resolve(REPO_ROOT, ".rabby-profile");

async function main(): Promise<void> {
  if (!fs.existsSync(RABBY_EXT_DIR)) {
    console.error(
      `FATAL: Rabby ext not found at ${RABBY_EXT_DIR}\n` +
        `Copy the unpacked extension first. Source options:\n` +
        `  • oglabs/scripts/qa/wallet-e2e/rabby/extension/ (vendored)\n` +
        `  • Fresh: download Rabby.crx, rename to .zip, unpack`,
    );
    process.exit(1);
  }
  if (fs.existsSync(RABBY_PROFILE_DIR) && fs.readdirSync(RABBY_PROFILE_DIR).length > 0) {
    console.log(
      `NOTE: ${RABBY_PROFILE_DIR} already has content. The Rabby session may already be seeded.\n` +
        `Delete the directory if you want a fresh profile.`,
    );
  }
  fs.mkdirSync(RABBY_PROFILE_DIR, { recursive: true });

  console.log(`Launching Chromium with Rabby...`);
  console.log(`  ext: ${RABBY_EXT_DIR}`);
  console.log(`  profile: ${RABBY_PROFILE_DIR}`);

  const ctx = await chromium.launchPersistentContext(RABBY_PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${RABBY_EXT_DIR}`,
      `--load-extension=${RABBY_EXT_DIR}`,
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });

  // Wait for Rabby SW + open the home page.
  let extId = "";
  for (let i = 0; i < 15; i++) {
    const sw = ctx.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (sw) {
      extId = sw.url().split("/")[2];
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!extId) {
    console.error("Rabby SW did not register. Is the extension dist valid?");
    process.exit(2);
  }
  console.log(`Rabby extension id: ${extId}`);

  const rabby = await ctx.newPage();
  await rabby.goto(`chrome-extension://${extId}/index.html`).catch(() => {});
  await rabby.waitForTimeout(3_000);

  console.log("");
  console.log("─── interactive seed step ─────────────────────────────");
  console.log("1. Click 'Get started' (or 'I already have a seed') in Rabby.");
  console.log("2. Import seed phrase OR private key for Dave.");
  console.log("3. Set the password to:");
  console.log("       RabbyPass123!QA");
  console.log("   (the default matched by rabby-driver.ts).");
  console.log("   Override via RABBY_PASSWORD env if you prefer.");
  console.log("4. Skip backup / OK through the post-onboard screens.");
  console.log("5. When you see Rabby's home with Dave's address, close this window.");
  console.log("───────────────────────────────────────────────────────");
  console.log("");
  console.log("The browser will stay open for up to 30 minutes. Take your time.");

  await new Promise((r) => setTimeout(r, 30 * 60 * 1000));
  await ctx.close();
  console.log(`Profile written to ${RABBY_PROFILE_DIR}.`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(3);
});
