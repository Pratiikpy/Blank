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
// Must match the TestUSDC contract `/api/faucet/usdc` mints into —
// i.e. Blank's own TestUSDC, not Circle's FiatToken. Otherwise the
// balance probe queries the wrong token, always sees 0, and falls
// through to the rate-limited faucet endpoint.
const FAUCET_USDC_BY_CHAIN: Record<number, string> = {
  11155111: "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68",
  84532: "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a",
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
  // Type into the input as a real keyboard would. Earlier code used the
  // React 18 native-setter + dispatchEvent escape hatch, but that races
  // with React 18's render batching: the setter mutates the DOM, the
  // 'input' event fires synchronously, React schedules a state update,
  // and Playwright clicks submit a few ms later — sometimes before the
  // re-render flips `disabled={!value}` to enabled. The click then sits
  // for 5s, falls back to press("Enter"), and the form's onSubmit sees
  // value === "" (state never updated in time) and does not call
  // close(value). Modal sits until the 60s queue auto-timer fires null.
  //
  // pressSequentially() dispatches real keydown/keypress/input/keyup
  // events one char at a time, so React's onChange fires per keystroke
  // and the controlled-input state is guaranteed to be settled before
  // we attempt the submit.
  await input.click({ timeout: 5_000 }).catch(() => { /* may already be focused */ });
  await input.fill(""); // clear any residual value from a prior prompt
  await input.pressSequentially(passphrase, { delay: 15 });
  // Wait for the submit button to actually enable (React re-rendered).
  const submit = page.locator('button:visible').filter({ hasText: /^(Decrypt|Unlock)$/i }).first();
  await submit.waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForFunction(
    () => {
      const btns = Array.from(document.querySelectorAll("button"));
      const b = btns.find(
        (x) => /^(Decrypt|Unlock)$/i.test((x.textContent ?? "").trim()) && (x as HTMLElement).offsetParent !== null,
      );
      return b !== undefined && !(b as HTMLButtonElement).disabled;
    },
    null,
    { timeout: 5_000 },
  ).catch(() => undefined);
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
  // Use page.route() to intercept the /api/relay response BEFORE the
  // frontend consumes the body. Earlier `page.on('response')` + json()
  // raced with the frontend's `await res.json()` consumer and dropped
  // the body. route() does a separate fetch under the hood and gives
  // us our own copy of the body, then fulfills the original request
  // with that copy so the frontend's consumer still works.
  //
  // Both predicate and handler are saved by reference so page.unroute()
  // in the finally block can find them — earlier code created a new
  // arrow function each call and silently failed to unregister, which
  // leaked handlers across multiple drainPromptsAndCaptureTx calls
  // inside the same spec (P19 second-leg heartbeat hit this).
  let interceptedTxHash: string | null = null;
  let relayInFlight = 0;
  const routePredicate = (url: URL): boolean =>
    /\/api\/relay(\b|\/|\?)/.test(url.toString());
  const routeHandler = async (route: { fetch: () => Promise<{ status: () => number; headers: () => Record<string, string>; text: () => Promise<string> }>; fulfill: (opts: { status: number; headers: Record<string, string>; body: string }) => Promise<void>; continue: () => Promise<void> }): Promise<void> => {
    relayInFlight += 1;
    try {
      const fetched = await route.fetch();
      const status = fetched.status();
      const headers = fetched.headers();
      const raw = await fetched.text();
      if (raw && raw.includes("0x") && status >= 200 && status < 300) {
        const m = raw.match(/"hash"\s*:\s*"(0x[0-9a-fA-F]{64})"/);
        if (m && /"status"\s*:\s*"success"/.test(raw)) {
          interceptedTxHash = m[1];
        }
      }
      await route.fulfill({ status, headers, body: raw });
    } catch {
      await route.continue();
    } finally {
      relayInFlight -= 1;
    }
  };
  await page.route(routePredicate, routeHandler);
  // Baseline: hashes already on screen at the time we hooked the route.
  // P5 fired a shieldUsdc before iteration 1 of the claim-link create;
  // its tx anchor lingered on the dashboard / activity surface, which
  // satisfied terminateOn before drainPassphrasePrompts could fill the
  // new prompt — drain exited early, readTxHashFromSuccess returned
  // the stale hash, readShareUrl couldn't find /claim/ (because the
  // real flow never ran), and the test threw inside iteration 1.
  const baselineHashes = new Set<string>(
    await page.evaluate(() => {
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a[href*="/tx/0x"]'))) {
        const m = (a as HTMLAnchorElement).href.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
        if (m) seen.add(m[1].toLowerCase());
      }
      return Array.from(seen);
    }).catch(() => []),
  );
  const txVisible = async () => {
    if (interceptedTxHash !== null) return true;
    const onScreen = await page.evaluate(() => {
      const out: string[] = [];
      for (const a of Array.from(document.querySelectorAll('a[href*="/tx/0x"]'))) {
        const m = (a as HTMLAnchorElement).href.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
        if (m) out.push(m[1].toLowerCase());
      }
      return out;
    }).catch(() => [] as string[]);
    return onScreen.some((h) => !baselineHashes.has(h));
  };
  try {
    // expectAtLeast: 0 because cofhe permits may already be warmed by an
    // earlier UserOp in the same browser session (e.g. P5 second/third
    // claim-link create after the first, P7 income-proof after the
    // preceding shieldUsdc). The terminateOn check still proves the tx
    // fired; if it didn't, readTxHashFromSuccess will throw.
    // Multi-tx flows (createClaimLink, createListing, createCampaign)
    // need two signed UserOps: first setVaultApproval, then the actual
    // create call. An eager terminateOn that returned true on the FIRST
    // relay receipt broke them — drain exited before the second prompt
    // appeared and the create tx never fired. The gap-aware predicate
    // below requires the interceptedTxHash to remain stable for STABLE_MS
    // after no further prompts have appeared, so multi-tx flows get
    // their full sequence while single-tx flows still exit promptly.
    // STABLE_MS must be long enough to bridge the LONGEST gap between
    // any two consecutive prompts inside a single flow. On Base Sepolia
    // createClaimLink has 3 prompts:
    //   1. Sign approvePlaintext  (UserOp → relay tx → interceptedTxHash set)
    //   2. Authorize decryption   (cofhe permit signTypedData — no relay)
    //   3. Sign createLink        (UserOp → relay)
    // The gap between #2 close and #3 open is the cofhe encryption window
    // — observed ~17s on Base Sepolia testnet. 40s covers that plus
    // margin for slow public-RPC ticks without making single-tx specs
    // pay an unbounded wait.
    const STABLE_MS = 40_000;
    let stableSince: number | null = null;
    let lastSeenHash: string | null = null;
    const txStable = async (): Promise<boolean> => {
      if (interceptedTxHash === null) {
        stableSince = null;
        lastSeenHash = null;
        return false;
      }
      if (lastSeenHash !== interceptedTxHash) {
        // New tx surfaced — reset the stability timer.
        lastSeenHash = interceptedTxHash;
        stableSince = Date.now();
        return false;
      }
      const stableFor = Date.now() - (stableSince ?? Date.now());
      // Also require that there is currently no passphrase prompt visible
      // — a new prompt that hasn't been filled yet means another tx is
      // coming and we should not exit.
      const modalOpen = await page
        .locator('input[type="password"][placeholder*="assphrase" i]:visible')
        .first()
        .isVisible()
        .catch(() => false);
      return stableFor >= STABLE_MS && !modalOpen;
    };
    await drainPassphrasePrompts(page, passphrase, {
      windowMs: opts.windowMs ?? 360_000,
      gapMs: 150_000,
      expectAtLeast: 0,
      terminateOn: txStable,
    });
    // After drainPassphrasePrompts exits, give in-flight relay calls a
    // little more time to land before falling back to DOM scraping.
    const waitDeadline = Date.now() + 60_000;
    while (Date.now() < waitDeadline && interceptedTxHash === null && relayInFlight > 0) {
      await page.waitForTimeout(1_000);
    }
    if (interceptedTxHash) return interceptedTxHash;
    return await readTxHashFromSuccess(page, opts.readTimeoutMs ?? 90_000);
  } finally {
    await page.unroute(routePredicate, routeHandler).catch(() => undefined);
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
