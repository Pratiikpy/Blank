import { chromium } from "playwright";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.resolve(__dirname, "..", "..", "..", "docs", "screenshots");

// Capture real app screenshots for README — no mocks, real UI state.
// Uses the passkey test account so dashboard has real data.

const PASSPHRASE = "test-passphrase-123";
const SETUP = {
  chainId: 84532,
  address: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f",
  passkey: {
    pubX: "0xcb95c03c21bd16e22f34d0a253c35a5bd53ad5a9fc0e4ef9f3dd61ced364573a",
    pubY: "0xe969d62fbbffa077bcc2ec6ea520bac95d62388d8edcf40f795c20e607e62dc4",
    privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20",
  },
  seed: "phase2-test-passkey-seed-1",
};

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // retina quality
  });
  const page = await context.newPage();

  // ── Landing page ──────────────────────────────────
  console.log("capturing landing...");
  await page.goto("http://localhost:3000/");
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: path.join(OUT, "landing.png"), fullPage: false });
  console.log("  saved landing.png");

  // ── Setup passkey account for authenticated pages ──
  console.log("setting up passkey account...");
  await page.goto("http://localhost:3000/app");
  await page.evaluate((id) => {
    localStorage.setItem("blank_active_chain_id", String(id));
  }, SETUP.chainId);
  await page.goto("http://localhost:3000/app");
  await page.evaluate(
    async ({ chainId, privKey, passphrase, label }) => {
      const passkey = await import("/src/lib/passkey.ts");
      await passkey.deletePasskey(chainId).catch(() => {});
      return passkey._testImportPasskey(chainId, privKey, passphrase, label);
    },
    { chainId: SETUP.chainId, privKey: SETUP.passkey.privKey, passphrase: PASSPHRASE, label: "readme-capture" },
  );
  await page.goto("http://localhost:3000/app");
  await page.waitForTimeout(8_000);

  // ── Dashboard ─────────────────────────────────────
  console.log("capturing dashboard...");
  await page.screenshot({ path: path.join(OUT, "dashboard.png"), fullPage: false });
  console.log("  saved dashboard.png");

  // ── Send ──────────────────────────────────────────
  console.log("capturing send...");
  await page.goto("http://localhost:3000/app/send");
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: path.join(OUT, "send.png"), fullPage: false });
  console.log("  saved send.png");

  // ── Business Tools ────────────────────────────────
  console.log("capturing business...");
  await page.goto("http://localhost:3000/app/business");
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: path.join(OUT, "business.png"), fullPage: false });
  console.log("  saved business.png");

  // ── Stealth Payments ──────────────────────────────
  console.log("capturing stealth...");
  await page.goto("http://localhost:3000/app/stealth");
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: path.join(OUT, "stealth.png"), fullPage: false });
  console.log("  saved stealth.png");

  // ── Receive ───────────────────────────────────────
  console.log("capturing receive...");
  await page.goto("http://localhost:3000/app/receive");
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: path.join(OUT, "receive.png"), fullPage: false });
  console.log("  saved receive.png");

  // ── Groups ────────────────────────────────────────
  console.log("capturing groups...");
  await page.goto("http://localhost:3000/app/groups");
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: path.join(OUT, "groups.png"), fullPage: false });
  console.log("  saved groups.png");

  // ── Privacy / Proofs ──────────────────────────────
  console.log("capturing proofs...");
  await page.goto("http://localhost:3000/app/proofs");
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: path.join(OUT, "proofs.png"), fullPage: false });
  console.log("  saved proofs.png");

  await browser.close();
  console.log("\nDone — all screenshots in docs/screenshots/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
