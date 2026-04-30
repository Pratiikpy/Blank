/**
 * One-off verification script for the 28 audit fixes.
 *
 * Walks each route impacted by the fixes, asserts the new behavior, and
 * captures a screenshot per check. Skips wallet-gated flows that need
 * funded accounts (those are covered by the phase* spec files).
 *
 * Run: npx tsx e2e/verify-audit-fixes.ts
 */
import { chromium, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = "http://localhost:3000";
const SNAP_DIR = path.resolve(__dirname, "..", "test-results", "audit-verify");
fs.mkdirSync(SNAP_DIR, { recursive: true });

interface CheckResult {
  id: string;
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}
const results: CheckResult[] = [];

async function snap(page: Page, name: string) {
  const file = path.join(SNAP_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

async function check(
  id: string,
  name: string,
  fn: () => Promise<{ ok: boolean; detail: string }>,
) {
  try {
    const r = await fn();
    results.push({ id, name, status: r.ok ? "PASS" : "FAIL", detail: r.detail });
    console.log(`${r.ok ? "✓" : "✗"} ${id} ${name} — ${r.detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ id, name, status: "FAIL", detail });
    console.log(`✗ ${id} ${name} — ${detail}`);
  }
}

// Pre-funded test passkey account A (same as e2e/driver.ts).
const TEST_ACCOUNT = {
  address: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f",
  privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20",
};
const PASSPHRASE = "audit-verify-pass";
const CHAIN_ID = 84532; // Base Sepolia

async function injectPasskey(page: Page) {
  await page.goto(BASE + "/");
  await page.evaluate((id) => {
    localStorage.setItem("blank_active_chain_id", String(id));
  }, CHAIN_ID);
  await page.goto(BASE + "/app");
  await page.waitForTimeout(2000);
  await page.evaluate(
    async ({ chainId, privKey, passphrase }) => {
      const pk = await import("/src/lib/passkey.ts");
      await pk.deletePasskey(chainId).catch(() => {});
      return pk._testImportPasskey(chainId, privKey, passphrase, "audit-verify");
    },
    { chainId: CHAIN_ID, privKey: TEST_ACCOUNT.privKey, passphrase: PASSPHRASE },
  );
  // Reload so the app picks up the newly-injected passkey state.
  await page.goto(BASE + "/app");
  await page.waitForTimeout(5000);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log("Injecting test passkey…");
  await injectPasskey(page);
  await snap(page, "00-after-passkey-inject");
  console.log("Passkey injected, app mounted.\n");

  // ───── #20 Root catch-all 404 ───────────────────────────────────────
  await check("#20", "Root 404 shows friendly NotFoundLanding", async () => {
    await page.goto(BASE + "/totally-bogus-route-xyz");
    await page.waitForTimeout(2000);
    await snap(page, "20-root-404");
    const text = await page.textContent("body").catch(() => "");
    const hasGoHome = (text || "").includes("Go home");
    const hasOpenApp = (text || "").includes("Open app");
    const has404 = (text || "").includes("404");
    return {
      ok: hasGoHome && hasOpenApp && has404,
      detail: `404=${has404} GoHome=${hasGoHome} OpenApp=${hasOpenApp}`,
    };
  });

  // ───── #19 ErrorBoundary wraps Routes (no white-screen on bogus app routes) ─────
  await check("#19", "ErrorBoundary in tree (app /typo doesn't crash)", async () => {
    await page.goto(BASE + "/app/totally-fake-app-route");
    await page.waitForTimeout(2000);
    await snap(page, "19-app-fake-route");
    // App-internal NotFoundPage handles unknown /app/* routes
    const text = await page.textContent("body").catch(() => "");
    const hasContent = (text || "").length > 50;
    return {
      ok: hasContent,
      detail: `bodyLen=${(text || "").length}`,
    };
  });

  // ───── Public landing renders ───────────────────────────────────────
  await check("public-/", "Landing renders", async () => {
    await page.goto(BASE + "/");
    await page.waitForTimeout(3000);
    await snap(page, "public-landing");
    const text = await page.textContent("body").catch(() => "");
    return { ok: (text || "").length > 100, detail: `len=${(text || "").length}` };
  });

  // ───── Public /pay/:identifier ──────────────────────────────────────
  await check("public-pay", "/pay/<id> renders", async () => {
    await page.goto(BASE + "/pay/0x1234567890123456789012345678901234567890");
    await page.waitForTimeout(3000);
    await snap(page, "public-pay");
    const text = await page.textContent("body").catch(() => "");
    return { ok: (text || "").length > 50, detail: `len=${(text || "").length}` };
  });

  // ───── #8 + #24 Analytics enum + UI honesty ─────────────────────────
  // We need a passkey account or wallet to actually mount the app. Without
  // one the route might redirect to onboarding. We assert page renders + no
  // "tap to reveal" copy AND footer mentions "Amounts encrypted via FHE".
  await check("#8/#24", "Analytics: no 'tap to reveal' copy", async () => {
    // Set chain id so app routes work
    await page.goto(BASE + "/");
    await page.evaluate(() => localStorage.setItem("blank_active_chain_id", "84532"));
    await page.goto(BASE + "/app/analytics");
    await page.waitForTimeout(4000);
    await snap(page, "8-analytics");
    const text = await page.textContent("body").catch(() => "");
    const hasFhecopy = (text || "").includes("Amounts encrypted via FHE");
    const hasOldCopy = (text || "").includes("tap to reveal");
    return {
      ok: hasFhecopy && !hasOldCopy,
      detail: `newCopy=${hasFhecopy} oldCopy(should=false)=${hasOldCopy}`,
    };
  });

  // ───── #9 Dashboard "This Month" + "All-time" labels ────────────────
  await check("#9", "Dashboard has 'This Month' + 'All-time' labels", async () => {
    await page.goto(BASE + "/app");
    await page.waitForTimeout(4000);
    await snap(page, "9-dashboard");
    const text = await page.textContent("body").catch(() => "");
    const hasThisMonth = (text || "").includes("This Month");
    const hasAllTime = (text || "").includes("All-time");
    return {
      ok: hasThisMonth && hasAllTime,
      detail: `ThisMonth=${hasThisMonth} AllTime=${hasAllTime}`,
    };
  });

  // ───── #21/#22 ConnectionHealthBanner self-hides when healthy ───────
  await check("#21/#22", "ConnectionHealthBanner not shown when healthy", async () => {
    await page.goto(BASE + "/app");
    await page.waitForTimeout(5000);
    await snap(page, "21-connection-health");
    const text = await page.textContent("body").catch(() => "");
    const hasBannerCopy =
      (text || "").includes("RPC connection unstable") ||
      (text || "").includes("Live updates paused") ||
      (text || "").includes("Connection issues");
    return {
      ok: !hasBannerCopy,
      detail: `bannerVisible(should=false)=${hasBannerCopy}`,
    };
  });

  // ───── App routes don't crash (just verify they render) ─────────────
  const APP_ROUTES = [
    "/app/send",
    "/app/receive",
    "/app/history",
    "/app/requests",
    "/app/stealth",
    "/app/groups",
    "/app/gifts",
    "/app/swap",
    "/app/bridge",
    "/app/burners",
    "/app/scheduled",
    "/app/agents",
    "/app/business",
    "/app/creators",
    "/app/inheritance",
    "/app/contacts",
    "/app/privacy",
    "/app/proofs",
    "/app/settings",
    "/app/wallet",
    "/app/profile",
    "/app/help",
    "/app/explore",
  ];

  for (const route of APP_ROUTES) {
    await check(`route ${route}`, `${route} renders without crash`, async () => {
      const consoleErrors: string[] = [];
      const handler = (msg: any) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      };
      page.on("console", handler);
      try {
        await page.goto(BASE + route);
        await page.waitForTimeout(2500);
        await snap(page, `route-${route.replace(/\//g, "-")}`);
        const text = await page.textContent("body").catch(() => "");
        const len = (text || "").length;
        // We tolerate console errors here (Supabase/RPC noise) — just want
        // to confirm the page itself rendered SOMETHING (>50 chars of body).
        const fatalErrors = consoleErrors.filter((e) =>
          /Cannot read|undefined is not|TypeError|ReferenceError/.test(e),
        );
        return {
          ok: len > 50 && fatalErrors.length === 0,
          detail: `len=${len} consoleErrs=${consoleErrors.length} fatal=${fatalErrors.length}${
            fatalErrors.length ? ` -> ${fatalErrors.slice(0, 1).join("; ")}` : ""
          }`,
        };
      } finally {
        page.off("console", handler);
      }
    });
  }

  await browser.close();

  // ───── Report ───────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("AUDIT FIX VERIFICATION RESULTS");
  console.log("═══════════════════════════════════════════════════════════════");
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`PASS: ${passed}   FAIL: ${failed}   TOTAL: ${results.length}`);
  console.log("\nFailures:");
  for (const r of results.filter((r) => r.status === "FAIL")) {
    console.log(`  ✗ ${r.id} — ${r.name}`);
    console.log(`      ${r.detail}`);
  }
  console.log(`\nScreenshots: ${SNAP_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
