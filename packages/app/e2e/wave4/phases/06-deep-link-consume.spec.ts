import { test, expect, type Page } from "@playwright/test";
import {
  PERSONAS,
  CHAINS,
  injectPasskey,
  setActiveChain,
  type ChainKey,
} from "../fixtures/wallets";
import { snap, resetCounter } from "../helpers/screenshot";
import { recordProof, readEntries } from "../helpers/testing-todo";
import { drainPromptsAndCaptureTx, shieldUsdc, faucetUsdcIfNeeded } from "../helpers/app-actions";

// ──────────────────────────────────────────────────────────────────
//  Phase 6 — public deep-link CONSUME (recipient/buyer/contributor).
//
//  Reads back the URLs phase 5 wrote into WAVE4_TESTING_TODO.md and
//  exercises them as a real outside-user would. Covers:
//
//   • Claim link Bearer       → Bob claims via the URL fragment
//   • Claim link EmailBound   → Bob claims with the bound email
//   • Claim link AddressBound → Bob claims (he is the bound address)
//   • Storefront auction      → Bob + Carol place 3 bids total
//                               (Bob×2 + Carol×1 since seller can't
//                               self-bid). Close + reveal belongs to
//                               post-deadline coverage and is out of
//                               this phase's scope (auction min
//                               duration is 1 hour).
//   • Crowdfund campaign      → Bob + Carol each contribute (2 txs)
//   • F1 error UI verify      → Navigate to /verify/99999999 with a
//                               nonexistent proof id; assert the new
//                               transient/permanent UI surfaces
//                               "not found" (permanent) — no Retry
//                               CTA + Go home link present.
//
//  Phase 6 doesn't try to close+reveal the auction or close the
//  campaign — both require the on-chain deadline to elapse (auction
//  ≥ 1 hour, campaign ≥ 1 hour). A separate post-deadline phase
//  could cover those if a future iteration needs it.
// ──────────────────────────────────────────────────────────────────

const PHASE = "P6 Deep-Link Consume";

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

async function bringUp(
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
  await page.locator('[data-testid="gas-wallet-address"]').waitFor({ state: "visible", timeout: 30_000 });
  const address = (await page.locator('[data-testid="gas-wallet-address"]').textContent())?.trim() ?? "";
  return { page, context, address };
}

/** Look up a urlArtifact stored by phase 5 by phase-tag + chainId. */
function readArtifactURL(phaseTag: string, chainId: number): string {
  const entries = readEntries();
  const match = entries.find(
    (e) => e.phase.includes(phaseTag) && e.chainId === chainId && e.urlArtifact,
  );
  if (!match?.urlArtifact) {
    throw new Error(
      `No urlArtifact recorded for phase tag "${phaseTag}" on chainId ${chainId}. Run phase 5 first.`,
    );
  }
  return match.urlArtifact;
}

test.describe("Phase 6 — public deep-link consume", () => {
  test.describe.configure({ mode: "serial" });

  test("Bob claims the 3 claim links Alice created", async ({ browser, baseURL }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";
    const bob = await bringUp(browser, PERSONAS.Bob, chain.chainId, url);
    const shot = { phase: "06-deep-link-consume", persona: "bob", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);

    // Bob needs some testnet ETH-equivalent for gas-wallet but the
    // paymaster covers UserOps on testnet, so no faucet needed for
    // claim-side. The claim itself doesn't move funds out of Bob's
    // vault — it moves them IN (vault.transferVerified to claimer).

    // Each (mode → URL) pair from phase 5.
    const modes: Array<{ key: "Bearer" | "EmailBound" | "AddressBound"; tag: string; needsEmail?: boolean }> = [
      { key: "Bearer", tag: "claim Bearer" },
      { key: "EmailBound", tag: "claim EmailBound", needsEmail: true },
      { key: "AddressBound", tag: "claim AddressBound" },
    ];

    for (const mode of modes) {
      const claimUrl = readArtifactURL(mode.tag, chain.chainId);
      await bob.page.goto(claimUrl);
      await snap(bob.page, shot, `claim-${mode.key.toLowerCase()}-landing`);

      // EmailBound needs the email input filled before Claim is
      // enabled. ClaimLinkPage uses placeholder="you@example.com".
      if (mode.needsEmail) {
        await bob.page
          .locator('input[type="email"], input[placeholder*="@"]')
          .first()
          .fill("bob+wave4@blank.test");
      }

      // AddressBound: ClaimLinkPage already shows a guard banner if
      // the connected wallet doesn't match boundAddress. Since Bob's
      // deterministic AA address IS the bound address, the page lets
      // him click Claim.
      const claimBtn = bob.page
        .locator("button").filter({ hasText: /^Claim/i })
        .first();
      await claimBtn.waitFor({ state: "visible", timeout: 30_000 });
      await claimBtn.click();

      const txHash = await drainPromptsAndCaptureTx(bob.page, PERSONAS.Bob.passphrase);
      const successShot = await snap(bob.page, shot, `claim-${mode.key.toLowerCase()}-claimed`);

      expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

      recordProof({
        phase: `${PHASE} · claim ${mode.key} (Bob)`,
        chainName: chain.chainName,
        chainId: chain.chainId,
        txHash,
        screenshotPath: successShot,
        urlArtifact: claimUrl,
        note: `Bob claims 10-USDC ${mode.key} link`,
        viewport: chain.viewport,
      });
    }

    await bob.context.close();
  });

  test("Storefront auction: Bob + Carol place 3 bids total (Bob×2 + Carol×1)", async ({
    browser,
    baseURL,
  }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";
    const auctionUrl = readArtifactURL("listing auction", chain.chainId);

    const bob = await bringUp(browser, PERSONAS.Bob, chain.chainId, url);
    const carol = await bringUp(browser, PERSONAS.Carol, chain.chainId, url);

    // Bidders need shielded balance — faucet + shield.
    for (const persona of [bob, carol]) {
      await faucetUsdc(persona.page, persona.address, chain.chainId, url);
      await persona.page.reload();
    }
    await shieldUsdc(bob.page, "50", PERSONAS.Bob.passphrase);
    await shieldUsdc(carol.page, "50", PERSONAS.Carol.passphrase);

    const bobShot = { phase: "06-deep-link-consume", persona: "bob", chain: chainSlug, viewport: chain.viewport };
    const carolShot = { phase: "06-deep-link-consume", persona: "carol", chain: chainSlug, viewport: chain.viewport };
    resetCounter(bobShot);
    resetCounter(carolShot);

    const placeBid = async (page: Page, persona: typeof PERSONAS[keyof typeof PERSONAS], amount: string, label: string) => {
      await page.goto(auctionUrl);
      await snap(
        page,
        { phase: "06-deep-link-consume", persona: persona.name.toLowerCase(), chain: chainSlug, viewport: chain.viewport },
        `auction-${label}-landing`,
      );
      // The Auction view renders a BuyForm with placeholder "enter your max"
      // for the bid input + a "Place bid" CTA.
      await page.locator('input[placeholder="enter your max"]').fill(amount);
      await page.locator("button").filter({ hasText: /^Place bid/i }).click();
      const txHash = await drainPromptsAndCaptureTx(page, persona.passphrase);
      const shot = await snap(
        page,
        { phase: "06-deep-link-consume", persona: persona.name.toLowerCase(), chain: chainSlug, viewport: chain.viewport },
        `auction-${label}-placed`,
      );
      return { txHash, screenshot: shot };
    };

    // 3 bids — Bob × 2 + Carol × 1 since seller (Alice) can't bid
    // her own auction (Storefront.sol require msg.sender != seller).
    const bid1 = await placeBid(bob.page, PERSONAS.Bob, "5", "bob-bid1");
    const bid2 = await placeBid(bob.page, PERSONAS.Bob, "8", "bob-bid2");
    const bid3 = await placeBid(carol.page, PERSONAS.Carol, "12", "carol-bid1");

    for (const [i, b] of [bid1, bid2, bid3].entries()) {
      expect(b.txHash, `bid ${i + 1} tx hash invalid`).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }

    recordProof({
      phase: `${PHASE} · auction bid 1 (Bob 5 USDC)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: bid1.txHash,
      screenshotPath: bid1.screenshot,
      urlArtifact: auctionUrl,
      note: `Bob bids 5 USDC encrypted on Alice's auction`,
      viewport: chain.viewport,
    });
    recordProof({
      phase: `${PHASE} · auction bid 2 (Bob 8 USDC)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: bid2.txHash,
      screenshotPath: bid2.screenshot,
      urlArtifact: auctionUrl,
      note: `Bob raises encrypted bid to 8 USDC (multi-bid per address allowed)`,
      viewport: chain.viewport,
    });
    recordProof({
      phase: `${PHASE} · auction bid 3 (Carol 12 USDC)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: bid3.txHash,
      screenshotPath: bid3.screenshot,
      urlArtifact: auctionUrl,
      note: `Carol bids 12 USDC encrypted — would win at close per FHE-tournament`,
      viewport: chain.viewport,
    });

    await bob.context.close();
    await carol.context.close();
  });

  test("Crowdfund: Bob + Carol each contribute to Alice's campaign", async ({ browser, baseURL }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";
    const campaignUrl = readArtifactURL("campaign create", chain.chainId);

    for (const personaKey of ["Bob", "Carol"] as const) {
      const persona = PERSONAS[personaKey];
      const ctx = await bringUp(browser, persona, chain.chainId, url);
      const shot = {
        phase: "06-deep-link-consume",
        persona: personaKey.toLowerCase(),
        chain: chainSlug,
        viewport: chain.viewport,
      };
      resetCounter(shot);

      await faucetUsdc(ctx.page, ctx.address, chain.chainId, url);
      await ctx.page.reload();
      await shieldUsdc(ctx.page, "40", persona.passphrase);

      await ctx.page.goto(campaignUrl);
      await snap(ctx.page, shot, "campaign-landing");

      // CrowdfundPage open-phase renders a SimpleAction with an
      // amount input + "Contribute" CTA. Loose selector to handle
      // copy churn.
      await ctx.page
        .locator('input[inputmode="decimal"], input[placeholder*="0.00"]')
        .first()
        .fill("30");
      await ctx.page
        .locator("button").filter({ hasText: /^Contribute/i })
        .click();
      const txHash = await drainPromptsAndCaptureTx(ctx.page, persona.passphrase);
      const successShot = await snap(ctx.page, shot, "campaign-contributed");

      expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

      recordProof({
        phase: `${PHASE} · campaign contribution (${personaKey})`,
        chainName: chain.chainName,
        chainId: chain.chainId,
        txHash,
        screenshotPath: successShot,
        urlArtifact: campaignUrl,
        note: `${personaKey} contributes 30 USDC encrypted (cumulative 60 vs 50 goal — verdict TRUE at close)`,
        viewport: chain.viewport,
      });

      await ctx.context.close();
    }
  });

  test("F1 error UI: /verify/99999999 (nonexistent proof) shows permanent 'not found' + Go home, no Retry", async ({
    browser,
    baseURL,
  }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";

    // No passkey needed for the public verify page; spawn a fresh
    // context to avoid any localStorage chain switching getting in
    // the way.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: url });
    const page = await context.newPage();

    // Force the desired chain via the URL param.
    const verifyUrl = `${url}/verify/99999999?chain=${chain.chainId}`;
    await page.goto(verifyUrl);

    const shot = { phase: "06-deep-link-consume", persona: "public", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);
    await snap(page, shot, "verify-nonexistent-landing");

    // The §F1 classifier: "Proof not found" headline + Go home CTA
    // + absence of Retry CTA. The classifier may take a few seconds
    // because the RPC has to fail with a revert (not a network
    // error) for the classifier to land on the permanent branch.
    await page.waitForTimeout(8_000); // give the RPC + classifier time
    const finalShot = await snap(page, shot, "verify-nonexistent-final");

    const html = (await page.content()).toLowerCase();
    expect(html).toMatch(/proof not found|not found|doesn't exist/);
    // Permanent path: Go home CTA visible; Retry CTA NOT visible.
    expect(html).toContain("go home");
    expect(html).not.toContain(">retry<");

    // Synthetic proof entry — no on-chain tx since this is a UI-only
    // assertion that the F1 classifier handles permanent errors.
    recordProof({
      phase: `${PHASE} · F1 permanent error UI`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: `0x${"0".repeat(64)}`,
      screenshotPath: finalShot,
      urlArtifact: verifyUrl,
      note: `Permanent error path: nonexistent proof id → "not found" + Go home, no Retry`,
      viewport: chain.viewport,
    });

    await context.close();
  });
});

test("CHAINS metadata pin (regression sanity)", () => {
  expect(CHAINS.ETH_SEPOLIA.id).toBe(11155111);
  expect(CHAINS.BASE_SEPOLIA.id).toBe(84532);
});
