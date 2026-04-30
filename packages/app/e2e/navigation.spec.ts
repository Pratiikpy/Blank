import { test, expect } from "@playwright/test";

/**
 * Layer 11 E2E — route smoke tests.
 *
 * Visit each major public route and assert that React mounted (any h1/h2
 * is visible). Catches 404s, white-screens, and broken client-side routes
 * before they reach production.
 */
const ROUTES = [
  "/",
  "/features",
  "/manifesto",
  "/how-it-works",
  "/live",
  "/verify",
  "/for/individuals",
  "/for/creators",
  "/for/businesses",
  "/for/daos",
];

for (const route of ROUTES) {
  test(`route ${route} renders`, async ({ page }) => {
    await page.goto(route);
    // Expect any visible heading-level text — sanity that React mounted
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
  });
}
