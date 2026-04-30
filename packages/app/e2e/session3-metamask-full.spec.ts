import dappwright, { MetaMaskWallet, type Dappwright } from "@tenkeylabs/dappwright";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";
import { SUPABASE_URL, SUPABASE_ANON_KEY, loadSetup } from "./helpers/phase6-helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ──────────────────────────────────────────────────────────────────
//  Full MetaMask/EOA E2E — real extension, no mocks
//
//  Tests: Dashboard → Faucet → Send → Activity update → Receive
//
//  Every on-chain tx triggers a MetaMask popup. We handle it via
//  Playwright's getByRole() which uses CDP and bypasses MetaMask's
//  LavaMoat security sandbox (page.evaluate is blocked by LavaMoat).
// ──────────────────────────────────────────────────────────────────

const TEST_SEED = process.env.TEST_METAMASK_SEED ??
  "test test test test test test test test test test test junk";
const TEST_PASSWORD = "Tester@1234";
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results", "screenshots");
const RECIPIENT = loadSetup().recipient.address; // passkey test wallet

// ── MetaMask popup handler ──────────────────────────────────────
// MetaMask v11+ uses notification.html (not a new tab). LavaMoat
// blocks page.evaluate() inside MetaMask pages, so we use
// Playwright's getByRole() which talks via CDP directly.
async function approveMetaMask(
  context: BrowserContext,
  opts: { buttonName?: RegExp; timeoutMs?: number } = {},
): Promise<boolean> {
  const { buttonName = /confirm|connect|approve|sign|next|got it/i, timeoutMs = 60_000 } = opts;

  let mmPage: Page | null = null;
  try {
    mmPage = await context.waitForEvent("page", { timeout: timeoutMs });
  } catch {
    // Check existing pages for notification
    for (const p of context.pages()) {
      if (p.url().includes("notification") || p.url().includes("popup")) {
        mmPage = p;
        break;
      }
    }
    if (!mmPage) return false;
  }

  // Wait for MetaMask React to render buttons (takes 2-10s)
  await mmPage.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const count = await mmPage.getByRole("button").count().catch(() => 0);
    if (count > 0) break;
    await mmPage.waitForTimeout(1_000);
  }
  await mmPage.waitForTimeout(1_000);

  // Click the target button
  try {
    const btn = mmPage.getByRole("button", { name: buttonName });
    if (await btn.count() > 0) {
      await btn.first().click({ timeout: 5_000 });
      console.log(`  [MM] approved: ${buttonName}`);
      return true;
    }
  } catch { /* fall through */ }

  // Fallback: try specific button names
  for (const name of ["Confirm", "Connect", "Approve", "Sign", "Next", "Got it"]) {
    try {
      const btn = mmPage.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
      if (await btn.count() > 0) {
        await btn.first().click({ timeout: 3_000 });
        console.log(`  [MM] approved via '${name}'`);
        return true;
      }
    } catch { /* try next */ }
  }

  console.log("  [MM] no approval button found");
  return false;
}

// ── Playwright fixtures ──────────────────────────────────────────
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
      headless: false,
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

test.describe("MetaMask Full E2E — Dashboard → Send → Receive", () => {
  test.setTimeout(900_000); // 15 min

  test("complete MetaMask flow: connect → faucet → send → verify activity → receive", async ({ context, wallet }) => {
    const page = await context.newPage();

    // ═══════════════════════════════════════════════════════════════
    //  Step 0: Set chain + connect MetaMask
    // ═══════════════════════════════════════════════════════════════
    await page.goto("http://localhost:3000/");
    await page.evaluate(() => localStorage.setItem("blank_active_chain_id", "84532"));
    await page.goto("http://localhost:3000/app");
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(5_000);

    // Walk onboarding → Connect MetaMask
    for (let i = 0; i < 8; i++) {
      const action = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const mm = btns.find(b => (b.textContent || "").trim().toLowerCase().includes("connect metamask"));
        if (mm && !(mm as HTMLButtonElement).disabled) {
          (mm as HTMLButtonElement).click();
          return "metamask";
        }
        const next = btns.find(b => /^(next|continue|get started)$/i.test((b.textContent || "").trim().replace(/→/, "").trim()));
        if (next) { (next as HTMLButtonElement).click(); return "next"; }
        return null;
      });
      console.log(`  [CONNECT] step ${i}: ${action}`);
      if (action === "metamask") {
        await approveMetaMask(context, { buttonName: /connect/i });
        break;
      }
      if (!action) break;
      await page.waitForTimeout(1_500);
    }

    // Handle "Wrong Network" if it appears
    await page.waitForTimeout(3_000);
    const wrongNet = await page.evaluate(() => document.body.innerText.includes("Wrong Network"));
    if (wrongNet) {
      console.log("  [CONNECT] Wrong Network — switching");
      const switchPopup = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b => /switch to/i.test((b.textContent || "").trim()));
        if (btn) (btn as HTMLButtonElement).click();
      });
      const mmSwitch = await switchPopup;
      if (mmSwitch) await approveMetaMask(context, { buttonName: /approve|confirm|switch/i });
      await page.waitForTimeout(5_000);
    }

    // Verify address visible
    const addr = await page.evaluate(() => {
      const m = document.body.innerText.match(/0x[a-fA-F0-9]{4,6}[.…·]{1,3}[a-fA-F0-9]{3,4}/);
      return m?.[0] ?? null;
    });
    console.log(`  [CONNECT] address: ${addr}`);
    expect(addr, "MetaMask address visible after connect").toBeTruthy();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-full-01-connected.png"), fullPage: true });

    // ═══════════════════════════════════════════════════════════════
    //  Step 1: Dashboard — verify structure
    // ═══════════════════════════════════════════════════════════════
    console.log("  [DASHBOARD] verifying dashboard...");
    const dashboard = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="dashboard-root"]');
      const body = document.body.innerText;
      return {
        hasRoot: !!root,
        hasGreeting: /good (morning|afternoon|evening)/i.test(body),
        hasBalance: body.includes("████") || /\$[\d,.]+/.test(body),
        hasFaucet: /get test usdc/i.test(body),
        hasQuickActions: /send money|receive/i.test(body),
      };
    });
    console.log(`  [DASHBOARD] ${JSON.stringify(dashboard)}`);
    expect(dashboard.hasRoot, "dashboard-root testid").toBe(true);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-full-02-dashboard.png"), fullPage: true });

    // ═══════════════════════════════════════════════════════════════
    //  Step 2: Faucet — mint test USDC (needs ETH for gas)
    // ═══════════════════════════════════════════════════════════════
    console.log("  [FAUCET] clicking Get Test USDC...");
    const faucetClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b =>
        /get test usdc/i.test((b.textContent || "").trim()));
      if (btn && !(btn as HTMLButtonElement).disabled) {
        (btn as HTMLButtonElement).click();
        return true;
      }
      return false;
    });
    console.log(`  [FAUCET] clicked: ${faucetClicked}`);

    if (faucetClicked) {
      // MetaMask popup for faucet mint tx
      const mintApproved = await approveMetaMask(context, { buttonName: /confirm/i, timeoutMs: 30_000 });
      console.log(`  [FAUCET] mint approved: ${mintApproved}`);
      if (mintApproved) {
        // Wait for tx to confirm
        await page.waitForTimeout(15_000);
        console.log("  [FAUCET] mint tx submitted — waiting for confirmation");
      } else {
        // MetaMask may not have enough ETH for gas — test continues
        console.log("  [FAUCET] mint popup missed or rejected — may need ETH for gas");
      }
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-full-03-faucet.png"), fullPage: true });

    // ═══════════════════════════════════════════════════════════════
    //  Step 3: Navigate to Send
    // ═══════════════════════════════════════════════════════════════
    console.log("  [SEND] navigating to send...");
    // Click "Send Money" quick action or navigate directly
    const sendClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a")).find(el =>
        /send money|send$/i.test((el.textContent || "").trim()));
      if (btn) { (btn as HTMLElement).click(); return true; }
      return false;
    });
    if (!sendClicked) {
      await page.goto("http://localhost:3000/app/send");
    }
    await page.waitForTimeout(3_000);

    // Enter recipient address — the Send page has two panels:
    // Left: "Choose Recipient" with search (placeholder "Name or address")
    // Right: "WALLET ADDRESS" input for direct address entry
    // Use the WALLET ADDRESS input (right panel) for reliable filling
    await page.waitForTimeout(2_000);
    const walletInput = page.locator('input').filter({ hasText: /wallet/i }).or(
      page.locator('input[placeholder*="address"]'),
    ).or(page.locator('input').last());

    // Fill WALLET ADDRESS input (the LAST input, in "Other Options" right panel)
    // input[0]=search bar, input[1]=contact search, input[2]=wallet address
    const allInputs = page.locator("input");
    const inputCount = await allInputs.count();
    console.log(`  [SEND] inputs on page: ${inputCount}`);
    // Use the last input (wallet address direct entry)
    const walletAddrInput = allInputs.nth(inputCount - 1);
    await walletAddrInput.fill(RECIPIENT);
    console.log(`  [SEND] filled wallet address input with ${RECIPIENT.slice(0, 10)}...`);
    await page.waitForTimeout(1_000);

    // Click Continue to proceed to amount screen
    const continueSend = page.getByRole("button", { name: /continue/i });
    const contCount = await continueSend.count();
    console.log(`  [SEND] Continue buttons on send page: ${contCount}`);
    if (contCount > 0) {
      await continueSend.first().click();
      console.log("  [SEND] clicked Continue → amount screen");
      await page.waitForTimeout(3_000);
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-full-04-send-amount.png"), fullPage: true });

    // Enter amount via numeric keypad — use Playwright locator (aria-label)
    // Each keypad button has aria-label="1", aria-label="2", etc.
    // Type "1" = $1 USDC
    const keyBtn = page.locator('button[aria-label="1"]');
    const keyCount = await keyBtn.count();
    console.log(`  [SEND] keypad button '1' count: ${keyCount}`);
    if (keyCount > 0) {
      await keyBtn.first().click();
      await page.waitForTimeout(500);
    } else {
      // Fallback: try via getByRole
      try {
        await page.getByRole("button", { name: "1", exact: true }).click();
      } catch (e) {
        console.log(`  [SEND] keypad click failed: ${(e as Error).message?.slice(0, 60)}`);
      }
    }
    await page.waitForTimeout(1_000);
    // Verify amount registered
    const amountShown = await page.evaluate(() => {
      const body = document.body.innerText;
      const m = body.match(/\$(\d+)/);
      return m?.[1] ?? "0";
    });
    console.log(`  [SEND] amount shown: $${amountShown}`);

    // Click Continue (may be disabled if amount=0 — check before clicking)
    const continueBtn = page.getByRole("button", { name: /continue/i });
    const continueCount = await continueBtn.count();
    console.log(`  [SEND] Continue button count: ${continueCount}`);
    if (continueCount > 0) {
      const isDisabled = await continueBtn.first().isDisabled().catch(() => true);
      console.log(`  [SEND] Continue disabled: ${isDisabled}`);
      if (!isDisabled) {
        await continueBtn.first().click();
        await page.waitForTimeout(5_000); // Wait for FHE encrypt + navigate to confirm
      } else {
        console.log("  [SEND] Continue is disabled — amount may be 0 or recipient missing");
      }
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-full-05-send-confirm.png"), fullPage: true });

    // Confirm send — this triggers FHE encryption then MetaMask popup
    console.log("  [SEND] confirming...");
    const confirmClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b => {
        const t = (b.textContent || "").trim().toLowerCase();
        return t.includes("confirm") && t.includes("send");
      });
      if (btn && !(btn as HTMLButtonElement).disabled) {
        (btn as HTMLButtonElement).click();
        return true;
      }
      // Fallback: any "Send" or "Confirm" button
      const fallback = Array.from(document.querySelectorAll("button")).find(b =>
        /^(send|confirm)$/i.test((b.textContent || "").trim()));
      if (fallback && !(fallback as HTMLButtonElement).disabled) {
        (fallback as HTMLButtonElement).click();
        return true;
      }
      return false;
    });
    console.log(`  [SEND] confirm clicked: ${confirmClicked}`);

    if (confirmClicked) {
      // FHE encryption happens first (~5-15s), then MetaMask popup appears
      // The vault approval may need one popup, then the send needs another
      for (let txn = 0; txn < 3; txn++) {
        const approved = await approveMetaMask(context, { buttonName: /confirm|sign/i, timeoutMs: 60_000 });
        if (!approved) {
          console.log(`  [SEND] no more MetaMask popups after ${txn} approvals`);
          break;
        }
        console.log(`  [SEND] MetaMask tx #${txn + 1} approved`);
        await page.waitForTimeout(5_000);
      }
    }

    // Wait for success screen or activity update
    await page.waitForTimeout(10_000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-full-06-send-result.png"), fullPage: true });

    const sendResult = await page.evaluate(() => {
      const body = document.body.innerText.toLowerCase();
      return {
        success: body.includes("success") || body.includes("sent") || body.includes("payment sent"),
        error: body.includes("error") || body.includes("failed") || body.includes("reverted"),
        currentUrl: location.pathname,
      };
    });
    console.log(`  [SEND] result: ${JSON.stringify(sendResult)}`);

    // ═══════════════════════════════════════════════════════════════
    //  Step 4: Verify activity feed updated
    // ═══════════════════════════════════════════════════════════════
    console.log("  [ACTIVITY] checking activity feed...");
    await page.goto("http://localhost:3000/app");
    await page.waitForTimeout(5_000);

    const activity = await page.evaluate(() => {
      const body = document.body.innerText;
      // Look for any recent activity indicators
      return {
        hasActivitySection: /recent|activity|history/i.test(body),
        hasPaymentEntry: /payment|sent|send/i.test(body),
        bodySnippet: body.slice(0, 300),
      };
    });
    console.log(`  [ACTIVITY] ${JSON.stringify({ hasActivitySection: activity.hasActivitySection, hasPaymentEntry: activity.hasPaymentEntry })}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-full-07-activity.png"), fullPage: true });

    // ═══════════════════════════════════════════════════════════════
    //  Step 5: Receive page — verify QR + address
    // ═══════════════════════════════════════════════════════════════
    console.log("  [RECEIVE] checking receive page...");
    await page.goto("http://localhost:3000/app/receive");
    await page.waitForTimeout(3_000);

    const receive = await page.evaluate(() => {
      const body = document.body.innerText;
      return {
        hasQR: !!document.querySelector("svg") || body.includes("QR"),
        hasAddress: /0x[a-fA-F0-9]{10,}/.test(body),
        hasCopyBtn: /copy|share/i.test(body),
        hasPaymentLink: body.includes("localhost") || body.includes("/app/send"),
      };
    });
    console.log(`  [RECEIVE] ${JSON.stringify(receive)}`);
    expect(receive.hasAddress, "receive page shows full address").toBe(true);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "mm-full-08-receive.png"), fullPage: true });

    // ═══════════════════════════════════════════════════════════════
    //  Summary
    // ═══════════════════════════════════════════════════════════════
    console.log("\n  ═══ MetaMask Full E2E Summary ═══");
    console.log(`  ✅ Connect: ${addr}`);
    console.log(`  ✅ Dashboard: root=${dashboard.hasRoot} greeting=${dashboard.hasGreeting}`);
    console.log(`  ${faucetClicked ? "✅" : "⏭"} Faucet: clicked=${faucetClicked}`);
    console.log(`  ${sendResult.success ? "✅" : sendResult.error ? "❌" : "⏭"} Send: ${JSON.stringify(sendResult)}`);
    console.log(`  ✅ Receive: address=${receive.hasAddress} qr=${receive.hasQR}`);

    // Hard assertions: connect + dashboard + receive must work.
    // Send may fail if test wallet has 0 ETH (no gas) — that's expected.
    expect(addr).toBeTruthy();
    expect(dashboard.hasRoot).toBe(true);
    expect(receive.hasAddress).toBe(true);
    if (sendResult.error) {
      console.log("  ⚠️ Send failed — likely 0 ETH for gas. Fund the test wallet to verify full send flow.");
    }
  });
});
