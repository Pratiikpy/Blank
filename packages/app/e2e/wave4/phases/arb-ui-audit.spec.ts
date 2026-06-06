// Focused Arb UI audit: drive one funded passkey persona (Alice) through the
// app on Arbitrum Sepolia like a human, screenshotting each surface for a
// visual audit. No hard assertions — the screenshots are reviewed by eye.
import { test } from "@playwright/test";
import { spawnWallet, PERSONAS } from "../fixtures/wallets";
import * as fs from "fs";
import * as path from "path";

const MOBILE = !!process.env.AUDIT_MOBILE;
const OUT = path.resolve(process.cwd(), `test-results/arb-ui-audit${MOBILE ? "-mobile" : ""}`);
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

test(`Arb UI audit — Alice walkthrough (${MOBILE ? "mobile" : "desktop"})`, async ({ browser }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });
  const { context, page } = await spawnWallet(browser, {
    persona: PERSONAS.Alice,
    chainId: 421614,
    viewport: MOBILE ? { width: 375, height: 812 } : { width: 1280, height: 800 },
    baseURL: BASE,
  });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
    // eslint-disable-next-line no-console
    console.log("shot:", name);
  };

  await page.goto("/app");
  await page.waitForTimeout(6000);
  await shot("01-dashboard");

  // Walk every nav item by visible label, like a user clicking the sidebar.
  const navLabels = [
    "Dashboard", "Send", "History", "Business", "Group", "Creator",
    "P2P", "Stealth", "Inheritance", "Proofs", "Gift",
  ];
  for (let i = 0; i < navLabels.length; i++) {
    const label = navLabels[i];
    const link = page.locator(`a, button`).filter({ hasText: new RegExp(label, "i") }).first();
    if (await link.count().catch(() => 0)) {
      await link.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3500);
      await shot(`${String(i + 2).padStart(2, "0")}-${label.toLowerCase()}`);
    } else {
      console.log("nav not found:", label);
    }
  }
  await context.close();
});
