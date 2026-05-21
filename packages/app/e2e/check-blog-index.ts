import { chromium } from "@playwright/test";

async function run() {
  const url = process.argv[2] ?? "https://www.myblank.app/blog";
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(6000);
  const titleLocator = page.locator(".ll-step-title");
  const count = await titleLocator.count();
  const titles: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = await titleLocator.nth(i).textContent();
    titles.push((t ?? "").trim());
  }
  console.log(`Posts visible on ${url}:`);
  titles.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
