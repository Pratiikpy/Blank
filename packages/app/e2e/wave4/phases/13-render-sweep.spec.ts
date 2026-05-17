import { test, expect, type Page } from "@playwright/test";
import { PERSONAS, injectPasskey, setActiveChain, type ChainKey } from "../fixtures/wallets";
import { snap, resetCounter } from "../helpers/screenshot";
import { recordProof } from "../helpers/testing-todo";

// ──────────────────────────────────────────────────────────────────
//  Phase 13 — read-only screen render sweep.
//
//  The "judge clicks every nav item" coverage. Phases 1-12 cover the
//  passkey-signed fund flows; this phase covers the 10 read-only
//  screens a judge will see when they explore the nav drawer.
//
//  Why batch instead of per-screen specs: every screen here has the
//  same shape — navigate, wait for h1, snap, record. Splitting into
//  10 files would be 9 × repetitive setup. One file with a parametric
//  iteration is the right scope.
//
//  Status legend in WAVE4_TESTING_TODO entries:
//    Synthetic 0x0...0 hash = read-only render check, no on-chain tx
//    by design. The gap audit accepts this for `requiresRealTx: false`
//    matrix entries.
//
//  Multi-party context: read-only screens render the SAME for any
//  persona once a passkey is loaded. We use Alice as the single test
//  persona to keep the batch fast (10 screens × 2 chains = 20 nav
//  ops, vs 60 for 3 personas).
// ──────────────────────────────────────────────────────────────────

const PHASE = "P13 Render Sweep";

interface ScreenTarget {
  /** URL path to navigate to. */
  route: string;
  /** Short tag for the recordProof phase + screenshot label. */
  tag: string;
  /** Short note for the WAVE4 line. */
  note: string;
  /** Optional setup before navigating (e.g. inject a dummy tx hash). */
  setup?: (page: Page) => Promise<void>;
}

const READ_ONLY_SCREENS: ScreenTarget[] = [
  { route: "/app", tag: "Dashboard", note: "Judge's first screen — totals, recent activity, quick-action cards." },
  { route: "/app/history", tag: "History", note: "Transaction history list — encrypted + decrypted toggle." },
  { route: "/app/explore", tag: "Explore", note: "Public deep-link explorer — discover claim links/auctions/campaigns." },
  { route: "/app/contacts", tag: "Contacts", note: "Address book — saved recipients with ENS resolution." },
  { route: "/app/privacy", tag: "Privacy", note: "Privacy settings — stealth toggle, decoy mixing config." },
  { route: "/app/analytics", tag: "Analytics", note: "Revenue + spend dashboard — encrypted P&L." },
  { route: "/app/profile", tag: "Profile", note: "ENS-driven profile — handle, avatar, public bio." },
  { route: "/app/settings", tag: "Settings", note: "App settings — currency, language, biometrics, advanced." },
  { route: "/app/help", tag: "Help", note: "Help center — FAQ, contact, security docs." },
  { route: "/app/receive", tag: "Receive", note: "Receive screen — QR code + address copy + pay-link generation. Caught in self-audit during fire 14 (originally missed from P13 list)." },
  {
    route: "/tx/0x0000000000000000000000000000000000000000000000000000000000000001",
    tag: "TransactionDetail",
    note: "TX detail page rendered against a non-existent hash → expects graceful 'tx not found' or loading state, not a crash.",
  },
];

function chainContextFromProject(): { chainId: number; chainName: string; viewport: string; chainKey: ChainKey } {
  const meta = test.info().project.metadata as
    | { chainId?: number; chainName?: string; viewport?: string }
    | undefined;
  if (!meta?.chainId || !meta.chainName) throw new Error("Project metadata missing");
  const chainKey: ChainKey = meta.chainId === 11155111 ? "ETH_SEPOLIA" : "BASE_SEPOLIA";
  return {
    chainId: meta.chainId,
    chainName: meta.chainName,
    viewport: meta.viewport ?? "desktop",
    chainKey,
  };
}

async function bringUp(
  browser: import("@playwright/test").Browser,
  chainId: number,
  baseURL: string,
): Promise<{ page: Page; context: import("@playwright/test").BrowserContext }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    baseURL,
  });
  const page = await context.newPage();
  await page.goto("/");
  await setActiveChain(page, chainId);
  await injectPasskey(page, PERSONAS.Alice, chainId);
  return { page, context };
}

test.describe("Phase 13 — read-only screen render sweep", () => {
  test.describe.configure({ mode: "serial" });

  test("all 10 read-only screens render with h1 visible (Alice, desktop)", async ({
    browser,
    baseURL,
  }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";
    const { page, context } = await bringUp(browser, chain.chainId, url);
    const shot = { phase: "13-render-sweep", persona: "alice", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);

    const failures: string[] = [];
    for (const screen of READ_ONLY_SCREENS) {
      try {
        if (screen.setup) await screen.setup(page);
        await page.goto(screen.route, { waitUntil: "domcontentloaded" });

        // Each read-only screen renders an <h1> heading. The wait
        // ensures the screen's data layer (useTotals, useActivity,
        // etc.) has resolved at least once + the loading skeleton
        // has been replaced with the real heading.
        const h1 = page.locator("h1").first();
        await h1.waitFor({ state: "visible", timeout: 30_000 });

        // Sanity: not a 404 or generic error page.
        const bodyText = (await page.textContent("body")) ?? "";
        const looksLikeError =
          /(Page not found|404|Something went wrong|Error)/.test(bodyText) &&
          !["TransactionDetail", "History", "Help"].includes(screen.tag); // those legitimately mention "error" in copy

        if (looksLikeError) {
          failures.push(`${screen.tag} at ${screen.route} surfaced an error page`);
          await snap(page, shot, `${screen.tag}-ERROR`);
          continue;
        }

        const screenshotPath = await snap(page, shot, screen.tag);

        recordProof({
          phase: `${PHASE} · ${screen.tag}`,
          chainName: chain.chainName,
          chainId: chain.chainId,
          txHash: `0x${"0".repeat(64)}`,
          screenshotPath,
          note: screen.note,
          viewport: chain.viewport,
        });
      } catch (e) {
        failures.push(`${screen.tag} at ${screen.route}: ${(e as Error).message}`);
        await snap(page, shot, `${screen.tag}-FAIL`).catch(() => undefined);
      }
    }

    await context.close();

    expect(
      failures,
      `Render sweep failures (${failures.length}/${READ_ONLY_SCREENS.length}): ` + failures.join(" | "),
    ).toHaveLength(0);
  });
});
