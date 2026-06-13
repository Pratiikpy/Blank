import { defineConfig, devices } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

// ──────────────────────────────────────────────────────────────────
//  Wave 4 headless passkey E2E config
//
//  Distinct from packages/app/playwright.config.ts so the Wave 4
//  judge-replay suite can have stricter coverage rules (video, full-
//  page screenshots, both chains, both viewports, longer timeout for
//  on-chain confirmations) without disrupting the older smoke tests.
//
//  Stopping conditions per docs/WAVE_4_SUBMISSION.md:
//   • Real passkey virtual authenticator (passphrase-encrypted P-256
//     in IndexedDB — no WebAuthn prompt, fully headless).
//   • Real RPC, real chain. No mocks, no injected ethereum.
//   • Multi-party flows use distinct browser contexts per wallet.
//   • Screenshots at every meaningful state transition.
//   • Video on every phase.
//   • Both chains (Eth Sepolia 11155111 + Base Sepolia 84532 + Arbitrum Sepolia 421614).
//   • Both viewports (1280x800 + 375x812) for user-facing screens.
//   • Real tx hashes captured + written to WAVE4_TESTING_TODO.md.
// ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  testDir: __dirname,
  testMatch: ["**/phases/*.spec.ts", "**/features/*.spec.ts"],
  timeout: 600_000, // 10 minutes per test — testnet RPCs can be slow, FHE encrypt + AA UserOp + 2 confirmations + balance-sync polling
  expect: { timeout: 30_000 },
  fullyParallel: false, // phases run sequentially; chain deploys + state matter
  retries: 0, // failures must be real, not flakes
  workers: 1, // single-threaded to keep chain-state ordering deterministic
  reporter: [
    ["list"],
    ["html", { outputFolder: path.resolve(__dirname, "../../test-results/wave4-html"), open: "never" }],
    ["json", { outputFile: path.resolve(__dirname, "../../test-results/wave4-results.json") }],
  ],
  outputDir: path.resolve(__dirname, "../../test-results/wave4-artifacts"),
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    video: "on",
    screenshot: "only-on-failure", // explicit screenshots happen via the helper
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  // Auto-start vite so `pnpm e2e` works on a fresh checkout. Playwright
  // reuses an already-running dev server (good for local dev where the
  // dev box already has vite up), spins one up otherwise (CI / cloud
  // headless / clean-checkout judges).
  webServer: {
    command: "pnpm dev",
    cwd: path.resolve(__dirname, "../.."),
    url: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000, // first-time vite build can take a while on cold cache
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "eth-sepolia-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        // Per-chain context state via storage. Test specs read CHAIN_ID
        // from process.env.WAVE4_CHAIN_ID.
      },
      metadata: { chainId: 11155111, chainName: "Ethereum Sepolia", viewport: "desktop" },
      // Mobile features (BottomNav-driven flows) only render at <768px;
      // running them on the desktop viewport would fail on a hidden nav.
      testIgnore: ["**/features/*-mobile.spec.ts"],
    },
    {
      name: "base-sepolia-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
      metadata: { chainId: 84532, chainName: "Base Sepolia", viewport: "desktop" },
      testIgnore: ["**/features/*-mobile.spec.ts"],
    },
    {
      name: "eth-sepolia-mobile",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 375, height: 812 },
      },
      metadata: { chainId: 11155111, chainName: "Ethereum Sepolia", viewport: "mobile" },
      testMatch: ["**/features/*-mobile.spec.ts"],
    },
    {
      name: "base-sepolia-mobile",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 375, height: 812 },
      },
      metadata: { chainId: 84532, chainName: "Base Sepolia", viewport: "mobile" },
      testMatch: ["**/features/*-mobile.spec.ts"],
    },
    {
      name: "arb-sepolia-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
      metadata: { chainId: 421614, chainName: "Arbitrum Sepolia", viewport: "desktop" },
      testIgnore: ["**/features/*-mobile.spec.ts"],
    },
    {
      name: "arb-sepolia-mobile",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 375, height: 812 },
      },
      metadata: { chainId: 421614, chainName: "Arbitrum Sepolia", viewport: "mobile" },
      testMatch: ["**/features/*-mobile.spec.ts"],
    },
  ],
});
