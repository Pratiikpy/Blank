import { test, expect } from "@playwright/test";
import { PERSONAS, injectPasskey, setActiveChain, type ChainKey } from "../fixtures/wallets";

// ──────────────────────────────────────────────────────────────────
//  Phase 99 — diagnostic probe.
//
//  Purpose: figure out whether /app (Dashboard) is actually reachable
//  for a passkey-only user, or whether something redirects to
//  /app/wallet. Phase 2 fails consistently with the screenshot showing
//  the SmartWallet page, but no source-side navigate("/app/wallet") was
//  found. This probe lands on /app and polls the URL every 2s for 30s
//  while emitting console + URL + body-text snapshots.
// ──────────────────────────────────────────────────────────────────

function chainContext(): { chainId: number; chainKey: ChainKey } {
  const meta = test.info().project.metadata as { chainId?: number };
  const chainId = meta?.chainId ?? 11155111;
  return {
    chainId,
    chainKey: chainId === 11155111 ? "ETH_SEPOLIA" : "BASE_SEPOLIA",
  };
}

test("probe: /app stays on /app for passkey-only Alice", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const ctx = chainContext();
  const url = baseURL ?? "http://localhost:3000";

  // Capture console + page errors for the whole test, no truncation.
  const consoleMsgs: string[] = [];
  page.on("console", (m) => {
    const txt = m.text();
    if (
      txt.includes("Maximum update depth") ||
      txt.includes("infinite") ||
      txt.includes("Warning")
    ) {
      consoleMsgs.push(`[${m.type()}] ${txt}`);
    }
  });
  page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}\n${e.stack ?? ""}`));

  // Seed passkey under /
  await page.goto(url);
  await setActiveChain(page, ctx.chainId);
  await injectPasskey(page, PERSONAS.Alice, ctx.chainId);

  // Land on /app, then poll URL + state every 2s for 30s.
  await page.goto("/app");
  const samples: Array<{ t: number; url: string; h1: string }> = [];
  const t0 = Date.now();
  for (let i = 0; i < 15; i++) {
    const u = page.url();
    const h1 = (await page.locator("h1, h2").first().textContent().catch(() => "?"))?.trim() ?? "?";
    samples.push({ t: Date.now() - t0, url: u, h1: h1.slice(0, 80) });
    await page.waitForTimeout(2_000);
  }

  // Dump samples + console.
  console.log("─── URL/H1 samples over 30s ───");
  for (const s of samples) {
    console.log(`  t=${s.t}ms url=${s.url} h1=${JSON.stringify(s.h1)}`);
  }
  console.log("─── Console messages (first 5, full) ───");
  for (const m of consoleMsgs.slice(0, 5)) console.log(m);
  console.log(`─── Total error msgs: ${consoleMsgs.length} ───`);

  // Final URL should still be /app (or /app/), NOT /app/wallet.
  const finalUrl = samples[samples.length - 1]!.url;
  expect(finalUrl, `Final URL was ${finalUrl}; expected /app`).toMatch(/\/app\/?$/);
});
