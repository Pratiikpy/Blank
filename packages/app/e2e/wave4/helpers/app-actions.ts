import type { Page } from "@playwright/test";

// ──────────────────────────────────────────────────────────────────
//  Wave 4 app-action helpers. Small wrappers around the UI flows that
//  multiple phases reuse: shield USDC into the FHE vault, drive the
//  passphrase prompt, wait for a relay tx hash.
//
//  Each helper is opinionated about what state it requires + leaves
//  behind, so callers don't have to re-derive selectors.
// ──────────────────────────────────────────────────────────────────

/** Skip-if-already-funded faucet drip. Deterministic personas reuse the
 *  same addresses across runs, so the faucet's per-address 5/hour limit
 *  blocks re-runs hard. Probe the on-chain USDC balance via a public RPC
 *  first; only call /api/faucet/usdc when balance is under the threshold.
 *  Returns a synthetic 0x-hash when the drip was skipped (callers only
 *  need "balance is now sufficient" downstream). */
const FAUCET_USDC_BY_CHAIN: Record<number, string> = {
  11155111: "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const FAUCET_RPC_BY_CHAIN: Record<number, string> = {
  11155111: "https://ethereum-sepolia.publicnode.com",
  84532: "https://sepolia.base.org",
};
const FAUCET_SKIP_THRESHOLD = 50_000_000n; // 50 USDC (6 decimals)

export async function faucetUsdcIfNeeded(
  page: Page,
  address: string,
  chainId: number,
  baseURL: string,
): Promise<string> {
  const usdc = FAUCET_USDC_BY_CHAIN[chainId];
  const rpc = FAUCET_RPC_BY_CHAIN[chainId];
  if (usdc && rpc) {
    try {
      const data = `0x70a08231${address.replace(/^0x/, "").padStart(64, "0")}`;
      const r = await page.request.post(rpc, {
        data: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: usdc, data }, "latest"] },
        timeout: 15_000,
      });
      if (r.ok()) {
        const b = (await r.json()) as { result?: string };
        if (b.result) {
          const bal = BigInt(b.result);
          if (bal >= FAUCET_SKIP_THRESHOLD) {
            return `0x${"0".repeat(64)}`; // synthetic — already funded
          }
        }
      }
    } catch {
      /* fall through to the faucet call */
    }
  }
  const res = await page.request.post(`${baseURL}/api/faucet/usdc`, {
    data: { address, chainId },
    timeout: 60_000,
  });
  if (!res.ok()) {
    throw new Error(`Faucet failed: ${res.status()} (body: ${await res.text().catch(() => "?")})`);
  }
  const body = (await res.json()) as { ok: boolean; hash?: string; error?: string };
  if (!body.ok) throw new Error(`Faucet ok=false: ${body.error ?? "unknown"}`);
  return body.hash!;
}

/** Type the passphrase into the modal prompt + submit. The app uses
 *  the PassphrasePrompt component which renders an input + a Submit
 *  button when the user has to sign a UserOp. */
export async function enterPassphrase(page: Page, passphrase: string, timeoutMs = 120_000): Promise<void> {
  // The prompt overlay is conditionally rendered; wait up to `timeoutMs`
  // for it to appear. Pre-existing tests use placeholder="Passphrase" on
  // the input.
  // :visible filter — multiple stale modals can be in the DOM if the
  // caller hit a retry loop above.
  const input = page.locator('input[type="password"][placeholder*="assphrase" i]:visible').first();
  await input.waitFor({ state: "visible", timeout: timeoutMs });
  // Set value via the React 18 native setter + dispatch input event —
  // see shieldUsdc for the rationale (modal re-render races detach
  // Playwright element handles mid-type). Submit button label is
  // "Unlock" (NOT Submit/Sign).
  await input.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, passphrase);
  const submit = page.locator('button:visible').filter({ hasText: /^Unlock$/i }).first();
  await submit.click({ timeout: 5_000 }).catch(() => input.press("Enter"));
}

/** #377: drive ALL passphrase prompts that surface within `windowMs` of
 *  the call. FHE send flows trigger up to 3 prompts back-to-back:
 *    1. permit warmup (SDK self-permit signTypedData)
 *    2. approve UserOp (PaymentHub spend authorisation)
 *    3. sendPayment UserOp (the encrypted-amount call itself)
 *
 *  Resolves when either the tx-hash success page surfaces, the window
 *  elapses with no further prompts, or `terminateOn` returns true.
 *  Each prompt is filled with the same passphrase. */
export async function drainPassphrasePrompts(
  page: Page,
  passphrase: string,
  opts: { windowMs?: number; gapMs?: number; expectAtLeast?: number; terminateOn?: () => Promise<boolean> } = {},
): Promise<number> {
  const windowMs = opts.windowMs ?? 360_000;
  // gapMs is the OUTER patience budget per prompt: how long we tolerate
  // between consecutive prompts before giving up. Encryption-to-approve
  // can be 5-30s and approve-to-sendPayment can be 30-90s on Sepolia,
  // so we need 60s+ here. The INNER tick is short (see below).
  const gapMs = opts.gapMs ?? 60_000;
  const TICK_MS = 1_500;
  const expectAtLeast = opts.expectAtLeast ?? 1;
  const deadline = Date.now() + windowMs;
  let count = 0;
  let lastSeenAt = Date.now();
  while (Date.now() < deadline) {
    // #377: poll terminateOn concurrently with the modal-wait so a fast
    // success path (SendSuccess auto-redirects after ~8s) doesn't miss
    // its window while we're blocked waiting for a prompt that will
    // never come. Short TICK_MS keeps the loop responsive.
    if (opts.terminateOn && (await opts.terminateOn())) break;
    const modalVisible = await page
      .locator('input[type="password"][placeholder*="assphrase" i]:visible')
      .first()
      .isVisible()
      .catch(() => false);
    if (modalVisible) {
      try {
        await enterPassphrase(page, passphrase, TICK_MS);
        count += 1;
        lastSeenAt = Date.now();
      } catch {
        // Modal disappeared between visibility check and type — keep polling.
      }
      continue;
    }
    // No modal visible. Check whether we've exceeded `gapMs` since the
    // last interaction; if so, give up.
    if (Date.now() - lastSeenAt > gapMs) break;
    await page.waitForTimeout(TICK_MS);
  }
  if (count < expectAtLeast) {
    throw new Error(`drainPassphrasePrompts: only ${count} prompt(s) handled; expected at least ${expectAtLeast}`);
  }
  return count;
}

/** #377: convenience wrapper for the common pattern "click action → drain
 *  every passphrase prompt the action fires → capture the tx-hash
 *  explorer link". Many FHE flows (gift, request, tip, ...) trigger 2-3
 *  back-to-back passphrase prompts; this combines `drainPassphrasePrompts`
 *  with `readTxHashFromSuccess` and shares the same tx-hash poll between
 *  them so the drainer exits the instant the success page surfaces.
 *
 *  Also intercepts the /api/relay response so flows that update the UI
 *  in-place (createInvoice, createEscrow, setHeir, createGift) capture
 *  the on-chain tx hash even when the success surface never renders a
 *  /tx/ explorer link. relay.ts returns `{hash, status: "success", ...}`
 *  on a confirmed UserOp — we capture that hash and prefer it over the
 *  DOM-source fallback in readTxHashFromSuccess. */
export async function drainPromptsAndCaptureTx(
  page: Page,
  passphrase: string,
  opts: { windowMs?: number; readTimeoutMs?: number } = {},
): Promise<string> {
  let interceptedTxHash: string | null = null;
  const responseHandler = async (response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => {
    const url = response.url();
    if (!/\/api\/relay(\?|$)/.test(url)) return;
    if (!response.ok()) return;
    try {
      const body = (await response.json()) as { hash?: string; status?: string };
      if (
        body.status === "success" &&
        typeof body.hash === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(body.hash)
      ) {
        interceptedTxHash = body.hash;
      }
    } catch {
      // body might not be JSON or already consumed — ignore.
    }
  };
  page.on("response", responseHandler);
  const txVisible = async () =>
    interceptedTxHash !== null ||
    (await page.locator('a[href*="/tx/0x"]').first().count()) > 0;
  try {
    await drainPassphrasePrompts(page, passphrase, {
      windowMs: opts.windowMs ?? 360_000,
      expectAtLeast: 1,
      terminateOn: txVisible,
    });
    if (interceptedTxHash) return interceptedTxHash;
    return await readTxHashFromSuccess(page, opts.readTimeoutMs ?? 90_000);
  } finally {
    page.off("response", responseHandler);
  }
}

/** Poll for an on-chain tx hash in the DOM. Tries multiple sources so
 *  the helper isn't brittle to per-feature success UIs:
 *   1. Anchor with href containing "/tx/0x..."  (SendSuccess, Gifts)
 *   2. Anchor with href to etherscan/basescan "/tx/0x..." (some flows)
 *   3. Text content matching "0x" + 64 hex chars (success cards, toasts)
 *   4. data-testid="tx-hash" element's text or href
 *
 *  Features whose success UI doesn't include any of these (invoice
 *  create just toasts + refreshes a list, escrow create same) should
 *  not call readTxHashFromSuccess directly — they should wrap with
 *  try/catch + synthetic hash via the drainPromptsAndCaptureTx
 *  wrapper, which the spec already does. */
export async function readTxHashFromSuccess(page: Page, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const hashRe = /0x[0-9a-fA-F]{64}/;
  while (Date.now() < deadline) {
    // Source 1+2: any anchor whose href contains a 0x-prefixed tx hash.
    const anyTxHref = await page
      .locator('a[href*="0x"]:visible')
      .evaluateAll((nodes) =>
        nodes
          .map((n) => (n as HTMLAnchorElement).href)
          .filter((h) => /\/tx\/0x[0-9a-fA-F]{64}/.test(h) || /etherscan|basescan/.test(h)),
      )
      .catch(() => [] as string[]);
    for (const h of anyTxHref) {
      const m = h.match(/\/tx\/(0x[0-9a-fA-F]{64})/) ?? h.match(/(0x[0-9a-fA-F]{64})/);
      if (m) return m[1];
    }
    // Source 3: visible text content matching a hash (e.g., success card
    // shows "Tx: 0xabc..."). Scope to common containers to avoid scanning
    // the whole DOM.
    const txText = await page
      .locator('[data-testid="tx-hash"], .tx-hash, code, .font-mono')
      .first()
      .textContent()
      .catch(() => null);
    if (txText) {
      const m = txText.match(hashRe);
      if (m) return m[0];
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error("No tx-hash explorer link surfaced within timeout");
}

/** Shield plaintext USDC into the FHE vault. The actual shield UX is
 *  on the Dashboard (/app), NOT SmartWallet (/app/wallet) — the shield
 *  input has aria-label="Shield amount" and the submit button has
 *  aria-label="Deposit to vault" with the text "Deposit". An earlier
 *  version of this helper navigated to /app/wallet looking for a
 *  "Shield" button that doesn't exist there. */
export async function shieldUsdc(
  page: Page,
  amountUsdc: string,
  passphrase: string,
): Promise<{ txHash: string }> {
  await page.goto("/app");

  // Wait for the smart account to be RESOLVED before any interaction.
  // Dashboard renders a fresh useSmartAccount() instance on mount; the
  // shield onClick handler routes to the AA passphrase-prompt branch
  // only when smartAccount.status === "ready". Clicking before ready
  // falls through to the EOA path which (for a passkey-only user)
  // returns null silently without prompting — exactly the bug Phase 2
  // surfaced after Phase 1 worked.
  //
  // Wait for the Dashboard Shield section to be present (stable label).
  // Also wait for smartAccount.status === "ready" — without this the
  // shield onClick falls through to the EOA path which returns null
  // silently for passkey-only users (no passphrase prompt). Use the
  // "Get Test USDC" button as the readiness signal: it's disabled
  // when handleMint can't run (no contracts loaded, etc.) and enables
  // once useMint is wired (which requires effectiveAddress = AA).
  await page
    .locator("text=/DEPOSIT TO PRIVATE WALLET/i")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .locator('button[aria-label="Get test USDC"]:not([disabled])')
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => undefined);
  // Extra buffer — useShield's internal smartAccount.status check can
  // be timing-sensitive even after the visible signals.
  await page.waitForTimeout(8_000);

  // Dashboard renders TWO inputs with aria-label="Shield amount" —
  // one inside the desktop section (line 373) and one inside the
  // mobile-friendly bottom block (line 779). For desktop viewport,
  // only one is visible. .first() may pick the hidden mobile one,
  // and fill() then times out on the visibility check. Use :visible
  // pseudo to skip the hidden duplicate.
  const amountInput = page
    .locator('input[aria-label="Shield amount"]:visible')
    .first();
  await amountInput.waitFor({ state: "visible", timeout: 30_000 });
  await amountInput.fill(amountUsdc);

  // The submit button has aria-label="Deposit to vault" and visible
  // text "Deposit". Use aria-label — it's the stable contract.
  // Wait for the button to BECOME enabled (it's disabled when the
  // shieldAmount state is empty/zero). Without this wait, Playwright's
  // fill() may not have triggered React's state update by the time
  // click() fires — the click would race with a still-disabled button
  // OR fire the early-return-on-empty-amount toast inside the onClick
  // handler, never reaching the passphrase prompt.
  // The button resolves visible+present but click sometimes hangs on
  // actionability — possibly a transient stability issue or hidden
  // overlay. dispatchEvent skips the actionability check and just
  // fires the React onClick handler directly. The handler still
  // validates the amount internally, so we don't lose any safety.
  // Same duplicate-element story as the input — there are TWO
  // Deposit-to-vault buttons. Filter by visibility. dispatchEvent
  // bypasses Playwright's actionability check.
  //
  // RETRY LOOP: the shield onClick handler routes through smartAccount
  // .status — if status is still "loading" at click time, the call
  // falls through to the EOA branch (no passphrase prompt). The AA
  // resolver is an async RPC roundtrip after every component mount,
  // so we may need a couple of attempts. After each click, poll for
  // the passphrase modal; if it doesn't appear within 5s, click again.
  const shieldBtn = page.locator('button[aria-label="Deposit to vault"]:visible').first();
  // :visible filter — if multiple Shield clicks queued during the AA
  // resolver's "loading" state, multiple PassphrasePrompt modals can
  // mount briefly. .first() without :visible can pick the stale hidden
  // one, then .fill() times out on the editability check.
  const passphraseInput = page.locator('input[type="password"][placeholder*="assphrase" i]:visible').first();
  await shieldBtn.waitFor({ state: "visible", timeout: 10_000 });

  let modalAppeared = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await shieldBtn.dispatchEvent("click");
    try {
      await passphraseInput.waitFor({ state: "visible", timeout: 5_000 });
      modalAppeared = true;
      break;
    } catch {
      // Wait for the smartAccount resolver to finish, then retry.
      await page.waitForTimeout(3_000);
    }
  }
  if (!modalAppeared) {
    throw new Error(
      "shieldUsdc: passphrase prompt never appeared after 6 click attempts. " +
        "Likely smartAccount.status stayed in 'loading' — check that the Dashboard " +
        "greeting shows the truncated AA address and useEffectiveAddress is working.",
    );
  }

  // Modal is open. fill() / pressSequentially / keyboard.type all hang
  // here — the React modal queues multiple resolvers and rapidly
  // mounts/unmounts inputs, detaching Playwright's element handles
  // mid-type. Set the value directly via the React 18 native setter,
  // then dispatch an "input" event so React's onChange fires. This is
  // the same trick Cypress uses for re-render-heavy controlled inputs.
  await passphraseInput.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, passphrase);
  const submit = page
    .locator('button:visible')
    .filter({ hasText: /^Unlock$/i })
    .first();
  await submit
    .click({ timeout: 5_000 })
    .catch(() => passphraseInput.press("Enter").catch(() => undefined));

  // The shield flow surfaces a success toast ('Shielded X USDC via
  // smart wallet!'). The earlier draft of this helper tried to race
  // success vs an error toast — but the `[role="status"]` selector
  // matched all sorts of unrelated alerts (incl. stale toasts from a
  // prior test fixture) and resolved the race to "error" instantly.
  // Just wait for the literal success-toast text; if shield really
  // fails the test times out at 180s with a clear cause.
  // 180s budget because the AA UserOp roundtrip (encrypt + relay +
  // bundler + mine + confirm) can take 60–120s under Sepolia load.
  await page
    .locator("text=/Shielded .* USDC/i")
    .first()
    .waitFor({ state: "visible", timeout: 180_000 });
  return { txHash: `0x${"0".repeat(64)}` };
}
