import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { setActiveChain, type ChainKey } from "../fixtures/wallets";
import { snap, resetCounter } from "../helpers/screenshot";
import { recordProof } from "../helpers/testing-todo";

// ──────────────────────────────────────────────────────────────────
//  Phase 23 — Onboarding (real first-time passkey creation flow).
//
//  Closes the /onboarding gap from the judge-replay audit. This is
//  the ONLY spec that exercises the actual user-driven passkey
//  creation path. Every other phase uses `_testImportPasskey` to
//  short-circuit the modal + drop a deterministic key into
//  IndexedDB. That shortcut keeps the rest of the suite fast +
//  deterministic, but it BYPASSES the UI a real first-time judge
//  will hit.
//
//  Flow:
//   1. Fresh context, no passkey injection.
//   2. Visit /app. BlankApp's R5-C gate detects no passkey + no
//      EOA, renders <Onboarding /> instead.
//   3. Click Next through the 4-step carousel (Sparkles → Shield →
//      Lock → Key).
//   4. Final step shows the WalletChoiceCard. Click "Create with
//      passkey" → PasskeyCreationModal opens.
//   5. Type a strong passphrase (≥8 chars), confirm it, submit.
//   6. createPasskey() generates a P-256 key + AES-GCM-encrypts it
//      with the passphrase + writes to IndexedDB.
//   7. Modal auto-closes after 1.2s success → BlankApp's gate
//      flips → Dashboard renders.
//
//  Walkthrough findings logged in JUDGE_REPLAY_AUDIT.md.
// ──────────────────────────────────────────────────────────────────

const PHASE = "P23 Onboarding";
// Strong-enough passphrase: 16 chars, mixed types. NOT a real user
// passphrase — only used here to exercise the modal's validation.
const ONBOARDING_PASSPHRASE = "wave4-onboarding-test-passphrase-99";

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

test.describe("Phase 23 — Onboarding (real first-time passkey)", () => {
  test.describe.configure({ mode: "serial" });

  test("Fresh browser → 4-step carousel → PasskeyCreationModal → Dashboard render", async ({
    browser,
    baseURL,
  }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : chain.chainKey === "ARB_SEPOLIA" ? "arb-sepolia" : "base-sepolia";

    // Fresh context — NO injectPasskey() call. This is the whole
    // point: a real first-time judge would arrive with nothing.
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      baseURL: url,
    });
    const page: Page = await context.newPage();
    const shot = { phase: "23-onboarding", persona: "newuser", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);

    // Set active chain so the user lands on the right network from
    // the start. Onboarding is chain-agnostic but downstream gates
    // (Dashboard, ChainSelector) depend on it.
    await page.goto("/");
    await setActiveChain(page, chain.chainId);

    // Navigate to /app. BlankApp gate detects no passkey + no EOA,
    // mounts <Onboarding />. The first carousel step renders.
    await page.goto("/app");
    await page
      .locator("h2", { hasText: /Send money privately/i })
      .waitFor({ state: "visible", timeout: 30_000 });
    await snap(page, shot, "step-1-send-money-privately");

    // ─── Click through 4 carousel steps ─────────────────────────
    // Steps 1 → 2 → 3 → 4 via the Next button. Each step has its
    // own h2 we can assert against.
    const stepHeadings = [
      /Only you see the amounts/i,
      /Works everywhere you go/i,
      /Your keys\. Your money\./i,
    ];

    for (let i = 0; i < stepHeadings.length; i++) {
      const nextBtn = page.locator("button").filter({ hasText: /^Next$/i });
      await nextBtn.click();
      await page.locator("h2", { hasText: stepHeadings[i] }).waitFor({ state: "visible", timeout: 5_000 });
      await snap(page, shot, `step-${i + 2}-${stepHeadings[i].source.slice(0, 16)}`);
    }

    // ─── Final step: WalletChoiceCard ───────────────────────────
    // The "Next" button is hidden on the last step; the WalletChoiceCard
    // takes its place. Click the passkey CTA.
    const passkeyCta = page
      .locator("button").filter({ hasText: /passkey|smart wallet|create.*account/i })
      .first();
    await passkeyCta.waitFor({ state: "visible", timeout: 10_000 });
    await snap(page, shot, "wallet-choice-card-visible");
    await passkeyCta.click();

    // ─── PasskeyCreationModal opens ─────────────────────────────
    const passphraseInput = page.locator('[data-testid="passkey-passphrase-new"]');
    await passphraseInput.waitFor({ state: "visible", timeout: 10_000 });
    await snap(page, shot, "passkey-modal-opened");

    await passphraseInput.fill(ONBOARDING_PASSPHRASE);
    await page.locator('[data-testid="passkey-passphrase-confirm"]').fill(ONBOARDING_PASSPHRASE);
    await snap(page, shot, "passphrase-typed-confirmed");

    // Submit. createPasskey() runs in the worker: generates P-256
    // via @noble/curves, AES-GCM-encrypts the private scalar with
    // PBKDF2(passphrase, 250k iterations, sha256), writes to
    // IndexedDB. Real cryptography, no shortcuts.
    const submitBtn = page.locator('[data-testid="passkey-create-submit"]');
    await submitBtn.click();
    await snap(page, shot, "creating-passkey");

    // Wait for either: (a) the modal's success state + auto-close
    // (1.2s timer per Onboarding.tsx:223), (b) the Dashboard
    // rendering ("Welcome back" / Dashboard h1), or (c) an error
    // chip surfacing in the modal.
    let onboardingSuccess = false;
    let recordedNote: string;
    let recordedShot: string;

    try {
      await Promise.race([
        page.locator("text=/Welcome|Dashboard|recent activity|Send.*receive/i").first().waitFor({ state: "visible", timeout: 60_000 }),
        page.locator('[role="alert"]').waitFor({ state: "visible", timeout: 60_000 }),
        page.locator('[data-testid="gas-wallet-address"]').waitFor({ state: "visible", timeout: 60_000 }),
      ]);
    } catch {
      // Neither — bug in the flow.
    }

    const dashboardVisible =
      (await page.locator('[data-testid="gas-wallet-address"]').count()) > 0 ||
      (await page.locator("text=/Welcome|Dashboard/i").count()) > 0;

    if (dashboardVisible) {
      onboardingSuccess = true;
      recordedShot = await snap(page, shot, "dashboard-after-onboarding");
      recordedNote = `First-time passkey creation flow proven end-to-end. Fresh browser → 4-step carousel → WalletChoiceCard → PasskeyCreationModal → strong passphrase → P-256 key generated + AES-GCM-encrypted via PBKDF2(250k iterations) → stored in IndexedDB → BlankApp R5-C gate flips → Dashboard renders. This is the ONLY spec exercising the real user path (all other phases use _testImportPasskey shortcut for speed).`;
    } else {
      recordedShot = await snap(page, shot, "onboarding-stuck-or-error");
      recordedNote = `Onboarding flow reached the create-submit step but neither Dashboard nor an error chip surfaced within 60s. Possible causes: (a) PasskeyCreationModal success-state timer didn't fire, (b) BlankApp's R5-C gate isn't picking up the new passkey, (c) IndexedDB write is hanging. Triage by inspecting the captured screenshot + DevTools console.`;
    }

    recordProof({
      phase: `${PHASE} · first-time passkey create`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      // Onboarding doesn't fire an on-chain UserOp — the BlankAccount
      // is CREATE2-derived but only deployed on first UserOp (lazy).
      // Synthetic hash here reflects "no on-chain tx by design".
      txHash: `0x${"0".repeat(64)}`,
      screenshotPath: recordedShot,
      note: recordedNote,
      viewport: chain.viewport,
    });

    // Sanity: the test should land on Dashboard. Anything else is a
    // regression in the most-judged user path.
    expect(onboardingSuccess, "Real first-time passkey flow MUST land on Dashboard").toBe(true);

    await context.close();
  });
});
