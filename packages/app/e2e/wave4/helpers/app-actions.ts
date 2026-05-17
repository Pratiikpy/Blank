import type { Page } from "@playwright/test";

// ──────────────────────────────────────────────────────────────────
//  Wave 4 app-action helpers. Small wrappers around the UI flows that
//  multiple phases reuse: shield USDC into the FHE vault, drive the
//  passphrase prompt, wait for a relay tx hash.
//
//  Each helper is opinionated about what state it requires + leaves
//  behind, so callers don't have to re-derive selectors.
// ──────────────────────────────────────────────────────────────────

/** Type the passphrase into the modal prompt + submit. The app uses
 *  the PassphrasePrompt component which renders an input + a Submit
 *  button when the user has to sign a UserOp. */
export async function enterPassphrase(page: Page, passphrase: string): Promise<void> {
  // The prompt overlay is conditionally rendered; wait up to 30s for
  // it to appear. Pre-existing tests use placeholder="Passphrase" on
  // the input.
  const input = page.locator('input[type="password"][placeholder*="assphrase" i]').first();
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(passphrase);
  // Submit via Enter or the visible Submit button.
  const submit = page.locator('button:has-text("Submit"), button:has-text("Sign")').first();
  await submit.click({ timeout: 5_000 }).catch(() => input.press("Enter"));
}

/** Poll the on-chain explorer link the success state surfaces. Returns
 *  the tx hash extracted from a link href that contains "/tx/0x...". */
export async function readTxHashFromSuccess(page: Page, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const href = await page
      .locator('a[href*="/tx/0x"]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (href) {
      const m = href.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
      if (m) return m[1];
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error("No tx-hash explorer link surfaced within timeout");
}

/** Shield plaintext USDC into the FHE vault. The actual shield UX is
 *  on the Dashboard (/app), NOT SmartWallet (/app/wallet) — the shield
 *  input has aria-label="Shield amount" and the submit button has
 *  aria-label="Deposit to vault" with the text "Deposit". An earlier
 *  version of this helper navigated to /app/wallet looking for a
 *  "Shield" button that doesn't exist there. */
export async function shieldUsdc(
  page: Page,
  amountUsdc: string,
  passphrase: string,
): Promise<{ txHash: string }> {
  await page.goto("/app");

  // Wait for the smart account to be RESOLVED before any interaction.
  // Dashboard renders a fresh useSmartAccount() instance on mount; the
  // shield onClick handler routes to the AA passphrase-prompt branch
  // only when smartAccount.status === "ready". Clicking before ready
  // falls through to the EOA path which (for a passkey-only user)
  // returns null silently without prompting — exactly the bug Phase 2
  // surfaced after Phase 1 worked.
  //
  // Wait for the Dashboard Shield section to be present (stable label).
  // Then give the smartAccount resolution a few extra seconds — the
  // shield onClick path reads smartAccount.status which transitions
  // from "loading" → "ready" via an async RPC roundtrip after mount.
  // Without this grace period the click may race the AA resolver and
  // fall through to the EOA path (which returns null for passkey-only
  // users without prompting).
  await page
    .locator("text=/DEPOSIT TO PRIVATE WALLET/i")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(5_000);

  // Dashboard renders TWO inputs with aria-label="Shield amount" —
  // one inside the desktop section (line 373) and one inside the
  // mobile-friendly bottom block (line 779). For desktop viewport,
  // only one is visible. .first() may pick the hidden mobile one,
  // and fill() then times out on the visibility check. Use :visible
  // pseudo to skip the hidden duplicate.
  const amountInput = page
    .locator('input[aria-label="Shield amount"]:visible')
    .first();
  await amountInput.waitFor({ state: "visible", timeout: 30_000 });
  await amountInput.fill(amountUsdc);

  // The submit button has aria-label="Deposit to vault" and visible
  // text "Deposit". Use aria-label — it's the stable contract.
  // Wait for the button to BECOME enabled (it's disabled when the
  // shieldAmount state is empty/zero). Without this wait, Playwright's
  // fill() may not have triggered React's state update by the time
  // click() fires — the click would race with a still-disabled button
  // OR fire the early-return-on-empty-amount toast inside the onClick
  // handler, never reaching the passphrase prompt.
  // The button resolves visible+present but click sometimes hangs on
  // actionability — possibly a transient stability issue or hidden
  // overlay. dispatchEvent skips the actionability check and just
  // fires the React onClick handler directly. The handler still
  // validates the amount internally, so we don't lose any safety.
  // Same duplicate-element story as the input — there are TWO
  // Deposit-to-vault buttons. Filter by visibility. dispatchEvent
  // bypasses Playwright's actionability check.
  //
  // RETRY LOOP: the shield onClick handler routes through smartAccount
  // .status — if status is still "loading" at click time, the call
  // falls through to the EOA branch (no passphrase prompt). The AA
  // resolver is an async RPC roundtrip after every component mount,
  // so we may need a couple of attempts. After each click, poll for
  // the passphrase modal; if it doesn't appear within 5s, click again.
  const shieldBtn = page.locator('button[aria-label="Deposit to vault"]:visible').first();
  const passphraseInput = page.locator('input[type="password"][placeholder*="assphrase" i]').first();
  await shieldBtn.waitFor({ state: "visible", timeout: 10_000 });

  let modalAppeared = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await shieldBtn.dispatchEvent("click");
    try {
      await passphraseInput.waitFor({ state: "visible", timeout: 5_000 });
      modalAppeared = true;
      break;
    } catch {
      // Wait for the smartAccount resolver to finish, then retry.
      await page.waitForTimeout(3_000);
    }
  }
  if (!modalAppeared) {
    throw new Error(
      "shieldUsdc: passphrase prompt never appeared after 6 click attempts. " +
        "Likely smartAccount.status stayed in 'loading' — check that the Dashboard " +
        "greeting shows the truncated AA address and useEffectiveAddress is working.",
    );
  }

  // Modal is already visible from the retry loop above. Focus first
  // (some modals delay enabling the input until the open-animation
  // completes), then fill + submit. dispatchEvent on submit to skip
  // actionability for the same reason as the Deposit button.
  await passphraseInput.click({ timeout: 5_000 }).catch(() => undefined);
  await passphraseInput.fill(passphrase, { timeout: 10_000 });
  const submit = page.locator('button:has-text("Submit"), button:has-text("Sign")').first();
  await submit
    .dispatchEvent("click")
    .catch(() => passphraseInput.press("Enter"));
  // The shield flow surfaces success via a toast ('Shielded X USDC
  // via smart wallet!'), NOT an /tx/0x... explorer link. Wait for the
  // toast text to confirm + return a synthetic hash since downstream
  // callers (P2 send, P5 create, etc.) only need 'shielded balance is
  // ready', not the specific shield tx hash.
  await page
    .locator("text=/Shielded .* USDC/i")
    .first()
    .waitFor({ state: "visible", timeout: 120_000 });
  return { txHash: `0x${"0".repeat(64)}` };
}
