/**
 * QA batch v2 — feature-specific selectors based on real screenshots.
 *
 * Each feature uses its EXACT placeholder text or scoped locators so
 * the global search bar (input[placeholder="Search transactions,
 * contacts..."]) at the top of every screen doesn't capture our
 * .first() input selectors.
 */
import { chromium, type Page, type BrowserContext, type Locator } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import {
  unlockRabby,
  dismissRabbyWhatsNew,
  waitAndConfirmRabbyPopup,
  confirmRabbyPopup,
} from "../../fixtures/rabby/rabby-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

const VERCEL_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://www.myblank.app";
const RABBY_EXT_DIR = resolve(REPO, "packages/app/e2e/fixtures/rabby/ext");
const RABBY_PROFILE_DIR =
  process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
const RABBY_PASSWORD = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
if (CHAIN_ID !== 84532 && CHAIN_ID !== 11155111 && CHAIN_ID !== 421614)
  throw new Error(`Unsupported CHAIN_ID ${CHAIN_ID}`);
const CHAIN_SLUG = CHAIN_ID === 11155111 ? "eth" : CHAIN_ID === 84532 ? "base" : "arb";
const CHAIN_NAME =
  CHAIN_ID === 11155111 ? "Ethereum Sepolia" : CHAIN_ID === 84532 ? "Base Sepolia" : "Arbitrum Sepolia";
const EXPLORER_URL =
  CHAIN_ID === 11155111
    ? "https://sepolia.etherscan.io"
    : CHAIN_ID === 84532
      ? "https://sepolia.basescan.org"
      : "https://sepolia.arbiscan.io";
const OUT = resolve(REPO, `packages/app/test-results/qa-live-batch-${CHAIN_SLUG}`);
const QA_COUNTERPARTY = process.env.QA_COUNTERPARTY ?? "0x000000000000000000000000000000000000beef";
type Persona = "Dave" | "Bob" | "Carol";
const QA_PERSONA = (process.env.QA_PERSONA ?? "Dave") as Persona;
const accountByPersona: Record<Persona, string> = {
  Dave: "0x7eF99105308230eab5B8E4765842bc2BF7B1D175",
  Bob: "0x0D1883c48E14d733D464478f53706D92b7648b9d",
  Carol: "0x54488ad8d58f9147c1a99673ef8743608cd1b526",
};
const labelByPersona: Record<Persona, string> = {
  Dave: "Private Key 1",
  Bob: "Private Key 2",
  Carol: "Seed Phrase 1 #1",
};

interface FeatureResult {
  name: string;
  status: "green" | "red" | "skipped";
  txHash?: string;
  shareUrl?: string;
  notes: string;
  screenshot: string;
}

const results: FeatureResult[] = [];

async function snap(p: Page, label: string): Promise<string> {
  const path = resolve(OUT, `${label}.png`);
  await p.screenshot({ path, fullPage: true }).catch(() => {});
  return path;
}

function txFromText(text: string): string | undefined {
  const m = text.match(/0x[0-9a-fA-F]{64}/);
  return m ? m[0] : undefined;
}

async function drainPopups(
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
  label: string,
  maxPopups = 3,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxPopups; i++) {
    const existing = ctx.pages().find((p) => {
      if (p.isClosed()) return false;
      const url = p.url();
      return url.includes(extId) && url.includes("notification.html");
    });
    const r = existing
      ? { popup: existing, ...(await confirmRabbyPopup(existing, OUT, `${label}-${i + 1}`)) }
      : await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, `${label}-${i + 1}`, 45_000);
    if (r.popup) known.add(r.popup);
    if (r.clicks === 0) break;
    total += r.clicks;
  }
  return total;
}

async function ensureWalletChain(
  page: Page,
  ctx: BrowserContext,
  extId: string,
  known: Set<Page>,
): Promise<void> {
  const targetHex = `0x${CHAIN_ID.toString(16)}`;
  const before = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<string> } }).ethereum;
    if (!eth) return null;
    return await eth.request({ method: "eth_chainId" }).catch(() => null);
  });
  if (before?.toLowerCase() !== targetHex.toLowerCase()) {
    await page.evaluate(async (hex) => {
      const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
      if (!eth) throw new Error("window.ethereum missing");
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    }, targetHex).catch(() => undefined);
    await drainPopups(ctx, extId, known, `switch-${CHAIN_ID}`, 2);
  }
  const after = await page.evaluate(async () => {
    const eth = (window as unknown as { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<string> } }).ethereum;
    if (!eth) return null;
    return await eth.request({ method: "eth_chainId" }).catch(() => null);
  });
  if (after?.toLowerCase() !== targetHex.toLowerCase()) {
    throw new Error(`wallet chain mismatch: expected ${targetHex}, got ${after ?? "null"}`);
  }
}

async function switchRabbyAccount(rabbyPage: Page, extId: string, persona: Persona): Promise<void> {
  const target = labelByPersona[persona];
  const expected = accountByPersona[persona].toLowerCase();
  await rabbyPage.goto(`chrome-extension://${extId}/index.html`).catch(() => undefined);
  await rabbyPage.waitForTimeout(1_500);
  await dismissRabbyWhatsNew(rabbyPage);
  const body = ((await rabbyPage.locator("body").textContent().catch(() => "")) ?? "").toLowerCase();
  if (body.includes(expected.slice(0, 8)) || body.includes(expected.slice(0, 6))) return;

  const current = rabbyPage.locator("text=/Private Key \\d|Seed Phrase/i").first();
  if (await current.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await current.click({ force: true }).catch(async () => {
      const bb = await current.boundingBox().catch(() => null);
      if (bb) await rabbyPage.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    });
  } else {
    await rabbyPage.mouse.click(130, 95);
  }
  await rabbyPage.waitForTimeout(1_500);

  const targetRows = rabbyPage.locator("div, button").filter({ hasText: new RegExp(target, "i") });
  const count = await targetRows.count().catch(() => 0);
  if (count === 0) throw new Error(`Rabby account row not found for ${target}`);
  const row = targetRows.nth(Math.max(0, count - 1));
  const box = await row.boundingBox({ timeout: 5_000 }).catch(() => null);
  if (box) await rabbyPage.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 38));
  else await row.click({ force: true });
  await rabbyPage.waitForTimeout(2_500);
}

// Safe-fill: clicks the locator, clears, types, blurs via Tab.
async function safeFill(loc: Locator, value: string): Promise<boolean> {
  if (!(await loc.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
  await loc.click({ timeout: 3_000 }).catch(() => {});
  await loc.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await loc.press("Backspace").catch(() => {});
  await loc.type(value, { delay: 35 });
  await loc.press("Tab").catch(() => {});
  return true;
}

// ──────────────────────────────────────────────────────────────────
async function driveStealth(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Stealth Inbox";
  await dapp.goto(`${VERCEL_URL}/app/stealth/setup`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // The setup CTA opens a "Set stealth passphrase" modal. Click whichever
  // "Generate" / "Set up" / "Create" / "Continue" button is visible.
  const setupCta = dapp
    .locator("button:visible:not([disabled])")
    .filter({ hasText: /Generate|Set up|Create.*key|Get started/i })
    .first();
  if (await setupCta.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await setupCta.click();
    await dapp.waitForTimeout(1_500);
  }
  // Now a passphrase modal should be open with placeholder "Passphrase".
  const passInput = dapp.locator('input[placeholder="Passphrase"]').first();
  if (await passInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await safeFill(passInput, "wave4-dave-stealth");
    // Click "Decrypt" / "Set" / "Save" — the modal's primary CTA.
    const modalCta = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^Decrypt$|^Set$|^Save$|^Continue$/i }).first();
    if (await modalCta.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await modalCta.click();
      await dapp.waitForTimeout(3_000);
    }
  }
  await drainPopups(ctx, extId, known, "stealth");
  await dapp.waitForTimeout(3_000);
  const bodyText = (await dapp.locator("body").textContent({ timeout: 3_000 }).catch(() => "")) ?? "";
  const txHash = txFromText(bodyText);
  // Success indicator: meta-address visible, or stealth-inbox UI is unlocked.
  const inboxUnlocked = await dapp
    .locator("text=/Stealth Inbox|stealth meta|Send to stealth/i")
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
  const s = await snap(dapp, "stealth-final");
  return {
    name,
    status: txHash || inboxUnlocked ? "green" : "red",
    txHash,
    notes: txHash ? "tx captured" : inboxUnlocked ? "inbox unlocked / meta-address ready" : "no proof",
    screenshot: s,
  };
}

// ──────────────────────────────────────────────────────────────────
async function driveInheritance(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Inheritance";
  await dapp.goto(`${VERCEL_URL}/app/inheritance`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // Open Set Up Plan modal.
  const setupBtn = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^\+\s*Set Up.*Plan|^Set Up.*Plan|Create.*Plan/i }).first();
  if (!(await setupBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const planActive = await dapp.locator("text=/Plan Active|Active Plan|Check In Now|Protected/i").first().isVisible({ timeout: 3_000 }).catch(() => false);
    if (!planActive) {
      return {
        name,
        status: "skipped",
        notes: "No Set-Up-Plan CTA and no active plan visible",
        screenshot: await snap(dapp, "inheritance-no-cta"),
      };
    }
    const changeBtn = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^Change Heir$/i }).first();
    if (!(await changeBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      return {
        name,
        status: "red",
        notes: "Active plan visible but Change Heir CTA missing",
        screenshot: await snap(dapp, "inheritance-no-change-heir"),
      };
    }
    await changeBtn.click();
  } else {
    await setupBtn.click();
  }
  await dapp.waitForTimeout(1_500);
  // Heir address input — scope to the modal panel (any input matching 0x but NOT the global search).
  // The global search has placeholder "Search transactions, contacts..." — use negative match.
  const heirInput = dapp
    .locator('input[placeholder*="0x"]:not([placeholder*="Search"]):not([placeholder*="search"])')
    .first();
  await safeFill(heirInput, QA_COUNTERPARTY);
  await snap(dapp, "inheritance-form-filled");
  // Submit — modal CTA is "+ Set Heir" (Inheritance.tsx, confirmed via screenshot).
  const submit = dapp.locator("button:visible:not([disabled])").filter({ hasText: /\+?\s*Set Heir|^Set Heir$/i }).first();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return { name, status: "red", notes: "Set Heir CTA not visible in modal", screenshot: await snap(dapp, "inheritance-no-submit") };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "inheritance");
  await dapp.waitForTimeout(8_000);
  const txHash = txFromText((await dapp.locator("body").textContent().catch(() => "")) ?? "");
  // Success indicator: "Plan Active" or "Heir set" or "Check In Now" appears.
  const planActive = await dapp.locator("text=/Plan Active|Active Plan|Check In Now|Plan created|Heir.*set/i").first().isVisible({ timeout: 3_000 }).catch(() => false);
  return {
    name,
    status: txHash || planActive ? "green" : "red",
    txHash,
    notes: txHash ? "tx captured" : planActive ? "Plan Active state visible" : "no proof",
    screenshot: await snap(dapp, "inheritance-final"),
  };
}

// ──────────────────────────────────────────────────────────────────
async function driveProof(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Encrypted Proof";
  await dapp.goto(`${VERCEL_URL}/app/proofs`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // The "Create a new income proof" form is inline. Use the specific
  // threshold input placeholder.
  const threshold = dapp.locator('input[placeholder*="Threshold"]').first();
  if (!(await threshold.isVisible({ timeout: 5_000 }).catch(() => false))) {
    // Alternative: click a quick-amount button.
    const quickBtn = dapp.locator("button:visible").filter({ hasText: /^\$1,000|^\$10,000/i }).first();
    if (await quickBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await quickBtn.click();
    } else {
      return { name, status: "red", notes: "No Threshold input / quick-amount visible", screenshot: await snap(dapp, "proof-no-threshold") };
    }
  } else {
    await safeFill(threshold, "1000");
  }
  await snap(dapp, "proof-threshold-filled");
  // "Create proof" button — should now be enabled.
  const createBtn = dapp.locator("button:visible").filter({ hasText: /^Create proof$|^Create Proof$/i }).first();
  if (!(await createBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return { name, status: "red", notes: "Create-proof button missing", screenshot: await snap(dapp, "proof-no-create") };
  }
  const isDisabled = await createBtn.isDisabled().catch(() => true);
  if (isDisabled) {
    return { name, status: "red", notes: "Create-proof button disabled after fill", screenshot: await snap(dapp, "proof-create-disabled") };
  }
  await createBtn.click();
  await drainPopups(ctx, extId, known, "proof");
  await dapp.waitForTimeout(5_000);
  // Success: Proof appears in "Your proofs" list with "Proof #N created..."
  // Or share URL `/v/` appears.
  const shareUrl = await dapp.locator('a[href*="/v/"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  const bodyText = (await dapp.locator("body").textContent().catch(() => "")) ?? "";
  const proofCreated = /Proof #\d+|Income ≥|created \d/i.test(bodyText);
  const txHash = txFromText(bodyText);
  return {
    name,
    status: shareUrl || proofCreated || txHash ? "green" : "red",
    txHash,
    shareUrl: shareUrl ?? undefined,
    notes: shareUrl ? `share URL: ${shareUrl}` : proofCreated ? "proof visible in Your-proofs list" : txHash ? "tx captured" : "no proof",
    screenshot: await snap(dapp, "proof-final"),
  };
}

// ──────────────────────────────────────────────────────────────────
async function driveBusinessInvoice(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Business Invoice";
  await dapp.goto(`${VERCEL_URL}/app/business`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // Outer "+ New Invoice" opens modal.
  const cta = dapp.locator("button:visible:not([disabled])").filter({ hasText: /\+\s*New Invoice|^New Invoice$|Create.*Invoice/i }).first();
  if (!(await cta.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return { name, status: "skipped", notes: "No New-Invoice CTA visible", screenshot: await snap(dapp, "business-no-cta") };
  }
  await cta.click();
  await dapp.waitForTimeout(1_500);
  // Modal — scope by visible "New Invoice" heading. Look for inputs INSIDE the modal.
  const wallet = dapp
    .locator('input[placeholder*="0x"]:not([placeholder*="Search" i])')
    .first();
  await safeFill(wallet, QA_COUNTERPARTY);
  const amount = dapp.locator('input[placeholder="0.00"]').first();
  await safeFill(amount, "25");
  const desc = dapp.locator('input[placeholder="Services rendered"], textarea').first();
  if (await desc.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await safeFill(desc, "QA test invoice");
  }
  await snap(dapp, "business-form-filled");
  // Inner CTA "+ Create Invoice".
  const submit = dapp.locator("button:visible:not([disabled])").filter({ hasText: /\+\s*Create Invoice|^Create Invoice$/i }).first();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return { name, status: "red", notes: "Create Invoice submit not visible in modal", screenshot: await snap(dapp, "business-no-submit") };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "business");
  await dapp.waitForTimeout(8_000);
  const txHash = txFromText((await dapp.locator("body").textContent().catch(() => "")) ?? "");
  // Success: invoice card appears in list or success toast.
  const successBanner = await dapp.locator("text=/Invoice created|Sent|Generated/i").first().isVisible({ timeout: 2_000 }).catch(() => false);
  const invoiceCard = await dapp.locator("text=/QA test invoice|pending|0x0000.*beef/i").first().isVisible({ timeout: 3_000 }).catch(() => false);
  return {
    name,
    status: txHash || successBanner || invoiceCard ? "green" : "red",
    txHash,
    notes: txHash ? "tx captured" : successBanner ? "success banner visible" : invoiceCard ? "invoice card visible" : "no proof",
    screenshot: await snap(dapp, "business-final"),
  };
}

// ──────────────────────────────────────────────────────────────────
async function drivePaymentRequest(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Payment Request";
  await dapp.goto(`${VERCEL_URL}/app/requests`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  const cta = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^\+\s*Request|^Request$|New.*Request/i }).first();
  if (!(await cta.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return { name, status: "skipped", notes: "No Request CTA visible", screenshot: await snap(dapp, "request-no-cta") };
  }
  await cta.click();
  await dapp.waitForTimeout(1_500);
  const payer = dapp
    .locator('input[placeholder*="0x"]:not([placeholder*="Search" i])')
    .first();
  await safeFill(payer, QA_COUNTERPARTY);
  const amount = dapp.locator('input[placeholder="0.00"]').first();
  await safeFill(amount, "5");
  await snap(dapp, "request-form-filled");
  const submit = dapp.locator("button:visible:not([disabled])").filter({ hasText: /Send Request|^Send Request$|Create.*Request/i }).first();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return { name, status: "red", notes: "Submit CTA not visible", screenshot: await snap(dapp, "request-no-submit") };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "request");
  await dapp.waitForTimeout(8_000);
  // Switch to Outgoing tab to find the new request.
  const outgoingTab = dapp.getByRole("button", { name: /^Outgoing$/i }).first();
  if (await outgoingTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await outgoingTab.click();
  } else {
    await dapp.locator("button:visible").filter({ hasText: /^Outgoing$/i }).first().click().catch(() => undefined);
  }
  await dapp.waitForTimeout(3_000);
  const requestVisible = await dapp.locator("text=/0x.*beef|pending|QA request|No note/i").first().isVisible({ timeout: 5_000 }).catch(() => false);
  const txHash = txFromText((await dapp.locator("body").textContent().catch(() => "")) ?? "");
  return {
    name,
    status: txHash || requestVisible ? "green" : "red",
    txHash,
    notes: txHash ? "tx captured" : requestVisible ? "request visible in Outgoing tab" : "no proof",
    screenshot: await snap(dapp, "request-final"),
  };
}

// ──────────────────────────────────────────────────────────────────
async function driveGroup(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Group";
  await dapp.goto(`${VERCEL_URL}/app/groups`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // Open Create modal — "+ Create Group" button in header.
  const cta = dapp.locator("button:visible:not([disabled])").filter({ hasText: /\+\s*Create Group|^Create Group$|First Group/i }).first();
  if (!(await cta.isVisible({ timeout: 5_000 }).catch(() => false))) {
    // Group may already exist from prior batch run — treat as green if list non-empty.
    const groupList = await dapp.locator("text=/Group #\\d/i").first().isVisible({ timeout: 2_000 }).catch(() => false);
    return {
      name,
      status: groupList ? "green" : "skipped",
      notes: groupList ? "group already exists (idempotent)" : "No Create-Group CTA visible",
      screenshot: await snap(dapp, "group-no-cta"),
    };
  }
  await cta.click({ force: true });
  await dapp.waitForTimeout(1_500);
  const nameInput = dapp.locator('input[placeholder="Weekend getaway"], input[placeholder*="getaway"]').first();
  await safeFill(nameInput, `QA-${Date.now().toString().slice(-5)}`);
  const memberInput = dapp.locator('input[placeholder="0x..."]').first();
  await safeFill(memberInput, QA_COUNTERPARTY);
  const addBtn = dapp.locator('button[aria-label="Add member"]').first();
  if (await addBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await addBtn.click();
  await snap(dapp, "group-form-filled");
  const submit = dapp.locator('button:visible:not([disabled])').filter({ hasText: /^Create Group$/i }).last();
  if (!(await submit.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return { name, status: "red", notes: "Create Group submit not visible", screenshot: await snap(dapp, "group-no-submit") };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "group");
  await dapp.waitForTimeout(5_000);
  const groupCard = await dapp.locator("text=/QA-|Group #\\d|active/i").first().isVisible({ timeout: 3_000 }).catch(() => false);
  const txHash = txFromText((await dapp.locator("body").textContent().catch(() => "")) ?? "");
  return {
    name,
    status: txHash || groupCard ? "green" : "red",
    txHash,
    notes: txHash ? "tx captured" : groupCard ? "group card visible" : "no proof",
    screenshot: await snap(dapp, "group-final"),
  };
}

// ──────────────────────────────────────────────────────────────────
async function driveClaimLink(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Claim Link";
  // /app/claim-link route appears merged into /app/send with One/Many toggle.
  // Use Many mode (which is the claim-link mode per the screenshot).
  await dapp.goto(`${VERCEL_URL}/app/claim-link`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // Click "Many" toggle if visible — switches to claim-link / send-by-link mode.
  const manyToggle = dapp.locator("button").filter({ hasText: /^Many$/i }).first();
  if (await manyToggle.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await manyToggle.click();
    await dapp.waitForTimeout(1_500);
  }
  await snap(dapp, "claim-link-mode-many");
  // After Many → "Send by link" form. Pick "Anyone" (open link, no email).
  const anyoneBtn = dapp.getByRole("button", { name: /Anyone\s+Open link/i }).first();
  if (await anyoneBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await anyoneBtn.click({ force: true });
    await dapp.waitForTimeout(800);
  }
  // Fill amount — placeholder "10.00" or "0.00".
  const amount = dapp.locator('input[placeholder="10.00"], input[placeholder="0.00"]').first();
  await safeFill(amount, "0.1");
  await snap(dapp, "claim-link-amount");
  // Click "Create link" — should be enabled now.
  const submit = dapp.locator("button:visible:not([disabled])").filter({ hasText: /^Create link$|^Create Link$/i }).first();
  if (!(await submit.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return { name, status: "red", notes: "Create-link not enabled", screenshot: await snap(dapp, "claim-link-disabled") };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "claim-link");
  await dapp.waitForTimeout(8_000);
  // Success: URL surfaced as a/text containing /c/ or /claim/.
  const claimUrl = await dapp.locator('a[href*="/claim/"], a[href*="/c/"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  const bodyText = (await dapp.locator("body").textContent().catch(() => "")) ?? "";
  // Look for URL pattern in text body (Storefront/Crowdfund pattern: vercel.app/<path>/...).
  const urlMatch = bodyText.match(/blank-omega-jade\.vercel\.app\/(claim|c)\/[\w-]+/);
  const txHash = txFromText(bodyText);
  const fallbackUrl = urlMatch ? urlMatch[0] : null;
  return {
    name,
    status: claimUrl || fallbackUrl || txHash ? "green" : "red",
    txHash,
    shareUrl: claimUrl ?? fallbackUrl ?? undefined,
    notes: claimUrl ? `URL: ${claimUrl}` : fallbackUrl ? `URL (text): ${fallbackUrl}` : txHash ? "tx captured" : "no proof",
    screenshot: await snap(dapp, "claim-link-final"),
  };
}

// ──────────────────────────────────────────────────────────────────
async function driveStorefront(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Storefront Listing";
  await dapp.goto(`${VERCEL_URL}/app/sell`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // Fixed price mode (default).
  // Product title input — placeholder "Hand-bound notebook (signed)".
  const title = dapp.locator('input[placeholder*="Hand-bound" i], input[placeholder*="notebook" i]').first();
  await safeFill(title, `QA Listing ${Date.now().toString().slice(-5)}`);
  // Description.
  const desc = dapp.locator('textarea').first();
  await safeFill(desc, "QA test listing");
  // Price — placeholder "10.00".
  const price = dapp.locator('input[placeholder="10.00"], input[placeholder="0.00"]').first();
  await safeFill(price, "0.5");
  // Delivery — optional.
  const delivery = dapp.locator('input[placeholder*="@yourhandle" i], input[placeholder*="telegram" i]').first();
  if (await delivery.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await safeFill(delivery, "QA test delivery");
  }
  await snap(dapp, "storefront-form-filled");
  const submit = dapp.locator('button:visible:not([disabled])').filter({ hasText: /^Create listing$|^Publish$|^List$/i }).first();
  if (!(await submit.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return { name, status: "red", notes: "Create-listing button not enabled — form gate", screenshot: await snap(dapp, "storefront-disabled") };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "storefront");
  await dapp.waitForTimeout(4_000);
  if (await dapp.locator("text=/Submitting on-chain|Awaiting confirmation|Creating/i").first().isVisible({ timeout: 1_000 }).catch(() => false)) {
    await drainPopups(ctx, extId, known, "storefront-late");
    await dapp.waitForTimeout(10_000);
  }
  // "Listing live" success state renders the URL as plain text + Copy link
  // button. Match both <a href> and plain-text URL patterns.
  const shopUrl = await dapp.locator('a[href*="/shop/"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  const bodyText = (await dapp.locator("body").textContent().catch(() => "")) ?? "";
  const urlMatch = bodyText.match(/blank-omega-jade\.vercel\.app\/shop\/\d+\/\d+/);
  const listingLive = /Listing live/i.test(bodyText);
  const txHash = txFromText(bodyText);
  const fallbackUrl = urlMatch ? urlMatch[0] : null;
  return {
    name,
    status: shopUrl || fallbackUrl || listingLive || txHash ? "green" : "red",
    txHash,
    shareUrl: shopUrl ?? fallbackUrl ?? undefined,
    notes: shopUrl ? `URL: ${shopUrl}` : fallbackUrl ? `URL (text): ${fallbackUrl}` : listingLive ? "Listing live banner" : txHash ? "tx captured" : "no proof",
    screenshot: await snap(dapp, "storefront-final"),
  };
}

// ──────────────────────────────────────────────────────────────────
async function driveCrowdfund(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>): Promise<FeatureResult> {
  const name = "Crowdfund Campaign";
  await dapp.goto(`${VERCEL_URL}/app/fundraise`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await dapp.waitForTimeout(3_500);
  // Title — placeholder "Save the bees fund".
  const title = dapp.locator('input[placeholder*="Save the bees" i], input[placeholder*="bees fund" i]').first();
  await safeFill(title, `QA Campaign ${Date.now().toString().slice(-5)}`);
  // Description.
  const desc = dapp.locator('textarea').first();
  await safeFill(desc, "QA test campaign");
  // Funding goal — placeholder "500.00" or "0.00".
  const goal = dapp.locator('input[placeholder="500.00"], input[placeholder="0.00"]').first();
  await safeFill(goal, "10");
  // Duration default 7 days.
  await snap(dapp, "crowdfund-form-filled");
  const submit = dapp.locator('button:visible:not([disabled])').filter({ hasText: /^Launch campaign$|^Launch$|^Publish$/i }).first();
  if (!(await submit.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return { name, status: "red", notes: "Launch button not enabled — form gate", screenshot: await snap(dapp, "crowdfund-disabled") };
  }
  await submit.click();
  await drainPopups(ctx, extId, known, "crowdfund");
  await dapp.waitForTimeout(4_000);
  if (await dapp.locator("text=/Submitting on-chain|Awaiting confirmation|Creating/i").first().isVisible({ timeout: 1_000 }).catch(() => false)) {
    await drainPopups(ctx, extId, known, "crowdfund-late");
    await dapp.waitForTimeout(10_000);
  }
  // "Campaign live" success state renders the URL as plain text.
  const fundUrl = await dapp.locator('a[href*="/fund/"]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
  const bodyText = (await dapp.locator("body").textContent().catch(() => "")) ?? "";
  const urlMatch = bodyText.match(/blank-omega-jade\.vercel\.app\/fund\/\d+\/\d+/);
  const campaignLive = /Campaign live/i.test(bodyText);
  const txHash = txFromText(bodyText);
  const fallbackUrl = urlMatch ? urlMatch[0] : null;
  return {
    name,
    status: fundUrl || fallbackUrl || campaignLive || txHash ? "green" : "red",
    txHash,
    shareUrl: fundUrl ?? fallbackUrl ?? undefined,
    notes: fundUrl ? `URL: ${fundUrl}` : fallbackUrl ? `URL (text): ${fallbackUrl}` : campaignLive ? "Campaign live banner" : txHash ? "tx captured" : "no proof",
    screenshot: await snap(dapp, "crowdfund-final"),
  };
}

// ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!existsSync(RABBY_EXT_DIR) || !existsSync(RABBY_PROFILE_DIR)) {
    console.error("FATAL: Rabby ext or profile missing");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`QA batch v2 · ${VERCEL_URL} · output: ${OUT}`);

  const ctx = await chromium.launchPersistentContext(RABBY_PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${RABBY_EXT_DIR}`,
      `--load-extension=${RABBY_EXT_DIR}`,
      "--no-sandbox",
    ],
  });

  let extId = "";
  for (let i = 0; i < 30; i++) {
    const sw = ctx.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (sw) { extId = sw.url().split("/")[2]; break; }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!extId) { console.error("FATAL: SW didn't register"); await ctx.close(); process.exit(2); }

  const home = await ctx.newPage();
  await home.goto(`chrome-extension://${extId}/index.html`).catch(() => {});
  await home.waitForTimeout(2_000);
  await unlockRabby(home, RABBY_PASSWORD);
  await dismissRabbyWhatsNew(home);
  await switchRabbyAccount(home, extId, QA_PERSONA);

  const dapp = await ctx.newPage();
  await dapp.goto(`${VERCEL_URL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await dapp.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.waitForTimeout(3_500);
  const known = new Set<Page>(ctx.pages());

  // Connect if needed.
  for (let i = 0; i < 6; i++) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 1_500 }).catch(() => false)) break;
    const next = dapp.locator("button").filter({ hasText: /^Next/i }).first();
    if (!(await next.isVisible({ timeout: 1_500 }).catch(() => false))) break;
    await next.click({ force: true }).catch(() => {});
    await dapp.waitForTimeout(1_000);
  }
  const landed = await dapp.locator("text=/Good afternoon|Total Balance|FHE Protected/i").first().isVisible({ timeout: 5_000 }).catch(() => false);
  if (!landed) {
    const card = dapp.locator('[data-testid="wallet-choice-existing"]');
    if (await card.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await card.locator("button").filter({ hasText: /Rabby/i }).first().click({ force: true });
      await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "rabby-connect", 30_000, { chainName: CHAIN_NAME });
      await waitAndConfirmRabbyPopup(ctx, extId, known, OUT, "rabby-siwe", 20_000);
    }
  }
  console.log(`✓ Connected on ${CHAIN_NAME}, starting batch v2\n`);
  await ensureWalletChain(dapp, ctx, extId, known);
  await dapp.evaluate((chainId) => localStorage.setItem("blank:active_chain_id", String(chainId)), CHAIN_ID);
  await dapp.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await dapp.waitForTimeout(2_500);

  const features: Array<(dapp: Page, ctx: BrowserContext, extId: string, known: Set<Page>) => Promise<FeatureResult>> = [
    driveStealth,
    driveInheritance,
    driveProof,
    driveBusinessInvoice,
    drivePaymentRequest,
    driveGroup,
    driveClaimLink,
    driveStorefront,
    driveCrowdfund,
  ];
  const requestedFeatures = (process.env.QA_FEATURES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const selectedFeatures = requestedFeatures.length
    ? features.filter((fn) => requestedFeatures.some((name) => fn.name.toLowerCase().includes(name)))
    : features;

  for (const fn of selectedFeatures) {
    try {
      const r = await fn(dapp, ctx, extId, known);
      const tag = r.status === "green" ? "🟢" : r.status === "red" ? "🔴" : "⚪";
      console.log(`${tag} ${r.name.padEnd(22)} ${r.notes}${r.txHash ? "  tx=" + r.txHash.slice(0, 10) + "…" : ""}`);
      results.push(r);
    } catch (e) {
      const r: FeatureResult = { name: fn.name, status: "red", notes: (e as Error).message.slice(0, 200), screenshot: "" };
      console.log(`🔴 ${r.name.padEnd(22)} EXCEPTION: ${r.notes}`);
      results.push(r);
    }
  }

  const md = [
    `# QA batch v2 (live Vercel, desktop, ${CHAIN_NAME}, Rabby)`,
    `Generated: ${new Date().toISOString()}`,
    `Chain: ${CHAIN_NAME} (${CHAIN_ID})`,
    ``,
    `## Per-feature results`,
    ``,
    `| Feature | Status | Tx hash | Share URL | Notes |`,
    `|---|---|---|---|---|`,
    ...results.map((r) => {
      const tag = r.status === "green" ? "🟢 green" : r.status === "red" ? "🔴 red" : "⚪ skipped";
      const tx = r.txHash ? `[${r.txHash.slice(0, 10)}…](${EXPLORER_URL}/tx/${r.txHash})` : "—";
      const url = r.shareUrl ? r.shareUrl : "—";
      return `| ${r.name} | ${tag} | ${tx} | ${url} | ${r.notes} |`;
    }),
    ``,
    `## Summary`,
    `- 🟢 green: ${results.filter((r) => r.status === "green").length}`,
    `- 🔴 red: ${results.filter((r) => r.status === "red").length}`,
    `- ⚪ skipped: ${results.filter((r) => r.status === "skipped").length}`,
  ].join("\n");
  writeFileSync(resolve(OUT, "REPORT.md"), md);
  console.log(`\n✓ Report: ${resolve(OUT, "REPORT.md")}`);

  await ctx.close();
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(99); });
