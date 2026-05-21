import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const url = "https://www.myblank.app/blog";
  console.log("Loading", url);
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  const articles = await page.locator("article, a[href^='/blog/']").count();
  console.log("Article-like elements:", articles);

  const text = (await page.textContent("body")) || "";
  const hasFhenixPost = text.includes("Fhenix CoFHE") && text.includes("co-processor");
  const hasZkPost = text.includes("Choosing FHE over zero-knowledge");
  const hasWave3 = text.includes("Wave 3");
  const hasNoToken = text.includes("Why no token");

  console.log({ hasFhenixPost, hasZkPost, hasWave3, hasNoToken });

  // Try opening the post
  const postUrl = "https://www.myblank.app/blog/why-fhenix-cofhe";
  console.log("\nLoading", postUrl);
  await page.goto(postUrl, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);
  const postText = (await page.textContent("body")) || "";
  const hasIntro = postText.includes("most consequential");
  const hasFourTier = postText.includes("four-tier ACL");
  const hasTransferVerified = postText.includes("transferVerified");
  console.log({ hasIntro, hasFourTier, hasTransferVerified });
  console.log("Length:", postText.length);

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
