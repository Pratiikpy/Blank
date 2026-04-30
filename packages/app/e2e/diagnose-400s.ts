/**
 * Diagnostic: capture every HTTP 4xx/5xx response with the actual URL +
 * method + status text, so we can identify what's noisy in the smoke
 * tests' "Failed to load resource: 400 ()" pile.
 */
import { chromium, type Page } from "playwright";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = "http://localhost:3000";
const TEST_ACCOUNT = {
  privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20",
};
const PASSPHRASE = "audit-verify-pass";
const CHAIN_ID = 84532;

async function injectPasskey(page: Page) {
  await page.goto(BASE + "/");
  await page.evaluate((id) => localStorage.setItem("blank_active_chain_id", String(id)), CHAIN_ID);
  await page.goto(BASE + "/app");
  await page.waitForTimeout(2000);
  await page.evaluate(
    async ({ chainId, privKey, passphrase }) => {
      const pk = await import("/src/lib/passkey.ts");
      await pk.deletePasskey(chainId).catch(() => {});
      return pk._testImportPasskey(chainId, privKey, passphrase, "diag");
    },
    { chainId: CHAIN_ID, privKey: TEST_ACCOUNT.privKey, passphrase: PASSPHRASE },
  );
  await page.goto(BASE + "/app");
  await page.waitForTimeout(3000);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const failures: { url: string; status: number; method: string }[] = [];
  page.on("response", async (response) => {
    const status = response.status();
    if (status >= 400) {
      failures.push({
        url: response.url(),
        status,
        method: response.request().method(),
      });
    }
  });

  await injectPasskey(page);

  // Visit a few representative routes
  for (const route of ["/app", "/app/history", "/app/analytics", "/app/send", "/app/profile", "/app/settings"]) {
    failures.length = 0;
    await page.goto(BASE + route);
    await page.waitForTimeout(4000);
    console.log(`\n--- ${route} (4xx/5xx responses) ---`);
    if (failures.length === 0) {
      console.log("  none");
    } else {
      // Show the first few full URLs (with query) so we can see what's failing
      for (const f of failures.slice(0, 3)) {
        const url = decodeURIComponent(f.url);
        console.log(`  ${f.method} (${f.status})\n    ${url}`);
      }
      if (failures.length > 3) console.log(`  ...and ${failures.length - 3} more`);
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
