// One-shot Playwright screenshot pass against the live Vercel
// preview alias. Captures every public-facing route at 1280x800,
// writes to test-results/vercel-live-shots/. Used as proof that
// "what users hit" actually renders, separate from the headless
// passkey e2e suite.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = "https://blank-omega-jade.vercel.app";
const OUT = path.resolve(__dirname, "..", "test-results", "vercel-live-shots");

const ROUTES = [
  "/",
  "/app",
  "/app/send",
  "/app/wallet",
  "/app/business",
  "/app/sell",
  "/app/fundraise",
  "/app/claim-link",
  "/app/privacy",
  "/app/proofs",
  "/app/inheritance",
  "/app/gifts",
  "/app/agents",
  "/app/groups",
  "/app/creators",
  "/app/swap",
  "/app/p2p",
  "/app/burners",
  "/app/bridge",
  "/app/onboarding",
  "/app/history",
  "/app/contacts",
  "/app/explore",
  "/app/analytics",
  "/app/profile",
  "/app/settings",
  "/app/help",
  "/app/receive",
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    baseURL: BASE,
  });
  const page = await ctx.newPage();
  const consoleErrors = new Map();
  page.on("console", (m) => {
    if (m.type() === "error") {
      const k = m.text().slice(0, 120);
      consoleErrors.set(k, (consoleErrors.get(k) ?? 0) + 1);
    }
  });

  const results = [];
  for (const r of ROUTES) {
    const slug = r === "/" ? "root" : r.replace(/^\/+/, "").replace(/\//g, "-");
    const file = path.join(OUT, `${slug}.png`);
    try {
      const t0 = Date.now();
      const resp = await page.goto(r, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(800); // let SPA hydration settle
      await page.screenshot({ path: file, fullPage: false });
      const ms = Date.now() - t0;
      const status = resp?.status() ?? 0;
      results.push({ route: r, status, ms });
      process.stdout.write(`${status} ${ms}ms ${r}\n`);
    } catch (err) {
      results.push({ route: r, status: 0, ms: 0, err: String(err).slice(0, 80) });
      process.stdout.write(`ERR ${r} ${String(err).slice(0, 80)}\n`);
    }
  }

  fs.writeFileSync(
    path.join(OUT, "_report.json"),
    JSON.stringify(
      {
        base: BASE,
        timestamp: new Date().toISOString(),
        routes: results,
        consoleErrors: Object.fromEntries(consoleErrors),
      },
      null,
      2,
    ),
  );

  console.log("\nConsole errors:");
  if (consoleErrors.size === 0) {
    console.log("  (none)");
  } else {
    for (const [msg, n] of consoleErrors) console.log(`  [${n}] ${msg}`);
  }

  await browser.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
