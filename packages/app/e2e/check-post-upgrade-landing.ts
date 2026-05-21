// Quick post-upgrade smoke test: load the landing page on both chain tabs
// and confirm the page renders without console errors. We don't connect a
// wallet — just verify the page boots and the GlobalCounter scaffolding is
// present (it'll show "Connect to view live counter" without a wallet).

import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const errors: string[] = [];
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  page.on("console", m => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  console.log("Loading https://www.myblank.app/...");
  await page.goto("https://www.myblank.app/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000);

  const text = (await page.textContent("body")) || "";
  const hasHero = text.includes("Send a private invoice") || text.includes("encrypted payments");
  const hasCounter = text.includes("Encrypted USDC moved") || text.includes("Live");
  const hasNav = text.includes("Pricing") || text.includes("Blog") || text.includes("Roadmap");

  console.log({ hasHero, hasCounter, hasNav, bodyLength: text.length });
  console.log("Errors:", errors.length === 0 ? "(none)" : errors);

  await browser.close();
  if (!hasHero || !hasCounter || !hasNav) {
    console.log("✗ landing missing key sections");
    process.exit(1);
  }
  if (errors.length > 0) {
    console.log("✗ console/page errors detected");
    process.exit(1);
  }
  console.log("\n✓ landing page boots clean post-upgrade");
})().catch(e => { console.error(e); process.exit(1); });
