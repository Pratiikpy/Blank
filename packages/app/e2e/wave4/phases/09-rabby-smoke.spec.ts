import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  launchRabby,
  unlockRabby,
  waitAndConfirmRabbyPopup,
} from "../../fixtures/rabby/rabby-driver";
import { CHAINS, type ChainKey } from "../fixtures/wallets";
import { snap, resetCounter } from "../helpers/screenshot";
import { recordProof } from "../helpers/testing-todo";

// ──────────────────────────────────────────────────────────────────
//  Phase 9 — Rabby smoke (Dave end-to-end).
//
//  Replaces the prior MetaMask phase 9. Rationale documented in
//  CLAUDE.md §M and in the user's memory file
//  `reference_rabby_automation_pattern.md`: MetaMask MV3 popups
//  drop click events under automation; Rabby's notification.html
//  yields to CDP-raw clicks reliably (proven across 30+ oglabs
//  iterations).
//
//  Setup contract:
//   1. Rabby extension dist must be at e2e/fixtures/rabby/ext/.
//      Copy the unpacked extension once (e.g. from oglabs) — the
//      directory is gitignored due to size (53MB).
//   2. The persistent Rabby profile at the repo root (.rabby-profile)
//      must already have Dave's seed imported + the dApp's
//      site-permission grant. Seed it once via
//      `pnpm exec tsx packages/app/e2e/fixtures/rabby/setup-rabby-profile.ts`
//      (or the rabby-step.ts launcher pattern from oglabs).
//   3. TEST_RABBY=1 must be set so this phase doesn't fire on quick
//      passkey-only runs.
//   4. RABBY_PASSWORD env (defaults to "RabbyPass123!QA" matching
//      oglabs convention).
//
//  Minimal flow:
//   1. Launch Chromium with Rabby side-loaded + persistent profile.
//   2. Unlock with password (if locked).
//   3. Open Blank dApp /app, click "Sign in" — Rabby SIWE popup
//      surfaces, drive it to Confirm.
//   4. Open /app/send, drive a Send (0.01 USDC) to a known
//      recipient. EOA path via wagmi writeContractAsync (not the
//      passkey UserOp path).
//   5. Confirm the Rabby tx popup, capture the tx hash from the
//      SendSuccess explorer link, recordProof.
//
//  This phase intentionally stays SHORT — passkey phases 1-8 cover
//  the substantive feature surface. Phase 9's role is to prove the
//  Rabby EOA fallback works for users who prefer an extension.
// ──────────────────────────────────────────────────────────────────

const PHASE = "P9 Rabby Smoke";

const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS_DIR = path.resolve(__dirname, "../../../test-results/wave4-rabby-shots");
const RABBY_EXT_DIR = path.resolve(__dirname, "../../fixtures/rabby/ext");
// Accept either canonical name or "-blank" suffix (some setup scripts seed
// under the latter so the seed dir doesn't accidentally match an
// in-use Chrome instance during local dev).
const RABBY_PROFILE_CANDIDATES = [
  path.resolve(__dirname, "../../../../..", ".rabby-profile"),
  path.resolve(__dirname, "../../../../..", ".rabby-profile-blank"),
];
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ??
  RABBY_PROFILE_CANDIDATES.find((p) => fs.existsSync(p) && fs.readdirSync(p).length > 0) ??
  RABBY_PROFILE_CANDIDATES[0];

function chainContextFromProject(): { chainId: number; chainName: string; viewport: string; chainKey: ChainKey } {
  const meta = test.info().project.metadata as
    | { chainId?: number; chainName?: string; viewport?: string }
    | undefined;
  if (!meta?.chainId || !meta.chainName) throw new Error("Project metadata missing");
  const chainKey: ChainKey = meta.chainId === 11155111 ? "ETH_SEPOLIA" : "BASE_SEPOLIA";
  return {
    chainId: meta.chainId,
    chainName: meta.chainName,
    viewport: meta.viewport ?? "desktop",
    chainKey,
  };
}

async function waitForExplorerTxHash(page: Page, timeoutMs = 120_000): Promise<string> {
  const href = await page
    .locator('a[href*="/tx/0x"]')
    .first()
    .getAttribute("href", { timeout: timeoutMs });
  const m = href?.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
  if (!m) throw new Error(`No tx hash on SendSuccess (href=${href ?? "<null>"})`);
  return m[1];
}

test.describe("Phase 9 — Rabby smoke (Dave EOA)", () => {
  test.describe.configure({ mode: "serial" });

  test("Dave connects Rabby, signs in via SIWE, drives a basic Send, captures tx hash", async ({
    baseURL,
  }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";

    const hasExt = fs.existsSync(RABBY_EXT_DIR);
    const hasProfile = fs.existsSync(RABBY_PROFILE_DIR) && fs.readdirSync(RABBY_PROFILE_DIR).length > 0;
    const optedIn = process.env.TEST_RABBY === "1";
    test.skip(
      !hasExt || !hasProfile || !optedIn,
      `Phase 9 Rabby needs:\n` +
        `  • Extension dist at ${RABBY_EXT_DIR} (${hasExt ? "ok" : "MISSING"})\n` +
        `  • Persistent profile at ${RABBY_PROFILE_DIR} (${hasProfile ? "ok" : "MISSING"})\n` +
        `  • TEST_RABBY=1 (${optedIn ? "ok" : "MISSING"})\n` +
        `Seed the profile once via:\n` +
        `  pnpm exec tsx packages/app/e2e/fixtures/rabby/setup-rabby-profile.ts`,
    );

    const shot = { phase: "09-rabby-smoke", persona: "dave", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);

    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const rabby = await launchRabby({
      shotsDir: SHOTS_DIR,
      headless: false,
      profileDir: RABBY_PROFILE_DIR,
    });

    try {
      // — Unlock.
      await unlockRabby(rabby.rabbyPage, RABBY_PASSWORD);
      await snap(rabby.rabbyPage, shot, "rabby-unlocked");

      // — Open the dApp.
      const dapp = await rabby.context.newPage();
      await dapp.goto(`${url}/app`);
      await snap(dapp, shot, "dapp-loaded");

      // Track known pages so popup detection only fires on NEW windows.
      const knownPages = new Set<Page>(rabby.context.pages());

      // Click Sign in. Rabby's connect popup fires.
      const signInBtn = dapp.locator("button").filter({ hasText: /^Sign in/i }).first();
      await signInBtn.waitFor({ state: "visible", timeout: 30_000 });
      await signInBtn.click();

      const connect = await waitAndConfirmRabbyPopup(
        rabby.context,
        rabby.rabbyExtensionId,
        knownPages,
        SHOTS_DIR,
        "rabby-connect",
        30_000,
      );
      expect(connect.clicks, "Rabby connect popup did not advance").toBeGreaterThan(0);
      await snap(dapp, shot, "rabby-connected");

      // SIWE may surface immediately after. Drive it if present.
      const siwe = await waitAndConfirmRabbyPopup(
        rabby.context,
        rabby.rabbyExtensionId,
        knownPages,
        SHOTS_DIR,
        "rabby-siwe",
        15_000,
      );
      if (siwe.clicks > 0) await snap(dapp, shot, "rabby-siwe-signed");

      // — Drive a basic Send.
      const recipient =
        process.env.WAVE4_RABBY_RECIPIENT ??
        "0x000000000000000000000000000000000000dEaD";
      await dapp.goto(`${url}/app/send`);

      await dapp.locator('input[placeholder*="0x"]').first().fill(recipient);
      await dapp.locator("button").filter({ hasText: /^Next/i }).first().click();
      await dapp.locator('input[placeholder="0.00"]').first().fill("0.01");
      await dapp.locator("button").filter({ hasText: /^Send/i }).last().click();
      await dapp.locator("button").filter({ hasText: /^Confirm/i }).last().click();

      const send = await waitAndConfirmRabbyPopup(
        rabby.context,
        rabby.rabbyExtensionId,
        knownPages,
        SHOTS_DIR,
        "rabby-send",
        60_000,
      );
      expect(send.clicks, "Rabby send popup did not advance").toBeGreaterThan(0);

      const sendTxHash = await waitForExplorerTxHash(dapp, 120_000);
      const finalShot = await snap(dapp, shot, "rabby-send-success");

      recordProof({
        phase: `${PHASE} · Rabby EOA Send`,
        chainName: chain.chainName,
        chainId: chain.chainId,
        txHash: sendTxHash,
        screenshotPath: finalShot,
        note: `Dave (Rabby EOA, persistent profile at .rabby-profile/) signs in via SIWE then sends 0.01 USDC via wagmi writeContractAsync. Replaces the unreliable MetaMask MV3 phase 9.`,
        viewport: chain.viewport,
      });
    } finally {
      await rabby.context.close();
    }
  });
});

test("CHAINS metadata pin (regression sanity)", () => {
  expect(CHAINS.ETH_SEPOLIA.id).toBe(11155111);
  expect(CHAINS.BASE_SEPOLIA.id).toBe(84532);
});
