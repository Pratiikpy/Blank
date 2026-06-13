// Debuggable: add Arbitrum Sepolia to this Rabby profile + switch to it,
// dumping the real button labels Rabby renders so we click the right one.
import { launchRabby, unlockRabby, waitForRabbyPopup } from "./rabby-driver";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Page, BrowserContext } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARB = "0x66eee";

async function dumpButtons(popup: Page): Promise<string[]> {
  return popup.evaluate(() =>
    Array.from(document.querySelectorAll("button"))
      .map((b) => (b.textContent || "").trim())
      .filter((t) => t.length > 0 && t.length < 40)
  ).catch(() => []);
}

// Click the first visible+enabled button whose text matches one of `names`.
async function clickButton(popup: Page, names: string[]): Promise<string | null> {
  for (const n of names) {
    const btn = popup.locator("button", { hasText: new RegExp(`^${n}$`, "i") }).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      if (await btn.isEnabled().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        return n;
      }
    }
  }
  return null;
}

(async () => {
  const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
  const profileDir = process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
  const shotsDir = resolve(__dirname, "arb-debug-shots");
  const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const pw = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";

  const h = await launchRabby({ shotsDir, headless: false, profileDir });
  const { context: ctx, rabbyPage, rabbyExtensionId: extId } = h;
  const known = new Set<Page>([rabbyPage]);
  await unlockRabby(rabbyPage, pw);

  const app = await ctx.newPage();
  known.add(app);
  await app.goto(`${BASE}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await app.waitForTimeout(4000);
  const readChain = async () => app.evaluate(async () => {
    const eth = (window as any).ethereum; if (!eth) return "no-eth";
    return await eth.request({ method: "eth_chainId" }).catch((e: any) => "err:" + (e?.code ?? e?.message));
  });
  console.log("initial chain:", await readChain());

  // add Arb, confirm the popup once it RENDERS
  console.log("calling wallet_addEthereumChain...");
  app.evaluate(async (p) => { const eth = (window as any).ethereum; eth?.request({ method: "wallet_addEthereumChain", params: [p] }).catch(() => {}); }, {
    chainId: ARB, chainName: "Arbitrum Sepolia", rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
    nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://sepolia.arbiscan.io"],
  });
  let popup = await waitForRabbyPopup(ctx, extId, known, 15_000);
  if (popup) {
    await popup.waitForTimeout(4500); // let it render past the spinner
    await popup.screenshot({ path: resolve(shotsDir, "add-rendered.png") }).catch(() => {});
    console.log("ADD popup buttons:", JSON.stringify(await dumpButtons(popup)));
    // click confirm; loop a few times (Rabby add network often single CTA)
    for (let i = 0; i < 3; i++) {
      const clicked = await clickButton(popup, ["Confirm", "Add", "Approve", "Add to Rabby", "Allow", "OK"]);
      console.log("  clicked:", clicked);
      await app.waitForTimeout(1500);
      if (popup.isClosed()) break;
    }
  } else console.log("NO add popup");
  await app.waitForTimeout(2500);
  console.log("after add chain:", await readChain());

  // now switch
  console.log("calling wallet_switchEthereumChain...");
  app.evaluate(async (c) => { const eth = (window as any).ethereum; eth?.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c }] }).catch(() => {}); }, ARB);
  popup = await waitForRabbyPopup(ctx, extId, known, 12_000);
  if (popup) {
    await popup.waitForTimeout(3500);
    await popup.screenshot({ path: resolve(shotsDir, "switch-rendered.png") }).catch(() => {});
    console.log("SWITCH popup buttons:", JSON.stringify(await dumpButtons(popup)));
    for (let i = 0; i < 3; i++) {
      const clicked = await clickButton(popup, ["Switch network", "Confirm", "Switch", "Approve", "OK"]);
      console.log("  clicked:", clicked);
      await app.waitForTimeout(1500);
      if (popup.isClosed()) break;
    }
  } else console.log("NO switch popup (may have auto-switched)");
  await app.waitForTimeout(2500);
  console.log("FINAL chain:", await readChain());
  await app.screenshot({ path: resolve(shotsDir, "final-app2.png") }).catch(() => {});
  await ctx.close();
})().catch((e) => { console.error("DEBUG ERROR:", e.message); process.exit(1); });
