import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");

// Phase 1.5 — every feature page must render without 404 or uncaught JS
// errors when a passkey user is signed in. One test per route so failures
// pinpoint the broken page. Screenshots saved for visual review.
//
// What's checked per page:
//   1. No "404" or "Page not found" text visible
//   2. No uncaught page errors (JS errors count as failure)
//   3. Page has a heading or main landmark
//   4. Console errors filtered of known noise (COOP, RPC network blips)

const IGNORE_PATTERNS = [
  /Cross-Origin-Opener-Policy/i,
  /Coinbase Wallet SDK requires/i,
  /Error checking Cross-Origin-Opener-Policy/i,
  /ERR_CONNECTION_CLOSED/i,
  /Failed to load resource.*(api\/|Supabase|health|svg|png)/i,
  /SDK failed to load, using fallback/i,
  /SDK connect failed/i,
  /ResizeObserver loop/i,
  /\[Supabase\]/i,
  /threshold.*network/i,
  /net::ERR_/i,
  // Nested cofhe warning when SDK isn't fully loaded yet
  /Auto-create permit failed/i,
  // Public RPC rate-limits (429) and forbidden (403) — viem's fallback
  // transport rotates through providers so individual rate-limits don't
  // affect functionality. Pre-existing environment noise, not regressions.
  /Failed to load resource.*status of 429/i,
  /Failed to load resource.*status of 403/i,
];

async function setupPasskey(page: Page) {
  await page.goto("/app");
  await page.evaluate(async () => {
    const passkey = await import("/src/lib/passkey.ts");
    if (!(await passkey.hasPasskey(11155111))) {
      await passkey.createPasskey(11155111, "smoke-test-pass", "phase1.5");
    }
  });
}

async function cleanupPasskey(page: Page) {
  await page.evaluate(async () => {
    const passkey = await import("/src/lib/passkey.ts");
    await passkey.deletePasskey(11155111).catch(() => {});
    await passkey.deletePasskey(84532).catch(() => {});
  });
}

function captureConsoleErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    errors.push(`[uncaught] ${err.message}`);
  });
  return () => errors;
}

function filterIgnorable(errors: string[]): string[] {
  return errors.filter((e) => !IGNORE_PATTERNS.some((p) => p.test(e)));
}

// Every route we ship, sanity-check individually.
// Order matches the sidebar — "core" first, then peripheral screens.
const ROUTES: Array<{ path: string; label: string; screenshot: string }> = [
  { path: "/app/history", label: "History", screenshot: "history" },
  { path: "/app/receive", label: "Receive", screenshot: "receive" },
  { path: "/app/groups", label: "Groups", screenshot: "groups" },
  { path: "/app/creators", label: "Creator Support", screenshot: "creators" },
  { path: "/app/business", label: "Business Tools", screenshot: "business" },
  { path: "/app/swap", label: "Exchange (P2P / DEX / Bridge)", screenshot: "swap" },
  { path: "/app/stealth", label: "Stealth Payments", screenshot: "stealth" },
  { path: "/app/gifts", label: "Gift Envelopes", screenshot: "gifts" },
  { path: "/app/inheritance", label: "Inheritance", screenshot: "inheritance" },
  { path: "/app/profile", label: "Profile", screenshot: "profile" },
  { path: "/app/settings", label: "Settings", screenshot: "settings" },
  { path: "/app/wallet", label: "Smart Wallet", screenshot: "wallet" },
  { path: "/app/contacts", label: "Contacts", screenshot: "contacts" },
  { path: "/app/privacy", label: "Privacy", screenshot: "privacy" },
  { path: "/app/proofs", label: "Proofs", screenshot: "proofs" },
  { path: "/app/agents", label: "Agent Payments", screenshot: "agents" },
  { path: "/app/explore", label: "Explore", screenshot: "explore" },
  { path: "/app/analytics", label: "Analytics", screenshot: "analytics" },
  { path: "/app/requests", label: "Requests", screenshot: "requests" },
  { path: "/app/help", label: "Help", screenshot: "help" },
];

test.describe("Phase 1.5 — every feature page renders", () => {
  test.setTimeout(60_000);

  // Setup once per test — ensures passkey exists. Cheap because
  // IndexedDB creation is sub-second.
  test.beforeEach(async ({ page }) => {
    await setupPasskey(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupPasskey(page);
  });

  for (const route of ROUTES) {
    test(`${route.path} — ${route.label} renders`, async ({ page }) => {
      const getErrors = captureConsoleErrors(page);

      await page.goto(route.path);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `p1-5-${route.screenshot}.png`),
        fullPage: true,
      });

      // No 404 markers visible
      const notFoundMarker = page.getByText("Page not found", { exact: false });
      await expect(notFoundMarker).not.toBeVisible({ timeout: 3000 });

      // Page has SOME structural content — either a heading or
      // sidebar nav (proves BlankApp shell rendered).
      const hasHeading = await page.getByRole("heading").first().isVisible().catch(() => false);
      const hasMain = await page.locator("main, [role=main]").first().isVisible().catch(() => false);
      const hasSidebarDashboard = await page.getByRole("link", { name: /dashboard/i }).first().isVisible().catch(() => false);
      expect(
        hasHeading || hasMain || hasSidebarDashboard,
        `${route.label}: no heading / main landmark / sidebar nav rendered`,
      ).toBe(true);

      // No uncaught JS errors
      const errors = filterIgnorable(getErrors());
      expect(errors, `${route.label}: unexpected console/page errors: ${errors.join(" | ")}`).toEqual([]);
    });
  }
});
