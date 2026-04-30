import { chromium, type Page, type BrowserContext } from "playwright";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.resolve(__dirname, "..", "test-results", "visual-audit");
const BASE = "http://localhost:3000";

const PASSPHRASE = "test-passphrase-123";
const SETUP = {
  chainId: 84532,
  sender: {
    address: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f",
    passkey: {
      privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20",
    },
  },
  recipient: {
    address: "0x135694d9578e6f355B80C3D259e4F7D5e2c76DE3",
    passkey: {
      privKey: "7068617365362d726563697069656e742d736565642d4118191a1b1c1d1e1f20",
    },
  },
};

let step = 0;
const issues: string[] = [];

async function snap(page: Page, name: string) {
  step++;
  const filename = `${String(step).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(OUT, filename), fullPage: false });
  console.log(`  [${step}] ${name}`);
  return filename;
}

async function setupAccount(
  browser: any,
  account: typeof SETUP.sender,
  label: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Instrument console for debugging
  page.on("console", (msg: any) => {
    if (msg.type() === "error" && !msg.text().includes("403")) {
      console.log(`    [${label}.console.error] ${msg.text().slice(0, 120)}`);
    }
  });

  await page.goto(BASE + "/");
  await page.evaluate((id: number) => {
    localStorage.setItem("blank_active_chain_id", String(id));
  }, SETUP.chainId);
  await page.goto(BASE + "/app");
  await page.evaluate(
    async ({ chainId, privKey, passphrase, label }: any) => {
      const passkey = await import("/src/lib/passkey.ts");
      await passkey.deletePasskey(chainId).catch(() => {});
      return passkey._testImportPasskey(chainId, privKey, passphrase, label);
    },
    {
      chainId: SETUP.chainId,
      privKey: account.passkey.privKey,
      passphrase: PASSPHRASE,
      label: `audit-${label}`,
    },
  );
  await page.goto(BASE + "/app");
  await page.waitForTimeout(8_000);
  return { context, page };
}

async function answerPassphrase(page: Page) {
  try {
    const input = page.locator('input[type="password"]').first();
    await input.waitFor({ state: "visible", timeout: 90_000 });
    await page.evaluate((pass: string) => {
      const inp = document.querySelector('input[type="password"]') as HTMLInputElement;
      if (!inp) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(inp, pass);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }, PASSPHRASE);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const form = document.querySelector('input[type="password"]')?.closest("form") as HTMLFormElement;
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  console.log("Setting up accounts...\n");

  const [senderCtx, recipientCtx] = await Promise.all([
    setupAccount(browser, SETUP.sender, "A"),
    setupAccount(browser, SETUP.recipient, "B"),
  ]);
  const A = senderCtx.page;
  const B = recipientCtx.page;

  // ═══════════════════════════════════════════════════════════════
  //  1. DASHBOARD — both users
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== DASHBOARD ===");
  await snap(A, "A-dashboard");
  await snap(B, "B-dashboard");

  // Check chain label
  const chainLabelA = await A.evaluate(() => {
    const body = document.body.innerText;
    const m = body.match(/USDC\s*·\s*(\w+\s*\w*)/);
    return m?.[1] ?? "not found";
  });
  console.log(`    chain label on A's dashboard: "${chainLabelA}"`);
  if (chainLabelA.includes("Ethereum") && chainLabelA !== "Ethereum Sepolia") {
    issues.push(`Dashboard chain label says "${chainLabelA}" — may be wrong`);
  }

  // Check sidebar chain
  const sidebarChain = await A.evaluate(() => {
    const el = Array.from(document.querySelectorAll("button, span, div")).find(
      (e) => /base sepolia|ethereum sepolia/i.test((e.textContent || "").trim()),
    );
    return el ? (el.textContent || "").trim() : "not found";
  });
  console.log(`    sidebar chain: "${sidebarChain}"`);

  // Check if chain label matches sidebar
  if (sidebarChain.toLowerCase().includes("base") && chainLabelA.toLowerCase().includes("ethereum")) {
    issues.push("MISMATCH: sidebar says Base Sepolia but balance card says Ethereum Sepolia");
  }

  // ═══════════════════════════════════════════════════════════════
  //  2. ROLES BELL (top bar notification)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== ROLES BELL ===");
  // Click roles bell
  const rolesBell = A.locator('button[aria-label*="Roles"]').first();
  if (await rolesBell.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await rolesBell.click();
    await A.waitForTimeout(2_000);
    await snap(A, "A-roles-bell-opened");

    const rolesContent = await A.evaluate(() => {
      const body = document.body.innerText;
      return body.includes("assigned to you") || body.includes("arbiter") || body.includes("No roles");
    });
    console.log(`    roles panel has content: ${rolesContent}`);

    // Close it — press Escape (more reliable than finding close button)
    await A.keyboard.press("Escape");
    await A.waitForTimeout(1_000);
    // Fallback: click outside the modal
    await A.mouse.click(10, 10);
    await A.waitForTimeout(1_000);
  }

  // ═══════════════════════════════════════════════════════════════
  //  3. NOTIFICATION BELL (dashboard)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== NOTIFICATION BELL ===");
  // Navigate fresh to avoid stale modal overlays
  await A.goto(BASE + "/app");
  await A.waitForTimeout(5_000);
  const notifBell = A.locator('button[aria-label="Notifications"]').first();
  if (await notifBell.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await notifBell.click({ force: true });
    await A.waitForTimeout(3_000);
    await snap(A, "A-notification-bell-result");
    const currentUrl = await A.evaluate(() => location.pathname);
    console.log(`    notification bell navigated to: ${currentUrl}`);
  }
  await A.goto(BASE + "/app");
  await A.waitForTimeout(5_000);

  // ═══════════════════════════════════════════════════════════════
  //  4. CHAIN SELECTOR (try switching)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== CHAIN SELECTOR ===");
  await snap(A, "A-before-chain-switch");
  // Try to click chain selector in sidebar
  const chainBtn = A.locator("button, div").filter({ hasText: /base sepolia|ethereum sepolia/i }).first();
  if (await chainBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await chainBtn.click();
    await A.waitForTimeout(2_000);
    await snap(A, "A-chain-selector-opened");

    // Try clicking the other chain option
    const otherChain = A.locator("button, div, li").filter({ hasText: /ethereum sepolia/i }).first();
    if (await otherChain.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await otherChain.click();
      await A.waitForTimeout(5_000);
      await snap(A, "A-after-chain-switch");
      const newChainLabel = await A.evaluate(() => {
        const m = document.body.innerText.match(/USDC\s*·\s*(\w+\s*\w*)/);
        return m?.[1] ?? "not found";
      });
      console.log(`    chain label after switch: "${newChainLabel}"`);
    } else {
      console.log("    no other chain option found in dropdown");
      issues.push("Chain selector dropdown doesn't show alternative chain options");
    }
  } else {
    console.log("    chain selector button not found in sidebar");
  }
  // Switch back to Base Sepolia for remaining tests
  await A.evaluate(() => localStorage.setItem("blank_active_chain_id", "84532"));
  await A.goto(BASE + "/app");
  await A.waitForTimeout(5_000);

  // ═══════════════════════════════════════════════════════════════
  //  5. SEND MONEY (A → B) + verify B's dashboard updates
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== SEND MONEY A→B ===");
  await snap(B, "B-dashboard-before-send");

  await A.goto(BASE + "/app/send");
  await A.waitForTimeout(3_000);
  await snap(A, "A-send-page");

  // Fill recipient (last input = wallet address)
  const inputs = A.locator("input");
  const inputCount = await inputs.count();
  await inputs.nth(inputCount - 1).fill(SETUP.recipient.address);
  await A.waitForTimeout(500);

  // Click Continue
  const continueBtn = A.getByRole("button", { name: /continue/i });
  if (await continueBtn.count() > 0) {
    await continueBtn.first().click();
    await A.waitForTimeout(3_000);
  }
  await snap(A, "A-send-amount-page");

  // Type "1" on keypad
  const keyBtn = A.locator('button[aria-label="1"]');
  if (await keyBtn.count() > 0) {
    await keyBtn.first().click();
    await A.waitForTimeout(500);
  }

  // Click Continue to confirm
  const cont2 = A.getByRole("button", { name: /continue/i });
  if (await cont2.count() > 0 && !(await cont2.first().isDisabled())) {
    await cont2.first().click();
    await A.waitForTimeout(5_000);
  }
  await snap(A, "A-send-confirm-page");

  // Click Confirm & Send
  const confirmSend = await A.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t.includes("confirm") || t === "send";
    });
    if (btn && !(btn as HTMLButtonElement).disabled) {
      (btn as HTMLButtonElement).click();
      return true;
    }
    return false;
  });
  console.log(`    confirm send clicked: ${confirmSend}`);

  if (confirmSend) {
    // Answer prompts
    for (let i = 0; i < 4; i++) {
      const ok = await answerPassphrase(A);
      if (!ok) break;
      console.log(`    prompt #${i + 1} answered`);
      await A.waitForTimeout(3_000);
    }
    await A.waitForTimeout(10_000);
    await snap(A, "A-send-result");

    const sendResult = await A.evaluate(() => ({
      url: location.pathname,
      hasSuccess: document.body.innerText.toLowerCase().includes("success"),
      hasError: document.body.innerText.toLowerCase().includes("error"),
    }));
    console.log(`    send result: ${JSON.stringify(sendResult)}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  6. CHECK RECIPIENT — did balance update? notification?
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== RECIPIENT AFTER SEND ===");
  await B.reload();
  await B.waitForTimeout(8_000);
  await snap(B, "B-dashboard-after-send");

  // Check balance text
  const bBalance = await B.evaluate(() => {
    const el = document.querySelector("h2");
    return el?.textContent?.trim() ?? "not found";
  });
  console.log(`    B's balance display: "${bBalance}"`);
  if (bBalance.includes("████")) {
    issues.push("Recipient balance shows encrypted blocks after receiving payment");
  }

  // Check recent activity
  const bActivity = await B.evaluate(() => {
    const body = document.body.innerText;
    return {
      hasReceived: /received|payment/i.test(body),
      hasActivity: /recent activity/i.test(body),
    };
  });
  console.log(`    B sees activity: ${JSON.stringify(bActivity)}`);

  // ═══════════════════════════════════════════════════════════════
  //  7. EVERY SIDEBAR SCREEN — both users
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== ALL SCREENS ===");
  const screens = [
    { path: "/app/send", name: "send" },
    { path: "/app/receive", name: "receive" },
    { path: "/app/requests", name: "requests" },
    { path: "/app/groups", name: "groups" },
    { path: "/app/creator", name: "creator" },
    { path: "/app/business", name: "business" },
    { path: "/app/swap", name: "swap" },
    { path: "/app/stealth", name: "stealth" },
    { path: "/app/gifts", name: "gifts" },
    { path: "/app/inheritance", name: "inheritance" },
    { path: "/app/proofs", name: "proofs" },
    { path: "/app/agents", name: "agents" },
    { path: "/app/smart-wallet", name: "smart-wallet" },
    { path: "/app/settings", name: "settings" },
    { path: "/app/history", name: "history" },
    { path: "/app/contacts", name: "contacts" },
    { path: "/app/privacy", name: "privacy" },
  ];

  for (const s of screens) {
    await A.goto(BASE + s.path);
    await A.waitForTimeout(3_000);
    await snap(A, `A-screen-${s.name}`);

    // Check for obvious errors on page
    const pageCheck = await A.evaluate(() => {
      const body = document.body.innerText;
      return {
        hasError: /error|failed|crash/i.test(body) && !/no error/i.test(body),
        isEmpty: body.trim().length < 50,
        hasLoading: /loading|spinner/i.test(body),
      };
    });
    if (pageCheck.hasError) {
      issues.push(`Screen ${s.name} shows error text`);
      console.log(`    ⚠ ${s.name}: error text detected`);
    }
    if (pageCheck.isEmpty) {
      issues.push(`Screen ${s.name} appears empty`);
      console.log(`    ⚠ ${s.name}: page appears empty`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  8. DARK MODE
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== DARK MODE ===");
  await A.goto(BASE + "/app");
  await A.waitForTimeout(3_000);
  // Toggle dark mode
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button, div")).find(
      (e) => /dark mode/i.test((e.textContent || "").trim()),
    );
    if (btn) (btn as HTMLElement).click();
  });
  await A.waitForTimeout(2_000);
  await snap(A, "A-dark-mode-dashboard");

  // Toggle back
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button, div")).find(
      (e) => /light mode|dark mode/i.test((e.textContent || "").trim()),
    );
    if (btn) (btn as HTMLElement).click();
  });
  await A.waitForTimeout(1_000);

  // ═══════════════════════════════════════════════════════════════
  //  9. STEALTH TABS — sent tab, inbox, claim code
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== STEALTH TABS ===");
  await A.goto(BASE + "/app/stealth");
  await A.waitForTimeout(3_000);
  await snap(A, "A-stealth-create-tab");

  const stealthTabs = ["Inbox", "Claim Code", "My Sent"];
  for (const tabName of stealthTabs) {
    const tab = A.locator("button").filter({ hasText: new RegExp(tabName, "i") }).first();
    if (await tab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await tab.click();
      await A.waitForTimeout(2_000);
      await snap(A, `A-stealth-tab-${tabName.toLowerCase().replace(/\s/g, "-")}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  10. BUSINESS TOOLS — all tabs
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== BUSINESS TABS ===");
  await A.goto(BASE + "/app/business");
  await A.waitForTimeout(3_000);
  const bizTabs = ["Invoices", "Payroll", "Escrow"];
  for (const tabName of bizTabs) {
    const tab = A.locator("button").filter({ hasText: new RegExp(`^${tabName}$`, "i") }).first();
    if (await tab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await tab.click();
      await A.waitForTimeout(2_000);
      await snap(A, `A-business-tab-${tabName.toLowerCase()}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  11. GIFTS — received + sent tabs
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== GIFTS TABS ===");
  await A.goto(BASE + "/app/gifts");
  await A.waitForTimeout(3_000);
  await snap(A, "A-gifts-default");
  for (const tabName of ["Received", "Sent"]) {
    const tab = A.locator("button").filter({ hasText: new RegExp(`^${tabName}$`, "i") }).first();
    if (await tab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await tab.click();
      await A.waitForTimeout(2_000);
      await snap(A, `A-gifts-tab-${tabName.toLowerCase()}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  12. LANDING PAGE
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== LANDING ===");
  const landingPage = await browser.newPage();
  await landingPage.setViewportSize({ width: 1440, height: 900 });
  await landingPage.goto(BASE + "/");
  await landingPage.waitForTimeout(3_000);
  await snap(landingPage, "landing-hero");
  await landingPage.close();

  // ═══════════════════════════════════════════════════════════════
  //  REPORT
  // ═══════════════════════════════════════════════════════════════
  console.log("\n════════════════════════════════════════════");
  console.log(`  Visual Audit Complete — ${step} screenshots captured`);
  console.log(`  Issues found during audit: ${issues.length}`);
  for (const issue of issues) {
    console.log(`    ⚠ ${issue}`);
  }
  console.log(`  Screenshots saved to: ${OUT}`);
  console.log("════════════════════════════════════════════\n");

  await senderCtx.context.close();
  await recipientCtx.context.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
