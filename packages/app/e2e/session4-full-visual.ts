// ══════════════════════════════════════════════════════════════════
// Session 4 — Full Visual E2E Audit
//
// Single browser session. Every action produces a screenshot.
// Covers every remaining untested flow from user's last 10 messages.
// ══════════════════════════════════════════════════════════════════

import { chromium, type Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "test-results", "full-visual");
const BASE = "http://localhost:3000";
const PASSPHRASE = "test-passphrase-123";

const ACCOUNTS = {
  A: { address: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f", privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20" },
  B: { address: "0x135694d9578e6f355B80C3D259e4F7D5e2c76DE3", privKey: "7068617365362d726563697069656e742d736565642d4118191a1b1c1d1e1f20" },
};

let step = 0;
fs.mkdirSync(OUT, { recursive: true });

async function snap(page: Page, name: string) {
  step++;
  const file = `${String(step).padStart(3, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  console.log(`  [${step}] ${name}`);
}

async function answerPass(page: Page) {
  try {
    const inp = page.locator('input[type="password"]').first();
    await inp.waitFor({ state: "visible", timeout: 90_000 });
    await page.evaluate((p: string) => {
      const el = document.querySelector('input[type="password"]') as HTMLInputElement;
      if (!el) return;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, p);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, PASSPHRASE);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const form = document.querySelector('input[type="password"]')?.closest("form") as HTMLFormElement;
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    });
    return true;
  } catch { return false; }
}

async function setupAccount(browser: any, label: string) {
  const acc = ACCOUNTS[label as keyof typeof ACCOUNTS];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.evaluate(() => localStorage.setItem("blank_active_chain_id", "84532"));
  await page.goto(BASE + "/app");
  await page.evaluate(
    async (a: any) => {
      const pk = await import("/src/lib/passkey.ts");
      await pk.deletePasskey(a.chainId).catch(() => {});
      return pk._testImportPasskey(a.chainId, a.privKey, a.passphrase, `fv-${a.label}`);
    },
    { chainId: 84532, privKey: acc.privKey, passphrase: PASSPHRASE, label },
  );
  await page.goto(BASE + "/app");
  await page.waitForTimeout(8_000);
  return { ctx, page };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  console.log("Setting up accounts...\n");
  const { ctx: ctxA, page: A } = await setupAccount(browser, "A");
  const { ctx: ctxB, page: B } = await setupAccount(browser, "B");

  // ═══════════════════════════════════════════════════════════════
  // 1. AI AGENT — Full send flow
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== AI AGENT FULL FLOW ===");
  await A.goto(BASE + "/app/agents");
  await A.waitForTimeout(5_000);
  await snap(A, "ai-agent-page");

  // Fill the situation description
  const textarea = A.locator("textarea").first();
  await textarea.fill("Junior developer, Mumbai, 2 years experience, startup");
  await A.waitForTimeout(500);
  await snap(A, "ai-agent-filled");

  // Click Ask Agent
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b =>
      /ask agent/i.test((b.textContent || "").trim()));
    if (btn && !(btn as HTMLButtonElement).disabled) (btn as HTMLButtonElement).click();
  });
  console.log("  waiting for AI response (~15s)...");
  await A.waitForTimeout(20_000);
  await snap(A, "ai-agent-response");

  // Check what the agent returned
  const agentResult = await A.evaluate(() => {
    const body = document.body.innerText;
    return {
      hasAmount: /\$[\d,]+/.test(body),
      hasRecipient: /recipient|address|0x/i.test(body),
      snippet: body.slice(body.indexOf("$"), body.indexOf("$") + 50),
    };
  });
  console.log(`  agent result: ${JSON.stringify(agentResult)}`);

  // If agent returned an amount, try to fill recipient and send
  if (agentResult.hasAmount) {
    // Fill recipient address
    const recipInput = A.locator('input[placeholder*="0x"]').first();
    if (await recipInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await recipInput.fill(ACCOUNTS.B.address);
      await A.waitForTimeout(500);
      await snap(A, "ai-agent-recipient-filled");

      // Click Send/Submit/Pay
      await A.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const send = btns.find(b => {
          const t = (b.textContent || "").trim().toLowerCase();
          return (t.includes("send") || t.includes("pay") || t.includes("submit")) && !t.includes("ask");
        });
        if (send && !(send as HTMLButtonElement).disabled) (send as HTMLButtonElement).click();
      });
      await A.waitForTimeout(2_000);

      // Answer prompts
      for (let i = 0; i < 4; i++) {
        const ok = await answerPass(A);
        if (!ok) break;
        console.log(`  prompt #${i + 1}`);
        await A.waitForTimeout(3_000);
      }
      await A.waitForTimeout(10_000);
      await snap(A, "ai-agent-after-send");

      // Check recipient's Received tab
      await B.goto(BASE + "/app/agents");
      await B.waitForTimeout(5_000);
      await B.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b =>
          /^received$/i.test((b.textContent || "").trim()));
        if (btn) (btn as HTMLElement).click();
      });
      await B.waitForTimeout(3_000);
      await snap(B, "ai-agent-B-received");
      console.log("  AI Agent send flow complete");
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. BALANCE PROOF (with new allowBalanceReader fix)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== BALANCE PROOF ===");
  await A.goto(BASE + "/app/proofs");
  await A.waitForTimeout(5_000);
  await snap(A, "proofs-page");

  // Fill threshold and create proof
  const thresholdInput = A.locator('input[type="number"], input[placeholder*="0"]').first();
  if (await thresholdInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await thresholdInput.fill("1");
    await A.waitForTimeout(500);
    await snap(A, "proofs-threshold-filled");

    // Click create balance proof
    await A.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b => {
        const t = (b.textContent || "").trim().toLowerCase();
        return t.includes("balance") && t.includes("proof");
      });
      if (btn && !(btn as HTMLButtonElement).disabled) (btn as HTMLButtonElement).click();
    });
    await A.waitForTimeout(2_000);

    // Answer prompts (allowBalanceReader + proveBalanceAbove = 2+ prompts)
    for (let i = 0; i < 4; i++) {
      const ok = await answerPass(A);
      if (!ok) break;
      console.log(`  proof prompt #${i + 1}`);
      await A.waitForTimeout(5_000);
    }
    await A.waitForTimeout(10_000);
    await snap(A, "proofs-after-create");
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. GIFT — send, check recipient Received tab, verify Sent tab
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== GIFT FLOW ===");
  await A.goto(BASE + "/app/gifts");
  await A.waitForTimeout(5_000);
  await snap(A, "gifts-page");

  // Fill amount
  const giftAmount = A.locator('input[placeholder="0.00"]').first();
  if (await giftAmount.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await giftAmount.fill("1");
  }

  // Fill recipient
  const giftRecip = A.locator('input[placeholder*="0x"]').first();
  if (await giftRecip.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await giftRecip.fill(ACCOUNTS.B.address);
  }
  await A.waitForTimeout(500);
  await snap(A, "gift-form-filled");

  // Send gift
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b =>
      /send gift/i.test((b.textContent || "").trim()));
    if (btn && !(btn as HTMLButtonElement).disabled) (btn as HTMLButtonElement).click();
  });
  await A.waitForTimeout(2_000);

  for (let i = 0; i < 3; i++) {
    const ok = await answerPass(A);
    if (!ok) break;
    console.log(`  gift prompt #${i + 1}`);
    await A.waitForTimeout(3_000);
  }
  await A.waitForTimeout(10_000);
  await snap(A, "gift-after-send");

  // Sender: check Sent tab
  await A.goto(BASE + "/app/gifts");
  await A.waitForTimeout(3_000);
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b =>
      /^sent$/i.test((b.textContent || "").trim()));
    if (btn) (btn as HTMLElement).click();
  });
  await A.waitForTimeout(2_000);
  await snap(A, "gift-A-sent-tab");

  // Sender: check Received tab (should NOT show the gift we sent)
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b =>
      /^received$/i.test((b.textContent || "").trim()));
    if (btn) (btn as HTMLElement).click();
  });
  await A.waitForTimeout(2_000);
  await snap(A, "gift-A-received-tab");

  // Recipient: check Received tab (should show the gift)
  await B.goto(BASE + "/app/gifts");
  await B.waitForTimeout(3_000);
  await B.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b =>
      /^received$/i.test((b.textContent || "").trim()));
    if (btn) (btn as HTMLElement).click();
  });
  await B.waitForTimeout(2_000);
  await snap(B, "gift-B-received-tab");
  console.log("  Gift flow complete");

  // ═══════════════════════════════════════════════════════════════
  // 4. EVERY SCREEN — visual check (light mode)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== ALL SCREENS (light mode) ===");
  const screens = [
    ["/app", "dashboard"],
    ["/app/send", "send"],
    ["/app/receive", "receive"],
    ["/app/requests", "requests"],
    ["/app/groups", "groups"],
    ["/app/creators", "creator-support"],
    ["/app/business", "business"],
    ["/app/swap", "p2p-exchange"],
    ["/app/stealth", "stealth"],
    ["/app/gifts", "gifts"],
    ["/app/inheritance", "inheritance"],
    ["/app/proofs", "proofs"],
    ["/app/agents", "agents"],
    ["/app/smart-wallet", "smart-wallet"],
    ["/app/settings", "settings"],
    ["/app/history", "history"],
    ["/app/privacy", "privacy"],
  ];

  for (const [url, name] of screens) {
    await A.goto(BASE + url);
    await A.waitForTimeout(2_500);
    await snap(A, `screen-${name}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. DARK MODE — toggle + check key screens
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== DARK MODE ===");
  await A.goto(BASE + "/app");
  await A.waitForTimeout(3_000);
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button, div")).find(e =>
      /dark mode/i.test((e.textContent || "").trim()));
    if (btn) (btn as HTMLElement).click();
  });
  await A.waitForTimeout(2_000);
  await snap(A, "dark-dashboard");

  await A.goto(BASE + "/app/business");
  await A.waitForTimeout(3_000);
  await snap(A, "dark-business");

  // Open payroll modal in dark mode
  await A.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll("button"));
    const payroll = tabs.find(b => /^payroll$/i.test((b.textContent || "").trim()));
    if (payroll) (payroll as HTMLElement).click();
  });
  await A.waitForTimeout(1_000);
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b =>
      /run payroll/i.test((b.textContent || "").trim()));
    if (btn) (btn as HTMLElement).click();
  });
  await A.waitForTimeout(1_000);
  await snap(A, "dark-payroll-modal");

  // Toggle back to light
  await A.keyboard.press("Escape");
  await A.waitForTimeout(500);
  await A.goto(BASE + "/app");
  await A.waitForTimeout(2_000);
  await A.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button, div")).find(e =>
      /dark mode|light mode/i.test((e.textContent || "").trim()));
    if (btn) (btn as HTMLElement).click();
  });

  // ═══════════════════════════════════════════════════════════════
  // DONE
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n════════════════════════════════════════════`);
  console.log(`  Full Visual Audit Complete — ${step} screenshots`);
  console.log(`  Saved to: ${OUT}`);
  console.log(`════════════════════════════════════════════\n`);

  await ctxA.close();
  await ctxB.close();
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
