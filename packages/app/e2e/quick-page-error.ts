import { chromium } from "playwright";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = (process.argv[2] || "/app/inheritance").replace(/^.*?\/app\//, "/app/");

const ACCT = {
  privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20",
};

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() === 504) errors.push(`504: ${r.url()}`);
  });

  await page.goto("http://localhost:3000/");
  await page.evaluate(() => localStorage.setItem("blank_active_chain_id", "84532"));
  await page.goto("http://localhost:3000/app");
  await page.waitForTimeout(2000);
  await page.evaluate(
    async ({ chainId, privKey }) => {
      const pk = await import("/src/lib/passkey.ts");
      await pk.deletePasskey(chainId).catch(() => {});
      return pk._testImportPasskey(chainId, privKey, "x", "quick");
    },
    { chainId: 84532, privKey: ACCT.privKey },
  );
  // Vite needs a moment to optimize-deps for the lazy chunk on first hit.
  // Visit the route once, wait, then visit again so the optimizer has time
  // to bundle and cache the route's imports.
  await page.goto("http://localhost:3000" + ROUTE);
  await page.waitForTimeout(5000);
  await page.goto("http://localhost:3000" + ROUTE);
  await page.waitForTimeout(8000);

  console.log(`route ${ROUTE}: ${errors.length} errors`);
  for (const e of errors.slice(0, 6)) {
    console.log("  -", e.slice(0, 300));
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
