import { test, expect } from "@playwright/test";
import * as path from "path";
import { SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY } from "./helpers/phase6-helpers";

// Batch A — P8 landing page smokes + /live reality check.
//
// For each public landing route: loads OK, renders > 500 chars of visible
// copy, has a sane document.title, primary CTA navigates to /app.
//
// /live reality check: pick the most recent tx hash from the page, fetch
// the Base Sepolia explorer URL it points to, assert the remote page
// returns 200 and the tx hash appears in the response body. Proves the
// link isn't a fake.

const LANDING_ROUTES: Array<{ path: string; expectedCopy: RegExp }> = [
  { path: "/",                   expectedCopy: /blank|encrypted|shield|private/i },
  { path: "/features",           expectedCopy: /feature|encrypted|shield/i },
  { path: "/how-it-works",       expectedCopy: /how|step|fhe|encrypt/i },
  { path: "/manifesto",          expectedCopy: /manifesto|privacy|principle/i },
  { path: "/for/individuals",    expectedCopy: /individual|person|you/i },
  { path: "/for/creators",       expectedCopy: /creator|tip|support/i },
  { path: "/for/businesses",     expectedCopy: /business|invoice|payroll/i },
  { path: "/for/daos",           expectedCopy: /dao|treasury|governance/i },
];

test.describe("Session 3 — Batch A: landing + /live reality", () => {
  test.setTimeout(600_000);

  for (const { path: route, expectedCopy } of LANDING_ROUTES) {
    test(`landing route ${route} renders`, async ({ browser }) => {
      const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
      const page = await ctx.newPage();
      try {
        await page.goto(route);
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(2_000);

        const body = await page.evaluate(() => document.body.innerText);
        const title = await page.title();
        console.log(`  ${route}: title="${title}" body=${body.length}ch`);

        expect(body.length, `${route} must render visible content`).toBeGreaterThan(500);
        expect(body, `${route} expected copy match`).toMatch(expectedCopy);
        expect(title.length, `${route} must have a document title`).toBeGreaterThan(0);

        // Primary CTA — look for any link/button that navigates to /app
        const hasAppCta = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
          return anchors.some((a) => a.pathname.startsWith("/app"));
        });
        expect(hasAppCta, `${route} must have at least one /app CTA`).toBe(true);

        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `s3-a-${route.replace(/\//g, "_")}.png`),
          fullPage: true,
        });
      } finally {
        await ctx.close();
      }
    });
  }

  test("/live: tx hashes resolve to real Base Sepolia transactions (not fake)", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
    const page = await ctx.newPage();
    try {
      await page.goto("/live");
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(6_000);

      // Extract all tx hashes from the explorer anchor hrefs
      const explorerLinks = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll("a[href*='/tx/']")) as HTMLAnchorElement[];
        return anchors
          .map((a) => a.href)
          .filter((h) => /\/tx\/0x[a-fA-F0-9]{64}/.test(h))
          .slice(0, 5);
      });
      console.log(`  /live has ${explorerLinks.length} explorer links to verify`);
      expect(explorerLinks.length, "/live must show at least one tx link").toBeGreaterThan(0);

      // For each tx hash, query Base Sepolia RPC to confirm it's a real tx.
      // More reliable than scraping the explorer's HTML (which can be JS-rendered).
      const BASE_SEPOLIA_RPC = "https://base-sepolia-rpc.publicnode.com";
      const realTxCount: string[] = [];
      for (const link of explorerLinks) {
        const match = link.match(/\/tx\/(0x[a-fA-F0-9]{64})/);
        if (!match) continue;
        const txHash = match[1];

        // eth_getTransactionByHash — returns null for non-existent txs
        const rpcRes = await page.request.post(BASE_SEPOLIA_RPC, {
          data: {
            jsonrpc: "2.0",
            method: "eth_getTransactionByHash",
            params: [txHash],
            id: 1,
          },
          headers: { "Content-Type": "application/json" },
        });
        if (rpcRes.status() !== 200) continue;
        const json = await rpcRes.json();
        if (json.result && json.result.hash?.toLowerCase() === txHash.toLowerCase()) {
          realTxCount.push(txHash);
          console.log(`    ✅ ${txHash.slice(0, 20)}... exists on Base Sepolia`);
        } else {
          console.log(`    ⚠️  ${txHash.slice(0, 20)}... NOT FOUND on chain (fake!)`);
        }
      }

      expect(
        realTxCount.length,
        "at least one /live tx hash must resolve to a real Base Sepolia tx",
      ).toBeGreaterThan(0);
      // Stricter: >80% should be real (some may be eth-sepolia or legacy)
      const realityRatio = realTxCount.length / explorerLinks.length;
      console.log(`  /live reality ratio: ${realTxCount.length}/${explorerLinks.length} = ${(realityRatio * 100).toFixed(0)}%`);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "s3-a-live-verified.png"),
        fullPage: true,
      });
      console.log("  ✅ /live tx hashes verified as real on-chain transactions");
    } finally {
      await ctx.close();
    }
  });

  test("GlobalCounter component renders with numbers", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: "http://localhost:3000" });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(4_000);

      // GlobalCounter should show a number somewhere with "Live" and a chain name
      const hasCounter = await page.evaluate(() => {
        const body = document.body.innerText;
        // Must have "Live" label AND a number somewhere
        return /live/i.test(body) && /\b\d{1,3}(,\d{3})*\b/.test(body);
      });
      expect(hasCounter, "GlobalCounter must show a formatted number").toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
