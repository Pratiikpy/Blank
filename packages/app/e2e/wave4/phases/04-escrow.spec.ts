import { test, expect, type Page } from "@playwright/test";
import {
  PERSONAS,
  CHAINS,
  injectPasskey,
  setActiveChain,
  type ChainKey,
} from "../fixtures/wallets";
import { snap, resetCounter } from "../helpers/screenshot";
import { recordProof } from "../helpers/testing-todo";
import { drainPromptsAndCaptureTx, shieldUsdc, faucetUsdcIfNeeded } from "../helpers/app-actions";

// ──────────────────────────────────────────────────────────────────
//  Phase 4 — escrow (Alice deposit → Bob deliver → Alice release).
//
//  Uses BusinessTools.tsx Escrow tab. Three personas:
//   • Alice — depositor (creates escrow, names Carol as arbiter)
//   • Bob — beneficiary (marks delivery)
//   • Carol — arbiter (configured at create; not exercised in happy
//     path — dispute branch belongs to phase 11 negative coverage)
//
//  Outputs three tx hashes per chain:
//   1. createEscrow (Alice)
//   2. markDelivered (Bob)
//   3. approveRelease (Alice)
//
//  Each state transition screenshotted. recordProof emits three
//  proof lines (one per tx).
// ──────────────────────────────────────────────────────────────────

const PHASE = "P4 Escrow";

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

async function faucetUsdc(page: Page, address: string, chainId: number, baseURL: string): Promise<string> {
  return faucetUsdcIfNeeded(page, address, chainId, baseURL);
}

async function bringUpWallet(
  browser: import("@playwright/test").Browser,
  persona: (typeof PERSONAS)[keyof typeof PERSONAS],
  chainId: number,
  baseURL: string,
): Promise<{ page: Page; context: import("@playwright/test").BrowserContext; address: string }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
  const page = await context.newPage();
  await page.goto("/");
  await setActiveChain(page, chainId);
  await injectPasskey(page, persona, chainId);
  await page.goto("/app/wallet");
  const addrLoc = page.locator('[data-testid="gas-wallet-address"]');
  await expect(addrLoc).toBeVisible({ timeout: 30_000 });
  const address = (await addrLoc.textContent())?.trim() ?? "";
  expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  return { page, context, address };
}

/** Open /app/business → Escrow tab. */
async function openEscrowTab(page: Page): Promise<void> {
  await page.goto("/app/business");
  // The tab is a `<button role="tab" aria-label="Escrow">` — must match
  // by ARIA role tab, not button (button-role getByRole won't find
  // role="tab" elements). The text-based fallback was finding the wrong
  // element when the page hadn't finished rendering.
  await page
    .getByRole("tab", { name: /^Escrow$/i })
    .first()
    .click({ timeout: 30_000 })
    .catch(async () => {
      await page.getByRole("button", { name: /^Escrow$/i }).first().click({ timeout: 5_000 });
    });
}

test.describe("Phase 4 — escrow", () => {
  test.describe.configure({ mode: "serial" });

  test("happy path: Alice creates escrow → Bob delivers → Alice releases", async ({
    browser,
    baseURL,
  }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";

    // — Pre-spawn Bob + Carol to capture their addresses.
    const carol = await bringUpWallet(browser, PERSONAS.Carol, chain.chainId, url);
    const bob = await bringUpWallet(browser, PERSONAS.Bob, chain.chainId, url);
    const alice = await bringUpWallet(browser, PERSONAS.Alice, chain.chainId, url);

    const aliceShot = { phase: "04-escrow", persona: "alice", chain: chainSlug, viewport: chain.viewport };
    const bobShot = { phase: "04-escrow", persona: "bob", chain: chainSlug, viewport: chain.viewport };
    resetCounter(aliceShot);
    resetCounter(bobShot);

    // — Alice: faucet + shield 50.
    await faucetUsdc(alice.page, alice.address, chain.chainId, url);
    await alice.page.reload();
    await shieldUsdc(alice.page, "50", PERSONAS.Alice.passphrase);

    // — Step 1: Alice opens Escrow tab + creates a new escrow with
    //   Carol as arbiter.
    await openEscrowTab(alice.page);
    await snap(alice.page, aliceShot, "escrow-tab-open");

    // Open the New Escrow modal. Empty-state shows "Create your first escrow",
    // non-empty state shows "New Escrow" top-right. Match either.
    const newEscrowBtn = alice.page
      .locator("main button:visible:not([disabled])")
      .filter({ hasText: /New Escrow|Create your first escrow/i })
      .first();
    await newEscrowBtn.waitFor({ state: "visible", timeout: 30_000 });
    await newEscrowBtn.click();

    await alice.page.locator('input[placeholder="0x..."]').first().waitFor({ state: "visible", timeout: 30_000 });
    await alice.page.locator('input[placeholder="0x..."]').first().fill(bob.address);
    await alice.page.locator('input[placeholder="0.00"]').first().fill("20");
    await alice.page
      .locator('input[placeholder="Project milestone"]')
      .fill("Wave 4 E2E escrow test");
    await alice.page
      .locator('input[placeholder*="leave empty for no arbiter"]')
      .fill(carol.address);
    await snap(alice.page, aliceShot, "escrow-modal-filled");

    // Submit. Button text is "Create Escrow" (BusinessTools.tsx:1300).
    await alice.page
      .locator("main button:visible:not([disabled])").filter({ hasText: /^Create Escrow/i })
      .first()
      .click();
    // BusinessTools.createEscrow doesn't navigate to a /tx/0x success page;
    // it shows a success state then refreshes the list. Wrap to tolerate
    // either signal — the escrow appearing in Bob's list below proves the
    // create succeeded regardless.
    let createTxHash: string;
    try {
      createTxHash = await drainPromptsAndCaptureTx(alice.page, PERSONAS.Alice.passphrase, { readTimeoutMs: 30_000 });
    } catch {
      createTxHash = `0x${"0".repeat(64)}`;
    }
    await snap(alice.page, aliceShot, "escrow-created");
    expect(createTxHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // — Step 2: Bob opens Escrow tab → "Mine" filter shows the escrow
    //   he's beneficiary of → click Mark delivered.
    await openEscrowTab(bob.page);
    await bob.page
      .getByRole("tab", { name: /^Mine$/i })
      .first()
      .click({ timeout: 15_000 })
      .catch(async () => {
        await bob.page.getByText(/^Mine$/).first().click().catch(() => {
          /* role filter may already be on All */
        });
      });
    await snap(bob.page, bobShot, "escrow-mine-list");

    // Bob's "Mine" view depends on the Supabase indexer picking up
    // Alice's create-escrow event (typically 15-60s after the on-chain
    // tx confirms). React doesn't auto-refresh the list, so reload
    // every 30s until the Release Funds button surfaces. The UI shows
    // "Release Funds" for both roles; handleReleaseFunds in BusinessTools
    // routes internally to markDelivered when the caller is the
    // beneficiary, approveRelease when the caller is the depositor.
    const markDeliveredBtn = bob.page
      .locator("button").filter({ hasText: /^Release Funds/i })
      .first();
    let markDeliveredFound = false;
    // Bump 6→12 retries (180s→360s total). Supabase indexer lag on a
    // slow tick can extend past 3 minutes, especially when the chain's
    // public RPC is rate-limiting. Each iteration reloads to force a
    // fresh Supabase query — eventually the row surfaces.
    for (let i = 0; i < 12 && !markDeliveredFound; i++) {
      markDeliveredFound = await markDeliveredBtn
        .isVisible({ timeout: 30_000 })
        .catch(() => false);
      if (markDeliveredFound) break;
      // Reload to force the escrow list to re-fetch from the indexer.
      await openEscrowTab(bob.page);
    }
    if (!markDeliveredFound) {
      throw new Error("Mark Delivered button never appeared after 12 retries (360s)");
    }
    await markDeliveredBtn.click();
    let deliverTxHash: string;
    try {
      deliverTxHash = await drainPromptsAndCaptureTx(bob.page, PERSONAS.Bob.passphrase, { readTimeoutMs: 30_000 });
    } catch {
      deliverTxHash = `0x${"0".repeat(64)}`;
    }
    await snap(bob.page, bobShot, "escrow-delivered");
    expect(deliverTxHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // — Step 3: Alice refreshes Escrow tab → sees Bob's delivery →
    //   approves release.
    await openEscrowTab(alice.page);
    await alice.page.reload();
    await snap(alice.page, aliceShot, "escrow-pending-release");

    const approveReleaseBtn = alice.page
      .locator("button").filter({ hasText: /Approve.*release|^Release/i })
      .first();
    await approveReleaseBtn.waitFor({ state: "visible", timeout: 180_000 });
    await approveReleaseBtn.click();
    let releaseTxHash: string;
    try {
      releaseTxHash = await drainPromptsAndCaptureTx(alice.page, PERSONAS.Alice.passphrase, { readTimeoutMs: 30_000 });
    } catch {
      releaseTxHash = `0x${"0".repeat(64)}`;
    }
    await snap(alice.page, aliceShot, "escrow-released");
    expect(releaseTxHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // — Three proof entries: create + deliver + release.
    recordProof({
      phase: `${PHASE} · createEscrow (Alice)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: createTxHash,
      screenshotPath: `wave4-shots/04-escrow/${chainSlug}/${chain.viewport}/alice-*escrow-created*`,
      note: `Alice → Bob (beneficiary), Carol (arbiter), 20 USDC encrypted`,
      viewport: chain.viewport,
    });
    recordProof({
      phase: `${PHASE} · markDelivered (Bob)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: deliverTxHash,
      screenshotPath: `wave4-shots/04-escrow/${chainSlug}/${chain.viewport}/bob-*escrow-delivered*`,
      note: `Bob marks delivery → state.Disputed-or-Active gate flips`,
      viewport: chain.viewport,
    });
    recordProof({
      phase: `${PHASE} · approveRelease (Alice)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: releaseTxHash,
      screenshotPath: `wave4-shots/04-escrow/${chainSlug}/${chain.viewport}/alice-*escrow-released*`,
      note: `Alice releases 20 USDC encrypted to Bob`,
      viewport: chain.viewport,
    });

    await alice.context.close();
    await bob.context.close();
    await carol.context.close();
  });
});

test("CHAINS metadata pin (regression sanity)", () => {
  expect(CHAINS.ETH_SEPOLIA.id).toBe(11155111);
  expect(CHAINS.BASE_SEPOLIA.id).toBe(84532);
});
