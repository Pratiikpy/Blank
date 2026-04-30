import dappwright, { MetaMaskWallet, type Dappwright } from "@tenkeylabs/dappwright";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// EOA / MetaMask E2E — REAL MetaMask extension, no mocks.
//
// Uses dappwright to bootstrap a Chromium instance with MetaMask installed.
// Validates the wagmi injected-connector code path that our passkey tests
// never exercise. The key fix vs the prior version: we manually find the
// MetaMask notification page in context.pages() because dappwright's
// wallet.approve() hangs waiting for a 'page' event that MetaMask v11+
// no longer emits (it uses notification.html instead of a new tab).

const TEST_SEED = process.env.TEST_METAMASK_SEED ??
  "test test test test test test test test test test test junk";
const TEST_PASSWORD = "Tester@1234";
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");

// Manual approval: find MetaMask's notification/popup page and click approve.
// dappwright's wallet.approve() internally calls context.waitForEvent('page')
// which hangs forever with MetaMask v11+ because it reuses the notification
// window instead of opening a new tab.
async function manualApprove(context: BrowserContext, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      const url = p.url();
      // Only look at MetaMask extension pages (notification, popup, or home)
      if (!url.includes("chrome-extension://")) continue;

      // Wait for page to load before trying to click
      try { await p.waitForLoadState("domcontentloaded", { timeout: 3_000 }); } catch { continue; }

      // Debug: log what's on the MetaMask page
      const debug = await p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        return {
          url: location.href,
          buttonCount: btns.length,
          buttonTexts: btns.slice(0, 10).map(b => (b.textContent || "").trim().slice(0, 40)),
          testIds: btns.map(b => b.getAttribute("data-testid")).filter(Boolean).slice(0, 10),
        };
      }).catch(() => null);
      if (debug) {
        console.log(`  [MM] page ${url.slice(0, 60)} — ${debug.buttonCount} buttons: ${JSON.stringify(debug.buttonTexts)}`);
        if (debug.testIds.length) console.log(`  [MM] testIds: ${JSON.stringify(debug.testIds)}`);
      }

      // Try to click approve/confirm
      const clicked = await p.evaluate(() => {
        const selectors = [
          '[data-testid="page-container-footer-next"]',
          '[data-testid="confirmation-submit-button"]',
          '[data-testid="confirm-btn"]',
          '[data-testid="allow-authorize-button"]',
          '[data-testid="confirm-footer-button"]',
          'button.btn-primary',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel) as HTMLButtonElement | null;
          if (btn && !btn.disabled) { btn.click(); return sel; }
        }
        const allBtns = Array.from(document.querySelectorAll("button"));
        const confirm = allBtns.find(b => {
          const t = (b.textContent || "").trim().toLowerCase();
          return /^(confirm|connect|approve|next|got it)$/.test(t);
        });
        if (confirm && !(confirm as HTMLButtonElement).disabled) {
          (confirm as HTMLButtonElement).click();
          return "text-match";
        }
        return null;
      }).catch(() => null);

      if (clicked) {
        console.log(`  [MM] approved via ${clicked} on ${url.slice(0, 60)}`);
        return true;
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

// Inline fixture: bootstrap MetaMask once per test worker, reuse context.
export const test = base.extend<{
  context: BrowserContext;
  wallet: Dappwright;
}>({
  context: async ({}, use) => {
    const [, , context] = await dappwright.bootstrap("", {
      wallet: "metamask",
      version: MetaMaskWallet.recommendedVersion,
      seed: TEST_SEED,
      password: TEST_PASSWORD,
      headless: false,  // MetaMask extension requires non-headless
    });
    await use(context);
  },
  wallet: async ({ context }, use) => {
    const w = await dappwright.getWallet("metamask", context);
    await w.addNetwork({
      networkName: "Base Sepolia",
      rpc: "https://base-sepolia-rpc.publicnode.com",
      chainId: 84532,
      symbol: "ETH",
    });
    await w.switchNetwork("Base Sepolia");
    await use(w);
  },
});

test.describe("EOA / MetaMask", () => {
  test.setTimeout(600_000); // 10 min

  test("MetaMask connects to /app + address shows in UI", async ({ context, wallet }) => {
    const page = await context.newPage();
    // Set chain to Base Sepolia BEFORE loading the app — otherwise the app
    // defaults to ETH Sepolia and shows "Wrong Network" after MetaMask connects
    await page.goto("http://localhost:3000/");
    await page.evaluate(() => {
      localStorage.setItem("blank_active_chain_id", "84532");
    });
    await page.goto("http://localhost:3000/app");
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(5_000);

    // List all open pages for debugging
    console.log(`  [MM] pages: ${context.pages().map(p => p.url().slice(0, 80)).join(" | ")}`);

    // Check if wagmi auto-connected (some versions auto-connect injected)
    let addr = await page.evaluate(() => {
      const body = document.body.innerText;
      const m = body.match(/0x[a-fA-F0-9]{4,6}[.…·]{1,3}[a-fA-F0-9]{3,4}/);
      return m?.[0] ?? null;
    });
    console.log(`  [EOA] pre-connect address: ${addr}`);

    if (!addr) {
      // Walk through onboarding → click Connect MetaMask
      for (let i = 0; i < 8; i++) {
        const action = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const mm = btns.find((b) => {
            const t = (b.textContent || "").trim().toLowerCase();
            return t.includes("connect metamask") || (t === "metamask" && !b.closest("[role=tab]"));
          });
          if (mm && !(mm as HTMLButtonElement).disabled) {
            (mm as HTMLButtonElement).click();
            return "metamask";
          }
          const next = btns.find((b) =>
            /^(next|continue|get started)$/i.test((b.textContent || "").trim().replace(/→/, "").trim()),
          );
          if (next) { (next as HTMLButtonElement).click(); return "next"; }
          return null;
        });
        console.log(`  [EOA] onboarding step ${i}: ${action}`);
        if (action === "metamask") {
          // Wait for MetaMask notification page to appear. Set up the listener
          // BEFORE the UI triggers the connect so we don't miss the event.
          // The notification page can take 5-30s to appear.
          console.log("  [MM] waiting for notification page...");
          let mmPage: Page | null = null;
          try {
            mmPage = await context.waitForEvent("page", { timeout: 60_000 });
            console.log(`  [MM] new page: ${mmPage.url().slice(0, 80)}`);
          } catch {
            console.log("  [MM] no new page event in 60s");
          }

          if (mmPage) {
            await mmPage.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});

            // MetaMask's React app takes time to render. Poll until at least
            // one button appears in the DOM (up to 30s).
            for (let wait = 0; wait < 30; wait++) {
              const count = await mmPage.evaluate(() => document.querySelectorAll("button").length).catch(() => 0);
              if (count > 0) break;
              await mmPage.waitForTimeout(1_000);
            }
            await mmPage.waitForTimeout(1_000); // extra settle time

            // Deep inspection — MetaMask may use Shadow DOM or iframes
            const pageInfo = await mmPage.evaluate(() => {
              const info: Record<string, unknown> = {};
              info.url = location.href;
              info.bodyChildren = document.body?.children.length ?? 0;
              info.allElements = document.querySelectorAll("*").length;
              info.buttons = Array.from(document.querySelectorAll("button")).map(b => (b.textContent || "").trim().slice(0, 40));
              info.iframes = Array.from(document.querySelectorAll("iframe")).length;
              info.shadowHosts = Array.from(document.querySelectorAll("*")).filter(el => el.shadowRoot).length;
              info.bodyHTML = document.body?.innerHTML?.slice(0, 500);
              return info;
            }).catch((e) => ({ error: String(e) }));
            console.log(`  [MM] page info: ${JSON.stringify(pageInfo)}`);

            // Playwright's getByRole pierces Shadow DOM automatically
            let clicked = false;
            try {
              const connectBtn = mmPage.getByRole("button", { name: /connect/i });
              const count = await connectBtn.count();
              console.log(`  [MM] Playwright 'connect' buttons: ${count}`);
              if (count > 0) {
                await connectBtn.first().click({ timeout: 5_000 });
                console.log("  [MM] clicked Connect via Playwright locator");
                clicked = true;
              }
            } catch (e) {
              console.log(`  [MM] locator error: ${(e as Error).message?.slice(0, 80)}`);
            }

            if (!clicked) {
              // Try other role-based locators
              for (const name of ["Confirm", "Next", "Approve", "Got it"]) {
                try {
                  const btn = mmPage.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
                  if (await btn.count() > 0) {
                    await btn.first().click({ timeout: 3_000 });
                    console.log(`  [MM] clicked '${name}' via locator`);
                    clicked = true;
                    break;
                  }
                } catch { /* try next */ }
              }
            }

            if (!clicked) {
              // Last resort: page.evaluate fallback
              const evalClick = await mmPage.evaluate(() => {
                const all = Array.from(document.querySelectorAll("button"));
                const confirm = all.find(b => /^(connect|confirm|approve|next)$/i.test((b.textContent || "").trim()));
                if (confirm && !(confirm as HTMLButtonElement).disabled) {
                  (confirm as HTMLButtonElement).click();
                  return (confirm.textContent || "").trim();
                }
                return null;
              }).catch(() => null);
              if (evalClick) { clicked = true; console.log(`  [MM] evaluate click: ${evalClick}`); }
            }

            console.log(`  [MM] approve result: ${clicked}`);

            // Wait for the notification page to close (MetaMask closes it after approve)
            if (clicked) {
              await mmPage.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
            }
          }

          // After approval, ensure MetaMask is on Base Sepolia
          await page.waitForTimeout(3_000);
          try {
            await wallet.switchNetwork("Base Sepolia");
            console.log("  [MM] switched to Base Sepolia");
          } catch (e) {
            console.log(`  [MM] switchNetwork: ${(e as Error).message?.slice(0, 80)}`);
          }
          await page.waitForTimeout(2_000);

          // Handle any follow-up dialogs (chain switch confirmation, etc.)
          await manualApprove(context, 10_000).catch(() => {});

          // Reload the app page so wagmi detects the new chain + connection
          await page.reload();
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(5_000);

          break;
        }
        if (!action) break;
        await page.waitForTimeout(1_500);
      }

      // Wait for wagmi to update state
      await page.waitForTimeout(5_000);

      // Handle "Wrong Network" screen — click "Switch to Base Sepolia" button
      // then approve chain-switch in MetaMask
      const wrongNetwork = await page.evaluate(() =>
        document.body.innerText.includes("Wrong Network"),
      );
      if (wrongNetwork) {
        console.log("  [EOA] Wrong Network detected — clicking switch");

        // Set up listener BEFORE clicking switch (MetaMask may popup)
        const switchPopup = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);

        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const switchBtn = btns.find(b => /switch to/i.test((b.textContent || "").trim()));
          if (switchBtn) (switchBtn as HTMLButtonElement).click();
        });

        const mmSwitchPage = await switchPopup;
        if (mmSwitchPage) {
          console.log(`  [MM] switch popup: ${mmSwitchPage.url().slice(0, 60)}`);
          // Wait for MetaMask to render
          for (let wait = 0; wait < 15; wait++) {
            const count = await mmSwitchPage.getByRole("button").count().catch(() => 0);
            if (count > 0) break;
            await mmSwitchPage.waitForTimeout(1_000);
          }
          // Click Approve/Confirm/Switch on MetaMask popup
          for (const name of ["Approve", "Confirm", "Switch network", "Connect"]) {
            try {
              const btn = mmSwitchPage.getByRole("button", { name: new RegExp(name, "i") });
              if (await btn.count() > 0) {
                await btn.first().click({ timeout: 5_000 });
                console.log(`  [MM] switch approved via '${name}'`);
                break;
              }
            } catch { /* try next */ }
          }
          await page.waitForTimeout(3_000);
        } else {
          // No popup — MetaMask auto-approved (already on the right network)
          console.log("  [MM] no switch popup (auto-approved)");
          await page.waitForTimeout(3_000);
        }
      }

      // Give wagmi time to pick up chain change + address
      await page.waitForTimeout(5_000);

      addr = await page.evaluate(() => {
        const body = document.body.innerText;
        const m = body.match(/0x[a-fA-F0-9]{4,6}[.…·]{1,3}[a-fA-F0-9]{3,4}/);
        return m?.[0] ?? null;
      });
      console.log(`  [EOA] post-connect address: ${addr}`);
    }

    // Debug: dump all text on page for diagnosis
    if (!addr) {
      const snippet = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.log(`  [EOA] page text: ${snippet}`);
      console.log(`  [MM] final pages: ${context.pages().map(p => p.url().slice(0, 80)).join(" | ")}`);
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-connected.png"), fullPage: true });
    expect(addr, "EOA address must appear in UI after MetaMask connect").toBeTruthy();
    console.log("  ✅ MetaMask EOA connect verified — address visible in UI");
  });
});
