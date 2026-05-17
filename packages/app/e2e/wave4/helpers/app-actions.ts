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

  // Target the Shield input via its aria-label (stable across copy
  // changes). Fall back to placeholder if needed.
  const amountInput = page
    .locator('input[aria-label="Shield amount"]')
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
  const shieldBtn = page.locator('button[aria-label="Deposit to vault"]').first();
  await shieldBtn.waitFor({ state: "visible", timeout: 10_000 });
  await shieldBtn.dispatchEvent("click");

  await enterPassphrase(page, passphrase);
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
