import { test, expect } from "@playwright/test";
import {
  PERSONAS,
  CHAINS,
  injectPasskey,
  setActiveChain,
  type WalletPersona,
  type ChainKey,
} from "../fixtures/wallets";
import { snap, resetCounter } from "../helpers/screenshot";
import { recordProof } from "../helpers/testing-todo";
import { drainPassphrasePrompts } from "../helpers/app-actions";

// ──────────────────────────────────────────────────────────────────
//  Phase 1 — bootstrap. Spawns Alice/Bob/Carol passkeys per chain
//  and faucets TestUSDC to each smart-account address.
//
//  Outputs per (persona × chain):
//    • Screenshot of the SmartWallet page with the derived AA address
//      visible (data-testid="gas-wallet-address")
//    • Screenshot of the post-faucet state with USDC balance > 0
//    • Faucet mint tx hash → recorded in WAVE4_TESTING_TODO.md
//
//  Pre-conditions:
//    • App dev server reachable at PLAYWRIGHT_BASE_URL (default
//      http://localhost:3000)
//    • /api/faucet/usdc endpoint reachable (works on the Vercel
//      deploy; for localhost, `vercel dev` must be running to
//      proxy /api/* — falls back to "deployer key" path on the
//      production-deployed app)
//
//  CLAUDE.md §F-I gate: each (persona × chain) produces one tx hash
//  + screenshots. Phase 1 is the first feature to populate the
//  auto-generated proof block in WAVE4_TESTING_TODO.md.
// ──────────────────────────────────────────────────────────────────

const PHASE = "P1 Bootstrap";

// Project metadata is the chain context. Playwright sets it via the
// projects: [...] config; the test pulls it back via test.info().
function chainContextFromProject(): { chainId: number; chainName: string; viewport: string; chainKey: ChainKey } {
  const meta = test.info().project.metadata as
    | { chainId?: number; chainName?: string; viewport?: string }
    | undefined;
  if (!meta?.chainId || !meta.chainName) {
    throw new Error("Project metadata missing chainId/chainName — check playwright.config.ts");
  }
  const chainKey: ChainKey = meta.chainId === 11155111 ? "ETH_SEPOLIA" : "BASE_SEPOLIA";
  return {
    chainId: meta.chainId,
    chainName: meta.chainName,
    viewport: meta.viewport ?? "desktop",
    chainKey,
  };
}

// Run the bootstrap flow for one persona. Returns the proof entry
// (tx hash + screenshot path + AA address) so the test can record it.
async function bootstrapPersona(
  browser: import("@playwright/test").Browser,
  persona: WalletPersona,
  chain: ReturnType<typeof chainContextFromProject>,
  baseURL: string,
): Promise<{ aaAddress: string; faucetTxHash: string; finalScreenshot: string }> {
  const ctxName = `${persona.name.toLowerCase()}`;
  const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";

  // Fresh browser context = fresh IndexedDB. Multi-party isolation.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    baseURL,
  });
  const page = await context.newPage();

  resetCounter({ phase: "01-bootstrap", persona: ctxName, chain: chainSlug, viewport: chain.viewport });

  try {
    // 1. Land on / so Vite resolves the passkey lib module graph.
    await page.goto("/");
    await setActiveChain(page, chain.chainId);
    await injectPasskey(page, persona, chain.chainId);

    await snap(
      page,
      { phase: "01-bootstrap", persona: ctxName, chain: chainSlug, viewport: chain.viewport },
      "passkey-injected",
    );

    // 2. Navigate to /app/wallet — the SmartWallet screen renders the
    //    AA address and includes the GasWalletPanel with its
    //    data-testid="gas-wallet-address".
    await page.goto("/app/wallet");

    // Wait for the gas-wallet address field. The panel is rendered
    // only after useEffectiveAddress resolves, which needs the page
    // to have hydrated + the chain context to be set.
    const addressLocator = page.locator('[data-testid="gas-wallet-address"]');
    await expect(addressLocator).toBeVisible({ timeout: 30_000 });
    const aaAddress = (await addressLocator.textContent())?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(aaAddress)) {
      throw new Error(`Expected hex AA address, got: ${aaAddress.slice(0, 80)}`);
    }

    const preFaucetShot = await snap(
      page,
      { phase: "01-bootstrap", persona: ctxName, chain: chainSlug, viewport: chain.viewport },
      "pre-faucet-wallet",
    );
    if (!preFaucetShot) throw new Error("snap returned empty path");

    // 3. Hit the faucet endpoint server-side. The endpoint mints
    //    100 TestUSDC to the AA address and returns the tx hash.
    const faucetResponse = await page.request.post(
      `${baseURL}/api/faucet/usdc`,
      {
        data: { address: aaAddress, chainId: chain.chainId },
        timeout: 60_000,
      },
    );
    expect(faucetResponse.ok(), `Faucet endpoint failed: ${faucetResponse.status()}`).toBe(true);
    const body = (await faucetResponse.json()) as { ok: boolean; hash?: string; error?: string };
    expect(body.ok, `Faucet body.ok was false: ${body.error}`).toBe(true);
    expect(body.hash, "Faucet response missing tx hash").toBeTruthy();
    const faucetTxHash = body.hash!;
    expect(faucetTxHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // 4. Reload + wait for the balance widget to reflect the mint.
    //    The Refresh button on GasWalletPanel re-reads via publicClient.
    await page.reload();
    await page.locator('[data-testid="gas-wallet-address"]').waitFor({ state: "visible", timeout: 30_000 });

    // Detect + dismiss the gas-wallet upgrade prompt that overlays fresh AAs
    // on Base Sepolia (BlankAccountFactory's `accountImplementation` is
    // immutable and points at the OLDER impl; the newer Impl_gasWallet exists
    // but isn't auto-applied). The card hides the wallet balance card, so
    // without this step the balance poll below never finds a match. Click
    // dispatches a sponsored UserOp via paymaster; the upgrade settles in
    // ~30-60s on Base Sepolia. After settle, the overlay hides on its own
    // and the balance card renders normally. Eth Sepolia personas typically
    // don't see this card (factory there already points at the gas-wallet
    // impl) so the locator times out fast and we move on.
    const upgradeCta = page.locator('[data-testid="upgrade-banner-cta"]');
    if (await upgradeCta.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await upgradeCta.click();
      // The upgrade click fires a unifiedWrite UserOp that needs the
      // passphrase signature. Without driving the prompt the upgrade
      // hangs, the banner stays visible, and the balance card stays
      // hidden. Drain whatever prompts appear during the 90s upgrade
      // window.
      await drainPassphrasePrompts(page, PERSONAS[personaKey].passphrase, {
        windowMs: 90_000,
        gapMs: 30_000,
        expectAtLeast: 0,
      });
      await page
        .locator('[data-testid="upgrade-banner"]')
        .waitFor({ state: "hidden", timeout: 90_000 })
        .catch(() => {
          // Banner didn't hide in 90s — the upgrade may have settled with
          // the banner still on screen. Continue and let the balance poll
          // below tell us whether the wallet card is reachable now.
        });
    }

    // Wait a beat for the chain RPC to surface the new balance. The
    // mint tx is ~12s confirmation on Sepolia + a few seconds for the
    // public RPC to propagate. We poll the wallet's TestUSDC balance
    // for up to 90 seconds.
    let observedBalance: string | null = null;
    const balanceDeadline = Date.now() + 90_000;
    while (Date.now() < balanceDeadline) {
      // TestUSDC balance is rendered on the SmartWallet "Fund-in" card.
      // The text format is "<formatted-amount> USDC".
      const balanceText = (await page.locator("text=/\\d+\\.?\\d* USDC/").first().textContent().catch(() => null)) ?? "";
      const m = balanceText.match(/(\d+(?:\.\d+)?)\s*USDC/);
      if (m && Number.parseFloat(m[1]) > 0) {
        observedBalance = m[1];
        break;
      }
      await page.waitForTimeout(3_000);
    }
    expect(observedBalance, "TestUSDC balance never went above 0 after faucet").toBeTruthy();

    const finalScreenshot = await snap(
      page,
      { phase: "01-bootstrap", persona: ctxName, chain: chainSlug, viewport: chain.viewport },
      "post-faucet-balance",
    );

    return { aaAddress, faucetTxHash, finalScreenshot };
  } finally {
    await context.close();
  }
}

test.describe("Phase 1 — bootstrap (faucet 3 passkey personas per chain)", () => {
  test.describe.configure({ mode: "serial" });

  for (const personaKey of ["Alice", "Bob", "Carol"] as const) {
    test(`${personaKey}: passkey injected + TestUSDC faucet drips on chain`, async ({ browser, baseURL }) => {
      const chain = chainContextFromProject();
      const persona = PERSONAS[personaKey];
      if (!persona) throw new Error(`Unknown persona: ${personaKey}`);

      const out = await bootstrapPersona(browser, persona, chain, baseURL ?? "http://localhost:3000");

      // Record proof — one entry per (persona × chain).
      recordProof({
        phase: `${PHASE} · ${personaKey}`,
        chainName: chain.chainName,
        chainId: chain.chainId,
        txHash: out.faucetTxHash,
        screenshotPath: out.finalScreenshot,
        note: `${personaKey} faucet → ${out.aaAddress.slice(0, 6)}…${out.aaAddress.slice(-4)}`,
        viewport: chain.viewport,
      });
    });
  }
});

// Confirm CHAINS export shape matches what the test depends on. Keeps
// the suite from drifting silently if fixtures/wallets.ts changes.
test("CHAINS metadata matches playwright project metadata", () => {
  expect(CHAINS.ETH_SEPOLIA.id).toBe(11155111);
  expect(CHAINS.BASE_SEPOLIA.id).toBe(84532);
});
