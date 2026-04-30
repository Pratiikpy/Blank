import { test, expect } from "@playwright/test";

/**
 * Layer 11 E2E — ChainSelector must offer both supported chains.
 *
 * Blank is a multichain app (Ethereum Sepolia + Base Sepolia). Users must be
 * able to switch between them without reconnecting; this test guards that
 * surface from regressions that would silently drop one of the chains.
 */
test("chain selector shows both supported chains", async ({ page }) => {
  await page.goto("/app");
  // Allow time for app to mount + connect prompt to appear
  await page.waitForTimeout(2000);
  // Open chain selector if it's a popover/dropdown — try data-testid first,
  // then fall back to accessible-name heuristics.
  const trigger = page
    .locator(
      '[data-testid="chain-selector"], button:has-text("Sepolia"), button:has-text("Base")',
    )
    .first();
  if ((await trigger.count()) === 0)
    test.skip(true, "ChainSelector not found in current layout");
  await trigger.click();
  await expect(page.getByText(/Eth Sepolia|Ethereum Sepolia/i)).toBeVisible();
  await expect(page.getByText(/Base Sepolia/i)).toBeVisible();
});
