/**
 * diagnose-white-screen — load the live site, capture every console
 * error, network failure, and CSP violation. Print a concise report.
 *
 * Usage:
 *   pnpm tsx e2e/diagnose-white-screen.ts [url]
 *
 * Defaults to https://blank-omega-jade.vercel.app/ — the production deploy.
 */
import { chromium } from "@playwright/test";

const URL = process.argv[2] ?? "https://blank-omega-jade.vercel.app/";

interface Finding {
  kind: "console" | "pageerror" | "request-failed" | "csp" | "response-bad";
  message: string;
  url?: string;
  status?: number;
}

async function diagnose() {
  const findings: Finding[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      findings.push({
        kind: "console",
        message: `[${type}] ${msg.text().slice(0, 500)}`,
      });
    }
  });

  page.on("pageerror", (err) => {
    // Print stack inline so we can grep the bundle for the offending
    // call site. err.stack already contains the message.
    console.log(`\n[pageerror RAW STACK]:\n${err.stack ?? `${err.name}: ${err.message}`}\n`);
    findings.push({
      kind: "pageerror",
      message: `${err.name}: ${err.message?.slice(0, 500)}`,
    });
  });

  page.on("requestfailed", (req) => {
    const failure = req.failure();
    findings.push({
      kind: "request-failed",
      url: req.url(),
      message: failure?.errorText ?? "unknown",
    });
  });

  page.on("response", (res) => {
    if (res.status() >= 400) {
      findings.push({
        kind: "response-bad",
        url: res.url(),
        status: res.status(),
        message: `HTTP ${res.status()}`,
      });
    }
  });

  console.log(`[diagnose] loading ${URL}...`);
  let loadErr: Error | null = null;
  try {
    await page.goto(URL, { waitUntil: "networkidle", timeout: 30_000 });
  } catch (e) {
    loadErr = e as Error;
    console.log(`[diagnose] navigation error: ${loadErr.message}`);
  }

  // Wait an extra beat for lazy-loaded chunks + deferred errors.
  await page.waitForTimeout(6_000);

  // Capture root visibility — empty body = white screen.
  const rootInfo = await page.evaluate(() => {
    const root = document.getElementById("root");
    return {
      rootExists: !!root,
      rootChildren: root?.children.length ?? 0,
      rootInnerHtmlLength: root?.innerHTML.length ?? 0,
      bodyText: document.body?.innerText?.slice(0, 200) ?? "",
      title: document.title,
    };
  });

  // Check headers Vercel served.
  const response = await page.evaluate(() => {
    return {
      url: window.location.href,
      ua: navigator.userAgent.slice(0, 80),
    };
  });

  const screenshotPath = `test-results/white-screen-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await context.close();
  await browser.close();

  // ── Report ─────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Diagnosis report");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  URL:                ${URL}`);
  console.log(`  Document title:     ${rootInfo.title}`);
  console.log(`  #root exists:       ${rootInfo.rootExists}`);
  console.log(`  #root children:     ${rootInfo.rootChildren}`);
  console.log(`  #root innerHTML:    ${rootInfo.rootInnerHtmlLength} chars`);
  console.log(`  Body visible text:  ${JSON.stringify(rootInfo.bodyText.slice(0, 80))}`);
  console.log(`  Screenshot:         ${screenshotPath}`);
  console.log();
  console.log(`  Findings: ${findings.length}`);

  // De-dupe identical findings.
  const seen = new Set<string>();
  for (const f of findings) {
    const key = `${f.kind}|${f.message}|${f.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = f.kind.padEnd(15);
    if (f.url) {
      console.log(`  [${tag}] ${f.message}`);
      console.log(`  ${"".padEnd(17)}${f.url}`);
    } else {
      console.log(`  [${tag}] ${f.message}`);
    }
  }

  if (findings.length === 0) {
    console.log("  (no findings — page loaded clean)");
  }

  console.log();
  if (rootInfo.rootChildren === 0 && rootInfo.rootInnerHtmlLength < 50) {
    console.log("  VERDICT: WHITE SCREEN CONFIRMED — root is empty");
  } else if (rootInfo.rootInnerHtmlLength > 100) {
    console.log("  VERDICT: page rendered something — check screenshot");
  }
  console.log();

  process.exit(findings.length > 0 ? 1 : 0);
}

diagnose().catch((err) => {
  console.error("[diagnose] crashed:", err);
  process.exit(2);
});
