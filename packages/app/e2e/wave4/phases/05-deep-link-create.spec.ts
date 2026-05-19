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
//  Phase 5 — public deep-link CREATE (sender/seller/creator side).
//
//  Alice creates 5 public surfaces in one suite:
//   • Claim link, Bearer mode      → /claim/:chainId/:linkId#0:<secret>
//   • Claim link, EmailBound mode  → /claim/:chainId/:linkId#1:<secret>
//   • Claim link, AddressBound mode→ /claim/:chainId/:linkId#2:<secret>
//   • Storefront auction listing   → /shop/:chainId/:listingId
//   • Crowdfund campaign           → /fund/:chainId/:campaignId
//
//  For each create:
//   • One on-chain tx hash captured from the SendSuccess explorer link
//   • The full share URL written to WAVE4_TESTING_TODO.md as the
//     urlArtifact so phase 6 (consume) can pick it up
//   • Screenshots at pre-create, post-passphrase, post-success
//
//  Auction listing here is JUST the create — the 3-bid scenario
//  (CLAUDE.md §I "auction with 3 bids" requirement) belongs to
//  phase 6 (consume) since bidding is buyer-side.
//
//  URL artifacts persist across phases via the auto-generated proof
//  block in WAVE4_TESTING_TODO.md. Phase 6 reads back via
//  readEntries() from helpers/testing-todo.ts.
// ──────────────────────────────────────────────────────────────────

const PHASE = "P5 Deep-Link Create";

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

async function bringUpAlice(
  browser: import("@playwright/test").Browser,
  chainId: number,
  baseURL: string,
): Promise<{ page: Page; context: import("@playwright/test").BrowserContext; address: string }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
  const page = await context.newPage();
  await page.goto("/");
  await setActiveChain(page, chainId);
  await injectPasskey(page, PERSONAS.Alice, chainId);
  await page.goto("/app/wallet");
  const addrLoc = page.locator('[data-testid="gas-wallet-address"]');
  await expect(addrLoc).toBeVisible({ timeout: 30_000 });
  const address = (await addrLoc.textContent())?.trim() ?? "";
  return { page, context, address };
}

/** Extract the share URL from the SendSuccess screen — typically
 *  rendered in a font-mono div with the `/claim/`, `/shop/`, or
 *  `/fund/` path prefix. */
async function readShareUrl(page: Page, pathPrefix: string, baseURL: string): Promise<string> {
  // 120s deadline (was 60s). The createLink path needs to settle
  // through: cofhe encrypt → relay submit → waitForTransactionReceipt
  // → extractEventId → setState({step:"success",shareableUrl}). On a
  // slow Sepolia tick the receipt alone can take 30-40s, leaving 20s
  // for the DOM transition. Doubling the budget removes the cascade
  // where all 3 modes (Bearer/EmailBound/AddressBound) timeout in
  // sequence on a single suite run.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const text = (await page
      .locator(`text=/${pathPrefix.replace(/\//g, "\\/")}\\S+/`)
      .first()
      .textContent()
      .catch(() => null)) ?? "";
    const m = text.match(new RegExp(`https?://[^\\s]+${pathPrefix}[^\\s'"]+`));
    if (m) return m[0];
    // Fall back: the success screen's "Copy link" button has the URL
    // somewhere in the surrounding span — try reading from the
    // clipboard via page.evaluate (jsdom supports navigator.clipboard).
    const found = await page.evaluate((prefix) => {
      const all = document.querySelectorAll("code, pre, span, div");
      for (const el of Array.from(all)) {
        const t = el.textContent?.trim() ?? "";
        if (t.includes(prefix) && (t.startsWith("http") || t.startsWith(prefix))) {
          return t;
        }
      }
      return "";
    }, pathPrefix);
    if (found) {
      return found.startsWith("http") ? found : new URL(found, baseURL).toString();
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`No ${pathPrefix} share URL surfaced within timeout`);
}

test.describe("Phase 5 — public deep-link create", () => {
  test.describe.configure({ mode: "serial" });

  test("Alice creates 3 claim links (Bearer + EmailBound + AddressBound)", async ({
    browser,
    baseURL,
  }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";
    const alice = await bringUpAlice(browser, chain.chainId, url);
    const shot = { phase: "05-deep-link-create", persona: "alice", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);

    await faucetUsdc(alice.page, alice.address, chain.chainId, url);
    await alice.page.reload();
    await shieldUsdc(alice.page, "100", PERSONAS.Alice.passphrase);

    // Bob's address — needed for AddressBound mode. Spawn a throwaway
    // context just to read the deterministic address.
    const bobCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: url });
    const bobPage = await bobCtx.newPage();
    await bobPage.goto("/");
    await setActiveChain(bobPage, chain.chainId);
    await injectPasskey(bobPage, PERSONAS.Bob, chain.chainId);
    await bobPage.goto("/app/wallet");
    await bobPage.locator('[data-testid="gas-wallet-address"]').waitFor({ state: "visible", timeout: 30_000 });
    const bobAddress = (await bobPage.locator('[data-testid="gas-wallet-address"]').textContent())?.trim() ?? "";
    await bobCtx.close();
    expect(bobAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // The CreateClaimLink screen has a 3-way mode picker (Bearer /
    // Email / Address). Each mode shows a different second-factor
    // input.
    const modes: Array<{ key: "Bearer" | "EmailBound" | "AddressBound"; label: string; secondFactor?: (page: Page) => Promise<void> }> = [
      { key: "Bearer", label: "Anyone" },
      {
        key: "EmailBound",
        label: "Email",
        secondFactor: async (p) => {
          await p.locator('input[type="email"]').fill("bob+wave4@blank.test");
        },
      },
      {
        key: "AddressBound",
        label: "Address",
        secondFactor: async (p) => {
          // The address input has placeholder "0x… or alice.eth".
          await p.locator('input[placeholder*="0x"]').first().fill(bobAddress);
        },
      },
    ];

    for (const mode of modes) {
      await alice.page.goto("/app/claim-link");
      await snap(alice.page, shot, `claim-${mode.key.toLowerCase()}-form`);

      // Pick the mode pill by visible label.
      await alice.page
        .locator(`button:has-text("${mode.label}")`)
        .first()
        .click();

      // Fill amount (10 USDC) and the mode-specific second factor.
      await alice.page.locator('input[placeholder="10.00"]').fill("10");
      if (mode.secondFactor) await mode.secondFactor(alice.page);

      await alice.page
        .locator("button").filter({ hasText: /^Create link/i })
        .click();

      const txHash = await drainPromptsAndCaptureTx(alice.page, PERSONAS.Alice.passphrase, {
        // 300s budget: claim-link create has the FHE encryption pipeline
        // (load WASM module + fetch keys + encrypt + ZK proof + submit
        // + confirm) PLUS the on-chain UserOp. First iteration of the
        // 3-mode loop (Bearer/Email/Address) bears the cold-cache cost.
        readTimeoutMs: 300_000,
        windowMs: 600_000,
      });
      const shareUrl = await readShareUrl(alice.page, "/claim/", url);
      const successShot = await snap(alice.page, shot, `claim-${mode.key.toLowerCase()}-success`);

      expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(shareUrl).toContain("/claim/");

      recordProof({
        phase: `${PHASE} · claim ${mode.key}`,
        chainName: chain.chainName,
        chainId: chain.chainId,
        txHash,
        screenshotPath: successShot,
        urlArtifact: shareUrl,
        note: `Alice creates 10-USDC claim link · mode=${mode.key}`,
        viewport: chain.viewport,
      });
    }

    await alice.context.close();
  });

  test("Alice creates a sealed-bid auction listing", async ({ browser, baseURL }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";
    const alice = await bringUpAlice(browser, chain.chainId, url);
    const shot = { phase: "05-deep-link-create", persona: "alice", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);

    await faucetUsdc(alice.page, alice.address, chain.chainId, url);
    await alice.page.reload();
    await shieldUsdc(alice.page, "100", PERSONAS.Alice.passphrase);

    await alice.page.goto("/app/sell");
    await snap(alice.page, shot, "create-listing-landing");

    // Mode picker: Fixed price / Auction / Pay-what-you-want. Click
    // "Auction" pill.
    await alice.page
      .locator('button:has-text("Auction")')
      .first()
      .click();

    // CreateListing's Field component renders <label>+<input> as siblings
    // without an htmlFor↔id association, so getByLabel may not resolve.
    // Scope by the parent div: find a div that contains a label with the
    // expected text, then the input inside. Avoids matching the global
    // search bar at the top of the page (the prior fall-through-to-input
    // selector hit it).
    await alice.page.locator('div:has(> label:text-is("Product title")) input').fill("E2E Auction Item");
    await alice.page.locator('div:has(> label:text-is("Minimum bid (USDC, 0 = any)")) input').fill("1");
    await alice.page.locator('div:has(> label:text-is("How will you deliver?")) input').fill("DM @e2e-test on Telegram");

    await snap(alice.page, shot, "auction-form-filled");

    await alice.page.locator("button").filter({ hasText: /^Create listing/i }).click();
    const txHash = await drainPromptsAndCaptureTx(alice.page, PERSONAS.Alice.passphrase);
    const shareUrl = await readShareUrl(alice.page, "/shop/", url);
    const successShot = await snap(alice.page, shot, "auction-created");

    recordProof({
      phase: `${PHASE} · listing auction`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash,
      screenshotPath: successShot,
      urlArtifact: shareUrl,
      note: `Alice creates sealed-bid auction (min bid 1 USDC). 3-bid scenario in phase 6.`,
      viewport: chain.viewport,
    });

    await alice.context.close();
  });

  test("Alice creates a crowdfund campaign (positive encGoal)", async ({ browser, baseURL }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";
    const alice = await bringUpAlice(browser, chain.chainId, url);
    const shot = { phase: "05-deep-link-create", persona: "alice", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);

    await faucetUsdc(alice.page, alice.address, chain.chainId, url);
    await alice.page.reload();
    await shieldUsdc(alice.page, "100", PERSONAS.Alice.passphrase);

    await alice.page.goto("/app/fundraise");
    await snap(alice.page, shot, "create-campaign-landing");

    // Scope by parent div containing the labeled field — same pattern as
    // the auction listing test. Avoids hitting the global search bar
    // (which earlier nth(0) selectors did).
    await alice.page.locator('div:has(> label:text-is("Campaign title")) input').fill("Wave 4 E2E Campaign");
    await alice.page.locator('div:has(> label:text-is("Description")) textarea').fill("Headless E2E test campaign. Bob + Carol contribute in phase 6.");
    await alice.page.locator('div:has(> label:text-is("Funding goal (USDC)")) input').fill("50");

    await snap(alice.page, shot, "campaign-form-filled");

    await alice.page.locator("button").filter({ hasText: /^Launch campaign/i }).click();
    const txHash = await drainPromptsAndCaptureTx(alice.page, PERSONAS.Alice.passphrase);
    const shareUrl = await readShareUrl(alice.page, "/fund/", url);
    const successShot = await snap(alice.page, shot, "campaign-created");

    recordProof({
      phase: `${PHASE} · campaign create`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash,
      screenshotPath: successShot,
      urlArtifact: shareUrl,
      note: `Alice launches 50-USDC-goal campaign. Bob + Carol contribute in phase 6.`,
      viewport: chain.viewport,
    });

    await alice.context.close();
  });
});

test("CHAINS metadata pin (regression sanity)", () => {
  expect(CHAINS.ETH_SEPOLIA.id).toBe(11155111);
  expect(CHAINS.BASE_SEPOLIA.id).toBe(84532);
});
