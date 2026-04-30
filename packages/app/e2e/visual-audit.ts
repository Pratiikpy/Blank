import { chromium, type Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve(__dirname, "..", "test-results", "visual-audit");

const ROUTES = [
  "/app",
  "/app/send",
  "/app/history",
  "/app/receive",
  "/app/groups",
  "/app/creators",
  "/app/business",
  "/app/swap",
  "/app/stealth",
  "/app/gifts",
  "/app/inheritance",
  "/app/profile",
  "/app/settings",
  "/app/wallet",
  "/app/contacts",
  "/app/privacy",
  "/app/proofs",
  "/app/agents",
  "/app/explore",
  "/app/analytics",
  "/app/requests",
  "/app/help",
];

// Pre-funded passkey for Base Sepolia smart account 0x021a...3573f
const ACCT = {
  chainId: 84532,
  privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20",
  passphrase: "phase2-test-pass",
};

interface RouteResult {
  route: string;
  errors: string[];
  consoleErrors: string[];
  pageErrors: string[];
  http4xx5xx: string[];
  hasOverflow: boolean;
  screenshot: string;
}

function slug(route: string) {
  return route.replace(/^\//, "").replace(/\//g, "_") || "root";
}

async function auditRoute(page: Page, route: string): Promise<RouteResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const http: string[] = [];

  const onConsole = (m: import("playwright").ConsoleMessage) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  };
  const onPageError = (e: Error) => pageErrors.push(`${e.message}`.slice(0, 300));
  const onResponse = (r: import("playwright").Response) => {
    const s = r.status();
    if (s >= 400) http.push(`${s} ${r.url().slice(0, 200)}`);
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);

  try {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (e) {
    pageErrors.push(`goto failed: ${(e as Error).message}`);
  }

  // Give Vite + React time to lazy-load the route chunk and run effects.
  await page.waitForTimeout(4500);

  // Detect horizontal overflow at the document level.
  let hasOverflow = false;
  try {
    hasOverflow = await page.evaluate(() => {
      return (
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 2
      );
    });
  } catch {
    // ignore
  }

  const screenshotPath = path.join(OUT_DIR, `${slug(route)}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (e) {
    pageErrors.push(`screenshot failed: ${(e as Error).message}`);
  }

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  page.off("response", onResponse);

  return {
    route,
    errors: [],
    consoleErrors,
    pageErrors,
    http4xx5xx: http,
    hasOverflow,
    screenshot: screenshotPath,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Step 1: bootstrap passkey on the origin.
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate((cid) => {
    localStorage.setItem("blank_active_chain_id", String(cid));
  }, ACCT.chainId);

  // Land on /app first so Vite optimizes the entry chunk; then inject passkey.
  await page.goto(BASE + "/app", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  await page.evaluate(
    async ({ chainId, privKey, passphrase }) => {
      const pk = await import("/src/lib/passkey.ts");
      await pk.deletePasskey(chainId).catch(() => {});
      return pk._testImportPasskey(chainId, privKey, passphrase, "visual-audit");
    },
    { chainId: ACCT.chainId, privKey: ACCT.privKey, passphrase: ACCT.passphrase },
  );

  // Reload so useSmartAccount picks up the freshly-imported passkey.
  await page.goto(BASE + "/app", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  console.log(`[visual-audit] bootstrap done; auditing ${ROUTES.length} routes`);

  const results: RouteResult[] = [];
  for (const route of ROUTES) {
    process.stdout.write(`  ${route} ... `);
    const r = await auditRoute(page, route);
    results.push(r);
    const tag =
      r.pageErrors.length > 0
        ? "PAGEERR"
        : r.consoleErrors.length > 0
        ? "consoleerr"
        : "ok";
    console.log(
      `${tag} (console:${r.consoleErrors.length} page:${r.pageErrors.length} http:${r.http4xx5xx.length} overflow:${r.hasOverflow})`,
    );
  }

  const summary = results.map((r) => ({
    route: r.route,
    pageErrors: r.pageErrors.length,
    consoleErrors: r.consoleErrors.length,
    http4xx5xx: r.http4xx5xx.length,
    hasOverflow: r.hasOverflow,
    screenshot: path.relative(path.resolve(__dirname, ".."), r.screenshot),
    samplePageError: r.pageErrors[0] ?? null,
    sampleConsoleError: r.consoleErrors[0] ?? null,
    sampleHttp: r.http4xx5xx[0] ?? null,
  }));

  fs.writeFileSync(
    path.join(OUT_DIR, "summary.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log(`\n[visual-audit] summary written to ${path.join(OUT_DIR, "summary.json")}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
