// Real-time audit driver — persistent browser state via user data dir.
// Each invocation reuses the same profile (localStorage, cookies persist).
//
// Usage: npx tsx e2e/rt.ts <command> [args...]
import { chromium } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = path.resolve(__dirname, "..", "test-results", "rt");
const USER_DATA = path.resolve(__dirname, "..", "test-results", "rt-profile");
const BASE = "http://localhost:3000";
const PASSPHRASE = "test-passphrase-123";
const COUNTER_FILE = path.resolve(SNAP_DIR, ".counter");

fs.mkdirSync(SNAP_DIR, { recursive: true });

// Persistent counter across invocations
let counter = 0;
try { counter = parseInt(fs.readFileSync(COUNTER_FILE, "utf-8")); } catch {}

async function snap(page: any, name: string): Promise<string> {
  counter++;
  fs.writeFileSync(COUNTER_FILE, String(counter));
  const file = path.join(SNAP_DIR, `${String(counter).padStart(3, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) { console.log("Commands: setup, go, snap, click, fill, key, pass, text, url, reset"); return; }

  if (cmd === "reset") {
    fs.rmSync(USER_DATA, { recursive: true, force: true });
    fs.rmSync(COUNTER_FILE, { force: true });
    counter = 0;
    console.log("Profile reset");
    return;
  }

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    args: ["--no-sandbox"],
  });
  const page = context.pages()[0] || await context.newPage();

  if (cmd === "setup") {
    const label = args[0] || "A";
    const accounts: Record<string, { privKey: string }> = {
      A: { privKey: "7068617365322d746573742d706173736b65792d736565642d311b1c1d1e1f20" },
      B: { privKey: "7068617365362d726563697069656e742d736565642d4118191a1b1c1d1e1f20" },
    };
    const acc = accounts[label]!;
    await page.goto(BASE + "/");
    await page.evaluate(() => localStorage.setItem("blank:active_chain_id", "84532"));
    await page.goto(BASE + "/app");
    await page.evaluate(
      async ({ chainId, privKey, passphrase, label }: any) => {
        const pk = await import("/src/lib/passkey.ts");
        await pk.deletePasskey(chainId).catch(() => {});
        return pk._testImportPasskey(chainId, privKey, passphrase, `rt-${label}`);
      },
      { chainId: 84532, privKey: acc.privKey, passphrase: PASSPHRASE, label },
    );
    await page.goto(BASE + "/app");
    await page.waitForTimeout(8_000);
    const f = await snap(page, "setup-" + label);
    console.log(f);
  } else if (cmd === "go") {
    const p = args[0] || "/app";
    await page.goto(BASE + p);
    await page.waitForTimeout(3_000);
    const f = await snap(page, "go" + p.replace(/\//g, "-"));
    console.log(f);
  } else if (cmd === "snap") {
    const f = await snap(page, args[0] || "snap");
    console.log(f);
  } else if (cmd === "click") {
    const text = args.join(" ");
    // Try button first
    const btn = page.getByRole("button", { name: new RegExp(text, "i") }).first();
    if (await btn.count() > 0) {
      await btn.click({ force: true, timeout: 5_000 }).catch(() => {});
    } else {
      await page.evaluate((t: string) => {
        const els = Array.from(document.querySelectorAll("button, a, [role=tab], [role=button], [role=menuitem]"));
        const el = els.find(e => new RegExp(t, "i").test((e.textContent || "").trim()));
        if (el) (el as HTMLElement).click();
      }, text);
    }
    await page.waitForTimeout(2_000);
    const f = await snap(page, "click-" + text.replace(/\s+/g, "-").slice(0, 25));
    console.log(f);
  } else if (cmd === "fill") {
    const [ph, ...rest] = args;
    const val = rest.join(" ");
    const input = page.locator(`input[placeholder*="${ph}" i], textarea[placeholder*="${ph}" i]`).first();
    await input.fill(val).catch(() => console.log("Input not found: " + ph));
    const f = await snap(page, "fill-" + ph.slice(0, 15));
    console.log(f);
  } else if (cmd === "key") {
    await page.keyboard.press(args[0] || "Escape");
    await page.waitForTimeout(1_000);
    const f = await snap(page, "key-" + (args[0] || "esc"));
    console.log(f);
  } else if (cmd === "pass") {
    try {
      const inp = page.locator('input[type="password"]').first();
      await inp.waitFor({ state: "visible", timeout: 120_000 });
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
      console.log("OK");
    } catch { console.log("NO_PROMPT"); }
    await page.waitForTimeout(2_000);
    const f = await snap(page, "pass");
    console.log(f);
  } else if (cmd === "text") {
    const t = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    console.log(t);
  } else if (cmd === "url") {
    console.log(page.url());
  } else if (cmd === "wait") {
    const ms = parseInt(args[0] || "5000");
    await page.waitForTimeout(ms);
    const f = await snap(page, "wait");
    console.log(f);
  }

  await context.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
