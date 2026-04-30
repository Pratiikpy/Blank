// Interactive browser driver — keeps browser alive between commands.
// Usage: npx tsx e2e/driver.ts <command> [args...]
//
// Commands:
//   start <label>          — Launch browser, setup passkey account, save state
//   goto <path>            — Navigate to path
//   snap <name>            — Take screenshot
//   click <text>           — Click button/link by visible text
//   clickAt <x> <y>        — Click at coordinates
//   fill <placeholder> <value> — Fill input by placeholder
//   type <keys>            — Type keys (e.g., "Enter", "Escape")
//   eval <js>              — Run JS in page, print result
//   text                   — Print page text (first 500 chars)
//   close                  — Close browser

import { chromium, type Browser, type Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_FILE = path.resolve(__dirname, "..", "test-results", "driver-state.json");
const SNAP_DIR = path.resolve(__dirname, "..", "test-results", "realtime-audit");
const BASE = "http://localhost:3000";
const PASSPHRASE = "test-passphrase-123";

const ACCOUNTS: Record<string, { address: string; privKey: string }> = {
  A: {
    address: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f",
    privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20",
  },
  B: {
    address: "0x135694d9578e6f355B80C3D259e4F7D5e2c76DE3",
    privKey: "7068617365362d726563697069656e742d736565642d4118191a1b1c1d1e1f20",
  },
};

let snapCounter = 0;

async function getSnap(page: Page, name: string) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  snapCounter++;
  const file = path.join(SNAP_DIR, `${String(snapCounter).padStart(3, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`SNAP: ${file}`);
  return file;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "start") {
    const label = args[0] || "A";
    const account = ACCOUNTS[label];
    if (!account) { console.error(`Unknown account: ${label}`); process.exit(1); }

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    // Setup
    await page.goto(BASE + "/");
    await page.evaluate(() => localStorage.setItem("blank_active_chain_id", "84532"));
    await page.goto(BASE + "/app");
    await page.evaluate(
      async ({ chainId, privKey, passphrase, label }: any) => {
        const pk = await import("/src/lib/passkey.ts");
        await pk.deletePasskey(chainId).catch(() => {});
        return pk._testImportPasskey(chainId, privKey, passphrase, `driver-${label}`);
      },
      { chainId: 84532, privKey: account.privKey, passphrase: PASSPHRASE, label },
    );
    await page.goto(BASE + "/app");
    await page.waitForTimeout(8_000);

    // Save CDP endpoint for reconnection
    const wsEndpoint = browser.wsEndpoint();
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ wsEndpoint, label }));
    console.log(`Browser started for account ${label} (${account.address})`);
    console.log(`WS: ${wsEndpoint}`);

    await getSnap(page, "start");

    // Keep alive
    await new Promise(() => {});
  }

  // All other commands connect to existing browser
  if (!fs.existsSync(STATE_FILE)) {
    console.error("No browser running. Run: npx tsx e2e/driver.ts start A");
    process.exit(1);
  }
  const { wsEndpoint } = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const contexts = browser.contexts();
  const page = contexts[0]?.pages()[0];
  if (!page) { console.error("No page found"); process.exit(1); }

  switch (cmd) {
    case "goto":
      await page.goto(BASE + (args[0] || "/app"));
      await page.waitForTimeout(3_000);
      await getSnap(page, `goto-${(args[0] || "app").replace(/\//g, "-")}`);
      break;

    case "snap":
      await getSnap(page, args[0] || "snap");
      break;

    case "click": {
      const text = args.join(" ");
      const btn = page.getByRole("button", { name: new RegExp(text, "i") }).first();
      if (await btn.count() > 0) {
        await btn.click({ timeout: 5_000 });
        console.log(`Clicked button: "${text}"`);
      } else {
        // Try link
        const link = page.getByRole("link", { name: new RegExp(text, "i") }).first();
        if (await link.count() > 0) {
          await link.click({ timeout: 5_000 });
          console.log(`Clicked link: "${text}"`);
        } else {
          // Try any element with matching text
          await page.evaluate((t: string) => {
            const all = Array.from(document.querySelectorAll("button, a, [role=tab], [role=button]"));
            const el = all.find(e => new RegExp(t, "i").test((e.textContent || "").trim()));
            if (el) (el as HTMLElement).click();
          }, text);
          console.log(`Clicked (eval): "${text}"`);
        }
      }
      await page.waitForTimeout(2_000);
      await getSnap(page, `click-${text.replace(/\s/g, "-").slice(0, 30)}`);
      break;
    }

    case "clickAt":
      await page.mouse.click(Number(args[0]), Number(args[1]));
      await page.waitForTimeout(1_000);
      await getSnap(page, `clickat-${args[0]}-${args[1]}`);
      break;

    case "fill": {
      const placeholder = args[0];
      const value = args.slice(1).join(" ");
      const input = page.locator(`input[placeholder*="${placeholder}"]`).first();
      if (await input.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await input.fill(value);
        console.log(`Filled "${placeholder}" with "${value}"`);
      } else {
        console.log(`Input with placeholder "${placeholder}" not found`);
      }
      await getSnap(page, `fill-${placeholder.slice(0, 20)}`);
      break;
    }

    case "type":
      await page.keyboard.press(args[0] || "Enter");
      console.log(`Typed: ${args[0]}`);
      await page.waitForTimeout(1_000);
      await getSnap(page, `type-${args[0]}`);
      break;

    case "passphrase": {
      try {
        const inp = page.locator('input[type="password"]').first();
        await inp.waitFor({ state: "visible", timeout: 90_000 });
        await page.evaluate((pass: string) => {
          const el = document.querySelector('input[type="password"]') as HTMLInputElement;
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
          setter.call(el, pass);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, PASSPHRASE);
        await page.waitForTimeout(100);
        await page.evaluate(() => {
          const form = document.querySelector('input[type="password"]')?.closest("form") as HTMLFormElement;
          if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
        });
        console.log("Passphrase entered");
      } catch {
        console.log("No passphrase prompt visible");
      }
      await page.waitForTimeout(2_000);
      await getSnap(page, "passphrase");
      break;
    }

    case "eval": {
      const js = args.join(" ");
      const result = await page.evaluate(js).catch((e: Error) => `Error: ${e.message}`);
      console.log(`Result: ${JSON.stringify(result)}`);
      break;
    }

    case "text": {
      const text = await page.evaluate(() => document.body.innerText.slice(0, 800));
      console.log(text);
      break;
    }

    case "url":
      console.log(page.url());
      break;

    case "close":
      await browser.close();
      fs.unlinkSync(STATE_FILE);
      console.log("Browser closed");
      break;

    default:
      console.log("Commands: start, goto, snap, click, clickAt, fill, type, passphrase, eval, text, url, close");
  }

  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
