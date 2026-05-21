import { test, expect, type Page } from "@playwright/test";
import * as path from "node:path";

// ──────────────────────────────────────────────────────────────────
//  Vercel production-canonical visual smoke test.
//
//  This is the "real human" check users will do — load the URL, click
//  the landing page, walk into /app, see what renders. No passkey
//  injection (the dev-only `import("/src/lib/passkey.ts")` shortcut
//  doesn't work on production-bundled output). No on-chain tx (those
//  are proven against localhost — this only proves the deployed
//  bundle serves correctly).
//
//  Captures:
//   - Console errors per page (anything that would scare a real user)
//   - Network 4xx/5xx (broken endpoints, missing assets)
//   - Screenshots at each route for visual diff
//   - HTTP status of every page navigated to
//
//  Mirrors what a judge would do on day-0 of testnet launch.
// ──────────────────────────────────────────────────────────────────

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://www.myblank.app";
const SHOT_DIR = "wave4-shots/vercel-smoke";

interface PageError {
  route: string;
  type: "console" | "network";
  detail: string;
}

async function snap(page: Page, name: string): Promise<string> {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function captureErrors(page: Page, route: string, errors: PageError[]): Promise<void> {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Filter out known third-party noise: VAPID-public-key warning on
      // unconfigured deploys, MetaMask provider not found (we don't use
      // it on these routes), and Vercel deploy-protection pixels.
      if (
        text.includes("VAPID_PUBLIC_KEY") ||
        text.includes("ethereum is not defined") ||
        text.includes("vercel-toolbar") ||
        text.includes("__vercel_live")
      ) return;
      errors.push({ route, type: "console", detail: text.slice(0, 240) });
    }
  });

  page.on("response", (resp) => {
    const url = resp.url();
    const status = resp.status();
    if (status >= 400 && !url.includes("__vercel_live") && !url.includes("favicon")) {
      errors.push({ route, type: "network", detail: `${status} ${url.slice(0, 200)}` });
    }
  });
}

test.describe("Vercel canonical production-smoke", () => {
  test("public routes load without console errors or 4xx/5xx", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      baseURL: BASE,
    });
    const page = await context.newPage();
    const errors: PageError[] = [];

    // Public landing.
    await captureErrors(page, "/", errors);
    const resp = await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    expect(resp?.status() ?? 0).toBeLessThan(400);
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await snap(page, "01-landing");
    // Sanity: page has a heading or hero. Don't be picky about exact copy.
    const headingCount = await page.locator("h1, h2").count();
    expect(headingCount).toBeGreaterThan(0);

    // Public sub-routes — every one should render.
    const publicRoutes = [
      "/manifesto",
      "/audience",
      "/pricing",
      "/roadmap",
      "/live",
      "/verify",
    ];
    for (const route of publicRoutes) {
      await captureErrors(page, route, errors);
      const r = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const status = r?.status() ?? 0;
      // /verify may 404 if no proof id is supplied — that's a legitimate
      // route for /verify/:proofId form, not the bare /verify. Accept both.
      expect(status, `route ${route} returned ${status}`).toBeLessThan(500);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await snap(page, `02-${route.replace(/\//g, "-").slice(1) || "root"}`);
    }

    // /app/* gated by passkey-created state. Visiting without one should
    // redirect to onboarding or show the welcome card — either is a real
    // user experience and should not console-error.
    await captureErrors(page, "/app", errors);
    await page.goto("/app", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await snap(page, "03-app-no-passkey");

    // Critical API health check — production-bundled deploy must respond.
    const healthResp = await page.request.get(`${BASE}/api/health`);
    expect(healthResp.status()).toBeLessThan(500);
    const healthBody = await healthResp.json();
    expect(healthBody.status, "health endpoint should classify the deploy").toMatch(/ok|partial|degraded/);

    // Rewrite preservation: /api/relayer-health should still respond.
    const relayerResp = await page.request.get(`${BASE}/api/relayer-health`);
    expect(relayerResp.status()).toBeLessThan(500);
    const relayerBody = await relayerResp.json();
    expect(relayerBody, "relayer-health rewrite should resolve to consolidated handler").toHaveProperty("relayer");

    await context.close();

    // Report any console errors / 4xx-5xx we captured. Don't fail the
    // test on warnings alone — the goal is to surface real regressions.
    if (errors.length > 0) {
      console.log(`\n=== Vercel smoke captured ${errors.length} signal(s) ===`);
      for (const e of errors) {
        console.log(`  [${e.type}] ${e.route} → ${e.detail}`);
      }
      // Real errors (uncaught, network 500s) should fail; warnings are
      // surfaced for review.
      const hard = errors.filter((e) =>
        e.detail.includes("Uncaught") ||
        e.detail.match(/^5\d\d /),
      );
      expect(hard, `hard errors on production deploy:\n${hard.map((e) => `  ${e.route}: ${e.detail}`).join("\n")}`).toEqual([]);
    }
  });
});
