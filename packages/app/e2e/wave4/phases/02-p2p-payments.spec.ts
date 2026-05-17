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
import { enterPassphrase, faucetUsdcIfNeeded, readTxHashFromSuccess, shieldUsdc } from "../helpers/app-actions";

// ──────────────────────────────────────────────────────────────────
//  Phase 2 — P2P encrypted payments (Alice ↔ Bob).
//
//  Coverage:
//   • Happy path: Alice sends 5 USDC encrypted to Bob → relay tx hash
//   • Negative: Alice attempts to send more than her shielded
//     balance → expect a humanized error, no relay tx
//
//  Multi-party rule (CLAUDE.md §G): Alice + Bob live in separate
//  BrowserContexts so their IndexedDB / chain state never crosses.
//
//  Pre-conditions:
//   • Phase 1 ran on this chain (or this test self-bootstraps via
//     /api/faucet/usdc + the shield helper). Phase 2 is self-contained:
//     it faucets, shields, and sends entirely from a clean state so
//     judges can replay just this phase if needed.
// ──────────────────────────────────────────────────────────────────

const PHASE = "P2 P2P Payments";

function chainContextFromProject(): { chainId: number; chainName: string; viewport: string; chainKey: ChainKey } {
  const meta = test.info().project.metadata as
    | { chainId?: number; chainName?: string; viewport?: string }
    | undefined;
  if (!meta?.chainId || !meta.chainName) {
    throw new Error("Project metadata missing chainId/chainName");
  }
  const chainKey: ChainKey = meta.chainId === 11155111 ? "ETH_SEPOLIA" : "BASE_SEPOLIA";
  return {
    chainId: meta.chainId,
    chainName: meta.chainName,
    viewport: meta.viewport ?? "desktop",
    chainKey,
  };
}

// Faucet drip is now a shared helper that skips-if-funded — see
// helpers/app-actions.ts. Re-export the call shape here for clarity.
async function faucetUsdc(page: Page, address: string, chainId: number, baseURL: string): Promise<string> {
  return faucetUsdcIfNeeded(page, address, chainId, baseURL);
}

// Drive a recipient picker + amount input → confirm → success.
async function driveSendFlow(
  page: Page,
  recipientAddress: string,
  amountUsdc: string,
  passphrase: string,
): Promise<{ txHash: string }> {
  // Caller is expected to have already navigated to /app/send.
  // Step 1: enter recipient. SendContacts has an input with
  // placeholder="0x… or pratik.eth" for direct-address entry.
  const recipientInput = page
    .locator('input[placeholder*="0x"]')
    .or(page.locator('input[placeholder*="Wallet address"]'))
    .first();
  await recipientInput.waitFor({ state: "visible", timeout: 30_000 });
  await recipientInput.fill(recipientAddress);

  // The continue/next button advances to SendAmount. SendContacts uses
  // the label "Continue" (see src/blank-ui/screens/SendContacts.tsx);
  // the wider regex covers any future rename to "Next".
  const continueBtn = page
    .locator("button").filter({ hasText: /^(Continue|Next)/i })
    .first();
  await continueBtn.click();

  // Step 2: amount input on SendAmount. The screen uses either a
  // plaintext `<input placeholder="0.00">` (legacy / wider viewport)
  // or a virtual NumericKeypad (current default) with one
  // `<button aria-label="1">..."9","0",".","Backspace">` per digit.
  // Probe both: prefer the input; fall back to clicking the keypad.
  const amountInput = page.locator('input[placeholder="0.00"]').first();
  const amountInputVisible = await amountInput
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (amountInputVisible) {
    await amountInput.fill(amountUsdc);
  } else {
    // Numeric keypad path — click each character of `amountUsdc`.
    // A button with aria-label="<digit-or-dot>" exists per key.
    for (const ch of amountUsdc) {
      const key = page
        .locator(`button[aria-label="${ch}"]:visible`)
        .first();
      await key.waitFor({ state: "visible", timeout: 10_000 });
      await key.click();
    }
  }

  // Advance from SendAmount → SendConfirm. The button label depends on
  // the current state machine (Continue / Review / Next / Send / Send X
  // USDC); match any of those that's enabled and visible.
  const confirmBtn = page
    .locator("button:visible:not([disabled])")
    .filter({ hasText: /^(Continue|Review|Next|Send)/i })
    .last();
  await confirmBtn.waitFor({ state: "visible", timeout: 15_000 });
  await confirmBtn.click();

  // Step 3: confirm screen. SendConfirm's button text is "Confirm & Send"
  // in the happy state; widen to also match "Send", "Confirm", or
  // "Continue stealth send" in case of mode toggles.
  const finalSendBtn = page
    .locator("button:visible:not([disabled])")
    .filter({ hasText: /Confirm.*Send|Send to stealth|Continue stealth send|^Send/i })
    .last();
  await finalSendBtn.waitFor({ state: "visible", timeout: 15_000 });
  await finalSendBtn.click();

  // Step 4: passphrase prompt.
  await enterPassphrase(page, passphrase);

  // Step 5: SendSuccess renders the tx hash explorer link.
  const txHash = await readTxHashFromSuccess(page);
  return { txHash };
}

test.describe("Phase 2 — P2P encrypted payments", () => {
  test.describe.configure({ mode: "serial" });

  test("happy path: Alice sends 5 USDC encrypted to Bob", async ({ browser, baseURL }) => {
    // AA UserOp roundtrip = up to ~120s per tx on Sepolia under load. Shield
    // is one tx, send is another. Default 300s isn't enough for two of those
    // back-to-back plus all the navigation + encryption overhead.
    test.setTimeout(720_000);
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const alice = PERSONAS.Alice;
    const bob = PERSONAS.Bob;
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";

    // — Bob spawns first so we can capture his address before Alice
    //   needs to type it into the recipient input.
    const bobCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      baseURL: url,
    });
    const bobPage = await bobCtx.newPage();
    await bobPage.goto("/");
    await setActiveChain(bobPage, chain.chainId);
    await injectPasskey(bobPage, bob, chain.chainId);
    await bobPage.goto("/app/wallet");
    const bobAddrLoc = bobPage.locator('[data-testid="gas-wallet-address"]');
    await expect(bobAddrLoc).toBeVisible({ timeout: 30_000 });
    const bobAddress = (await bobAddrLoc.textContent())?.trim() ?? "";
    expect(bobAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // — Alice's context: faucet + shield + send.
    const aliceCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      baseURL: url,
    });
    const alicePage = await aliceCtx.newPage();
    // Surface page-side errors so any silent failure during shield / send
    // turns into a real test signal instead of "test timed out" with no
    // clue why.
    alicePage.on("console", (m) => {
      const t = m.text();
      if (
        m.type() === "error" ||
        /shield|relay|userop|revert|fail|error|aa\d{2}/i.test(t)
      ) {
        console.log(`[alice console:${m.type()}] ${t.slice(0, 300)}`);
      }
    });
    alicePage.on("pageerror", (e) => {
      console.log(`[alice pageerror] ${e.message}`);
    });
    await alicePage.goto("/");
    await setActiveChain(alicePage, chain.chainId);
    await injectPasskey(alicePage, alice, chain.chainId);

    const shotCtx = { phase: "02-p2p", persona: "alice", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shotCtx);

    // Bootstrap Alice with TestUSDC + shield 20 USDC so she has
    // encrypted balance to send.
    await alicePage.goto("/app/wallet");
    await alicePage.locator('[data-testid="gas-wallet-address"]').waitFor({ state: "visible", timeout: 30_000 });
    const aliceAddress = (await alicePage.locator('[data-testid="gas-wallet-address"]').textContent())?.trim() ?? "";
    await faucetUsdc(alicePage, aliceAddress, chain.chainId, url);

    // Wait for the TestUSDC balance to surface, then shield.
    await alicePage.reload();
    await alicePage.locator("text=/\\d+(?:\\.\\d+)?\\s*USDC/").first().waitFor({ state: "visible", timeout: 60_000 });
    await snap(alicePage, shotCtx, "pre-shield");
    await shieldUsdc(alicePage, "20", alice.passphrase);
    await snap(alicePage, shotCtx, "post-shield");

    // Navigate to send + drive the flow.
    await alicePage.goto("/app/send");
    await snap(alicePage, shotCtx, "send-screen");

    const sendOut = await driveSendFlow(alicePage, bobAddress, "5", alice.passphrase);
    const finalShot = await snap(alicePage, shotCtx, "send-success");

    expect(sendOut.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    recordProof({
      phase: `${PHASE} · Alice → Bob`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: sendOut.txHash,
      screenshotPath: finalShot,
      note: `Alice → Bob, 5 USDC encrypted`,
      viewport: chain.viewport,
    });

    await aliceCtx.close();
    await bobCtx.close();
  });

  test("negative: send more than encrypted balance surfaces humanized error (no tx)", async ({ browser, baseURL }) => {
    // CLAUDE.md §I — one negative per fund-flow. Alice attempts to
    // send 1,000 USDC (more than her 20-USDC shielded balance). The
    // contract reverts with "insufficient balance"; useUnifiedWrite's
    // humanizeWriteError maps that to a user-friendly toast/error and
    // the success state is never reached.
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const alice = PERSONAS.Alice;
    const bob = PERSONAS.Bob;
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";

    // Reuse the happy-path context state when possible — but for true
    // isolation per CLAUDE.md §G, spawn fresh contexts.
    const bobCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: url });
    const bobPage = await bobCtx.newPage();
    await bobPage.goto("/");
    await setActiveChain(bobPage, chain.chainId);
    await injectPasskey(bobPage, bob, chain.chainId);
    await bobPage.goto("/app/wallet");
    await bobPage.locator('[data-testid="gas-wallet-address"]').waitFor({ state: "visible", timeout: 30_000 });
    const bobAddress = (await bobPage.locator('[data-testid="gas-wallet-address"]').textContent())?.trim() ?? "";

    const aliceCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: url });
    const alicePage = await aliceCtx.newPage();
    await alicePage.goto("/");
    await setActiveChain(alicePage, chain.chainId);
    await injectPasskey(alicePage, alice, chain.chainId);
    // No faucet + no shield — Alice has zero encrypted balance here.

    const shotCtx = { phase: "02-p2p-negative", persona: "alice", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shotCtx);

    await alicePage.goto("/app/send");
    await snap(alicePage, shotCtx, "send-screen");

    // Drive the flow but expect failure at the relay step. We don't
    // wait for tx-hash success here — we look for either an error
    // toast (text matching /insufficient|balance/i) or the form
    // staying on the confirm step.
    const recipientInput = alicePage.locator('input[placeholder*="0x"]').first();
    await recipientInput.waitFor({ state: "visible", timeout: 30_000 });
    await recipientInput.fill(bobAddress);
    await alicePage.locator("button").filter({ hasText: /^Next/i }).first().click();

    await alicePage.locator('input[placeholder="0.00"]').first().fill("1000");
    await alicePage.locator("button").filter({ hasText: /^Send/i }).last().click();
    await alicePage.locator("button").filter({ hasText: /^Confirm/i }).last().click();

    // Either passphrase prompt fires (and relay rejects post-encrypt),
    // or pre-encryption validation catches the over-balance attempt
    // upfront. Either way, NO success state.
    try {
      await enterPassphrase(alicePage, alice.passphrase);
    } catch {
      // Passphrase prompt may not surface if pre-check catches it.
    }

    // Wait for an error indicator: red toast, error banner, or
    // staying on the confirm screen for > 5s without a success.
    const errorVisible = await Promise.race([
      alicePage.locator("text=/insufficient|balance|too high|exceeds/i").first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false),
      alicePage.locator('a[href*="/tx/0x"]').first().waitFor({ state: "visible", timeout: 60_000 }).then(() => false).catch(() => false),
    ]);

    await snap(alicePage, shotCtx, "negative-error-surface");

    expect(errorVisible, "Expected an insufficient-balance error surface; got a success page instead").toBe(true);

    // No tx hash to record. Note the proof differently: include a
    // synthetic "0x0…0" hash so recordProof's dedup key works, with a
    // negative-case note. (Stopping conditions require a tx hash for
    // shipped features; negative cases are evidence of guarded
    // behavior, not features themselves — we still surface them in
    // the proof block for visibility.)
    recordProof({
      phase: `${PHASE} · Alice over-balance (negative)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: `0x${"0".repeat(64)}`,
      screenshotPath: `${alicePage.url()} (no on-chain tx; revert path)`,
      note: `Alice attempts 1,000 USDC with 0 shielded → error surfaces (no relay tx)`,
      viewport: chain.viewport,
    });

    await aliceCtx.close();
    await bobCtx.close();
  });
});

// Compile-time sanity that the chain export matches the spec.
test("CHAINS metadata pin (regression sanity)", () => {
  expect(CHAINS.ETH_SEPOLIA.id).toBe(11155111);
  expect(CHAINS.BASE_SEPOLIA.id).toBe(84532);
});
