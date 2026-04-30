import { test, expect } from "@playwright/test";

/**
 * Layer 11 smoke test — minimal proof the landing page renders.
 *
 * Verifies:
 *   - page loads and the title is "Blank"
 *   - the GlobalCounter section (aria-label="Live encrypted volume")
 *     is present, regardless of whether decryption has populated a value
 */
test("landing page renders with title and GlobalCounter", async ({ page }) => {
  await page.goto("/");

  // Title is set in index.html to "Blank"
  await expect(page).toHaveTitle(/Blank/);

  // GlobalCounter section exists — when not connected it shows "Connect…"
  // hints, and the dash placeholder renders as "—". Either way the section
  // itself must mount, so we just assert visibility of the region.
  const counter = page.getByRole("region", { name: /Live encrypted volume/i });
  await expect(counter).toBeVisible();
});
