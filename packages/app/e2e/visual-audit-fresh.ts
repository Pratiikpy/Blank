import { chromium, type Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const OUT = path.resolve(__dirname, "..", "test-results", "visual-audit");

const ACCT = {
  privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20",
};

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
  "/app/burners",
  "/app/scheduled",
  "/app/invoice/84532/22",
];

function safeName(route: string): string {
  return route.replace(/^\//, "").replace(/[\/:]/g, "_") || "root";
}

async function shoot(page: Page, route: string): Promise<{ route: string; errors: string[]; bytes: number }> {
  const errors: string[] = [];
  const onPageError = (e: Error) => errors.push(`pageerror: ${e.message.slice(0, 200)}`);
  const onConsole = (m: any) => {
    if (m.type() === "error") errors.push(`console.error: ${String(m.text()).slice(0, 200)}`);
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);

  try {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Give Vite optimize-deps + lazy chunks + first paints time to resolve.
    await page.waitForTimeout(4500);
  } catch (e: any) {
    errors.push(`goto failed: ${String(e.message || e).slice(0, 200)}`);
  }

  const filePath = path.join(OUT, safeName(route) + ".png");
  let bytes = 0;
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    bytes = fs.statSync(filePath).size;
  } catch (e: any) {
    errors.push(`screenshot failed: ${String(e.message || e).slice(0, 200)}`);
  }

  page.off("pageerror", onPageError);
  page.off("console", onConsole);
  return { route, errors, bytes };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Bootstrap: set chain, import passkey
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("blank_active_chain_id", "84532"));
  await page.goto(BASE + "/app", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  try {
    await page.evaluate(
      async ({ chainId, privKey }) => {
        const pk = await import("/src/lib/passkey.ts");
        await (pk as any).deletePasskey(chainId).catch(() => {});
        return (pk as any)._testImportPasskey(chainId, privKey, "x", "audit");
      },
      { chainId: 84532, privKey: ACCT.privKey },
    );
  } catch (e: any) {
    console.error("passkey import failed:", e.message);
  }
  // Re-warm /app once the passkey is in place.
  await page.goto(BASE + "/app", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const results: { route: string; errors: string[]; bytes: number }[] = [];
  for (const r of ROUTES) {
    process.stdout.write(`shooting ${r} ... `);
    const res = await shoot(page, r);
    results.push(res);
    console.log(`${res.bytes ? Math.round(res.bytes / 1024) + "KB" : "FAIL"}  errs=${res.errors.length}`);
    for (const e of res.errors.slice(0, 2)) console.log("    -", e);
  }

  // Summary JSON for downstream review.
  fs.writeFileSync(
    path.join(OUT, "_summary.json"),
    JSON.stringify({ base: BASE, when: new Date().toISOString(), results }, null, 2),
  );

  await browser.close();
  console.log("\nDone. Screenshots in:", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
