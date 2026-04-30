import { test, expect } from "@playwright/test";

/**
 * Layer 11 E2E — /verify page must expose a proof-ID input.
 *
 * Anyone (even without a wallet) must be able to paste a payment/receipt ID
 * into the verify page and check it. If the input vanishes, third-party
 * verifiers break silently.
 */
test("verify page renders proof input", async ({ page }) => {
  await page.goto("/verify");
  // Expect any input where user can paste a proof ID
  const input = page.locator('input[type="text"], input[type="number"]').first();
  await expect(input).toBeVisible({ timeout: 10_000 });
});
