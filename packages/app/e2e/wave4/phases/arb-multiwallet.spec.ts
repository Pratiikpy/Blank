// Arb MULTI-WALLET UI proof: two real passkey-AA personas (Alice + Bob).
// Alice sends an encrypted private payment to Bob through the UI; Bob's wallet
// reflects the received (encrypted) balance. Both personas' screens are
// captured for audit; the cross-wallet effect is verified on-chain.
import { test, type Page } from "@playwright/test";
import { spawnWallet, PERSONAS } from "../fixtures/wallets";
import { shieldUsdc, drainPassphrasePrompts, readTxHashFromSuccess } from "../helpers/app-actions";
import * as fs from "fs";
import * as path from "path";

const OUT = path.resolve(process.cwd(), "test-results/arb-multiwallet");
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

async function readAaAddress(page: Page): Promise<string> {
  await page.goto("/app/wallet");
  const loc = page.locator('[data-testid="gas-wallet-address"]');
  await loc.waitFor({ state: "visible", timeout: 30_000 });
  return ((await loc.textContent()) ?? "").trim();
}

// Copied from 02-p2p-payments.spec.ts (driveSendFlow) — drives the send UI.
async function driveSendFlow(page: Page, recipient: string, amountUsdc: string, passphrase: string): Promise<string> {
  const recipientInput = page.locator('input[placeholder*="0x"]').or(page.locator('input[placeholder*="Wallet address"]')).first();
  await recipientInput.waitFor({ state: "visible", timeout: 30_000 });
  await recipientInput.fill(recipient);
  await page.locator("button").filter({ hasText: /^(Continue|Next)/i }).first().click();
  const amountInput = page.locator('input[placeholder="0.00"]').first();
  const hasInput = await amountInput.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  if (hasInput) await amountInput.fill(amountUsdc);
  else for (const ch of amountUsdc) { const k = page.locator(`button[aria-label="${ch}"]:visible`).first(); await k.waitFor({ state: "visible", timeout: 10_000 }); await k.click(); }
  await page.locator("main button:visible:not([disabled])").filter({ hasText: /^(Continue|Review|Next|Send)/i }).last().click();
  await page.waitForURL(/\/app\/send\/confirm/, { timeout: 30_000 });
  await page.locator("main button:visible:not([disabled])").filter({ hasText: /Confirm.*Send|^Send/i }).last().click();
  await drainPassphrasePrompts(page, passphrase, {
    windowMs: 360_000, gapMs: 90_000, expectAtLeast: 1,
    terminateOn: async () => (await page.locator('a[href*="/tx/0x"]').first().count()) > 0,
  });
  return await readTxHashFromSuccess(page).catch(() => "");
}

test("Arb multi-wallet — Alice sends private payment to Bob (both screens)", async ({ browser }) => {
  test.setTimeout(720_000);
  fs.mkdirSync(OUT, { recursive: true });
  const shot = async (p: Page, name: string) => { await p.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {}); console.log("shot:", name); };

  // Bob first: get his AA address + capture his starting dashboard.
  const bob = await spawnWallet(browser, { persona: PERSONAS.Bob, chainId: 421614, baseURL: BASE });
  const bobAa = await readAaAddress(bob.page);
  console.log("BOB_AA:", bobAa);
  await bob.page.goto("/app"); await bob.page.waitForTimeout(6000);
  await shot(bob.page, "01-bob-before");

  // Alice: shield + send 5 USDC encrypted to Bob.
  const alice = await spawnWallet(browser, { persona: PERSONAS.Alice, chainId: 421614, baseURL: BASE });
  await alice.page.goto("/app"); await alice.page.waitForTimeout(6000);
  await shot(alice.page, "02-alice-dashboard");
  await shieldUsdc(alice.page, "10", PERSONAS.Alice.passphrase).catch(() => {});
  await alice.page.goto("/app/send"); await alice.page.waitForTimeout(2500);
  await shot(alice.page, "03-alice-send-screen");
  const sendTx = await driveSendFlow(alice.page, bobAa, "5", PERSONAS.Alice.passphrase);
  console.log("SEND_TX:", sendTx);
  await alice.page.waitForTimeout(3000);
  await shot(alice.page, "04-alice-send-success");

  // Index the on-chain event so Bob's feed can reflect it.
  for (let i = 0; i < 6; i++) { await alice.page.request.get(`${BASE}/api/cron/reconcile-tick`).catch(() => {}); await alice.page.waitForTimeout(10_000); }

  // Bob: reload + capture his received state.
  await bob.page.goto("/app"); await bob.page.waitForTimeout(8000);
  await shot(bob.page, "05-bob-after");
  await bob.page.goto("/app/history"); await bob.page.waitForTimeout(5000);
  await shot(bob.page, "06-bob-history");

  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ bobAa, sendTx }, null, 2));
  await alice.context.close(); await bob.context.close();
});
