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

  // Target the Shield input via its aria-label (stable across copy
  // changes). Fall back to placeholder if needed.
  const amountInput = page
    .locator('input[aria-label="Shield amount"]')
    .first();
  await amountInput.waitFor({ state: "visible", timeout: 30_000 });
  await amountInput.fill(amountUsdc);

  // The submit button has aria-label="Deposit to vault" and visible
  // text "Deposit". Use aria-label — it's the stable contract.
  const shieldBtn = page.locator('button[aria-label="Deposit to vault"]').first();
  await shieldBtn.click();

  await enterPassphrase(page, passphrase);
  const txHash = await readTxHashFromSuccess(page);
  return { txHash };
}
