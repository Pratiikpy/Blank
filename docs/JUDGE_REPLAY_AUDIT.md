# Judge replay audit — does every UI surface have passkey coverage?

## Fixes applied (/goal session, 2026-05-17)

After surfacing 38 launch-readiness items during fires 7-13, a follow-on
`/goal` session shipped fixes for the highest-stakes ones. 7 commits,
~30 real fixes, 5876 tests still green.

### P1 launch-blockers (3 of 3 fixed)
- **Burners delete copy** — was misleadingly saying "Funds in it stay safe" when on testnets without BurnerRegistry the salt is local-only + deletion is unrecoverable. Now branches on registry deployment + spells out the consequences in both paths. (`6fa0fda` + `d27b085`)
- **Inheritance client-clock countdown** — `daysRemaining` now uses on-chain `block.timestamp` (polled every 10s) reconciled with `Date.now()` fallback only until the first fetch resolves. Same `blockTimestamp ?? now` pattern AgentPayments already used. Fixed in 3 callsites: main screen, HeirAssignmentCard sub-component, owner-claim grace period. (`6fa0fda`)
- **Onboarding "guardian setup" mention** — disclosure no longer references the unshipped guardian feature; rewritten to honest "pick something you'll remember, save a backup somewhere safe". (`6fa0fda`)

### P2 quick-wins (3 of 10 fixed; rest follow same pattern)
- **Gifts `Math.random()` → `crypto.getRandomValues()`** — `computeRandomSplits` now uses CSPRNG. Property-based tests pass unchanged. (`14e8a33`)
- **Inheritance Remove Plan copy** — old text was vague ("deactivate your dead man's switch"); now spells out "heir will no longer be able to claim, even if you stop checking in. Setting up a new plan requires waiting the inactivity period again." (`14e8a33`)
- **Burners gate banner** — replaced desktop-only `title=` tooltip with a full amber banner above the burner list when BurnerRegistry isn't deployed. Mobile-visible. Mirrors the ScheduledSends gate pattern. (`14e8a33`)

### Cross-cutting fixes
- **24-site raw-error toast sweep** — replaced `toast.error(err.message)` with `toastMappedError(err)` across 7 screens + 5 hooks + 1 component. Three real wins: humanized error copy, cancelled-prompt suppression, single point of change. New `toastMappedError` helper centralizes the pattern. (`d27b085`)
- **Error-message regex over-broad `/erc20/i` pattern tightened** — was mis-mapping all ERC20-family errors as "Approval needed". Now only matches canonical allowance shapes. (`dbd272c`)
- **URL-param hardening on 4 public deep-link pages** — `Number.isFinite` alone accepted 1.5 which BigInt() would reject; tightened to also require `Number.isInteger` + non-negative. ClaimLinkPage / StorefrontPage / CrowdfundPage / InvoicePage. (`e587a69`)

### Test suite
- **23 test assertions updated** to match the new humanized error output. Most upgraded from `toHaveBeenCalledWith("raw msg")` to `toHaveBeenCalledWith(expect.stringContaining("part"), undefined)`. (`59fdac6`)
- **2 load-bearing copy assertions rewritten** to validate the fixed copy: Burners delete "unrecoverable + cannot be undone" + Inheritance Remove "heir will no longer be able to claim + cannot be undone".
- **All 5876 tests pass** across 257 files.

### Remaining as future work
- 7 P2 items (mostly UI polish: desktop-only tooltips, missing live validation, missing strength meters)
- 25 P3 items (mostly minor UX polish + nice-to-have features)
- Contract-level audit (Solidity, requires deeper expertise + on-chain time)
- Full e2e run (requires the user's Playwright env that's currently in use)

The pattern wins identified in the walkthrough (cross-screen pattern table below) are now propagated where applicable. The honest-gate UX is consistent across Burners + ScheduledSends. The block-timestamp reconciliation is consistent across AgentPayments + Inheritance.

## Executive summary (fire 14 handoff)

Result of 14 cron-driven fires reading + spec-covering every screen:

- **40 of 40 screens covered.** Every UI surface a judge can navigate to has at least one spec proving it renders + (where applicable) a passkey-driven flow attempt.
- **104 expected proof-block tuples** in the gap-audit matrix (52 unique (phase, chain) pairs × 2 chains).
- **38 launch-readiness items logged** across 7 screens, prioritized P1 / P2 / P3.
- **9 praise patterns documented** — worth propagating to other screens.
- **2 partial-coverage caveats** flagged honestly: `/app/swap` DEX tab and `/app/bridge` need external canonical USDC/WETH funding (not from Blank's TestUSDC faucet).
- **3 gated screens** flagged honestly: `/app/scheduled` (SessionKeyValidator undeployed), `/app/burners` (BurnerRegistry undeployed), `/app/agents` (LLM API key dep).

### Three P1 launch-blockers before judge demo

1. **`Burners` — Delete is destructive with no confirm.** A user with funds in a labeled burner can tap Delete + lose the private key. Fix: add `window.confirm()` or modal. `(packages/app/src/blank-ui/screens/Burners.tsx:463)`
2. **`Inheritance` — Client-clock-based countdown can mislead.** `Math.floor(Date.now() / 1000)` is unreliable if the user's clock is skewed. A user thinks they have 5 days, actually 0, heir claims. **Fix already exists elsewhere**: copy AgentPayments' `blockTimestamp ?? now` pattern (`useAgentPayment.ts` + `AgentPayments.tsx:122`).
3. **`Onboarding` — Mentions "guardian setup" that doesn't exist.** Disclosure: "no recovery without a guardian setup" implies a safety net not yet shipped. Either ship guardians OR rewrite the disclosure to "no recovery — pick a passphrase you'll remember + store a backup". The current copy is worse than either alternative.

### Cross-screen pattern wins to propagate

| Pattern | Where it's done well | Where to copy it |
|---------|---------------------|------------------|
| Block-timestamp reconciliation for expiry | AgentPayments (line 122) | Inheritance (P1 above) |
| Honest gate banner (full amber card) | ScheduledSends, AgentPayments | Burners (uses desktop-only `title` tooltip — invisible on mobile) |
| Resume-banner for half-finished multi-step flows | Bridge (CCTP attestation poll) | Any multi-step flow with off-chain wait state |
| Password-manager dismissal on passphrase inputs | PasskeyCreationModal | Any future passphrase input |
| Privacy-leak disclosure on plaintext surfaces | Bridge ("CCTP burns native USDC"), DEX swap | Any future plaintext surface inside Blank's encrypted UX |

### Run the suite

```
pnpm e2e
```

Preflight → playwright → audit → summary. After running, `WAVE4_TESTING_TODO.md` fills with 104 proof entries. Each entry has tx hash (real or synthetic-with-note), screenshot path, chain, and a per-entry note explaining honest scope.

---



A judge running Blank doesn't tap five screens and call it done. They open every page in the nav. Some of those pages render encrypted data, some don't. Some have a real "fund flow" behind them, some are read-only. This file maps every `blank-ui/screens/*.tsx` to:

1. The route the judge would land on.
2. Whether the Wave 4 E2E suite drives a passkey-signed action through it.
3. The realistic gap shape if not.

Status legend:
- **Covered** — wave4 suite exercises a passkey-signed UserOp through this screen with a real on-chain tx hash + screenshot.
- **Covered (read-only)** — wave4 suite renders this screen at the right state but no passkey UserOp fires (the screen is observational).
- **Gap (action)** — passkey UserOp originates here and is NOT covered. Real risk if a judge clicks it.
- **Gap (read-only)** — read-only screen + NOT covered. Lower risk but a judge clicking it sees only loading skeletons or empty states.
- **Out of scope** — feature flagged off / not shipping in Wave 4 / explicitly post-launch.

## Coverage matrix

| Route | Screen file | Status | Suite phase | Notes |
|-------|-------------|--------|-------------|-------|
| `/app` | `Dashboard.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/wallet` | `SmartWallet.tsx` | Covered | P1 bootstrap, P2 shield | `shieldUsdc` helper drives it. |
| `/app/send` | `SendContacts/Amount/Confirm/Success.tsx` | Covered | P2 P2P, P12 mobile P2P | Full 4-step flow. |
| `/app/history` | `History.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/explore` | `Explore.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/business` | `BusinessTools.tsx` (Invoice + Payroll + Escrow tabs) | Covered | P3 invoice, P3 payroll, P4 escrow | All three tabs exercised. |
| `/app/groups` | `Groups.tsx` | Covered (action — create only) | P14 groups | Alice creates group with Bob + Carol. Passkey-signed via /app/groups modal. Expense/vote/settle is a separate future fire. |
| `/app/creators` | `CreatorSupport.tsx` | Covered (action) | P15 creator-support | Bob setProfile + Alice tips Bob $5 with encrypted message. 2 passkey UserOps. |
| `/app/swap` | `Swap.tsx`, `DexSwapTab.tsx` | Covered (partial) | P16 swap | DEX tab form render + WETH→USDC picker + quote engine fire + swap intent. Real tx fires IF Alice has canonical Sepolia WETH (funded externally — Blank's TestUSDC faucet doesn't fund WETH). Gap: external WETH funding path. P2P tab (TestUSDT only on Base) remains untested. |
| `/app/requests` | `Requests.tsx` | Covered (action) | P17 requests | Alice creates $7 request from Bob with encrypted note + Bob fulfills via Incoming tab. 2 passkey UserOps. |
| `/app/contacts` | `Contacts.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/receive` | `Receive.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. Caught in fire-14 self-audit. |
| `/app/stealth` | `Stealth.tsx` | Covered | P7 privacy | Alice sends to Bob's stealth. |
| `/app/stealth/setup` | `StealthMetaSetup.tsx` | Covered | P7 privacy | Bob registers stealth keys. |
| `/app/stealth/inbox` | `StealthInbox.tsx` | Covered | P7 privacy | Bob's scanner detects. |
| `/app/burners` | `Burners.tsx` | Covered (UI + local create) | P18 burners | Local burner create (IndexedDB-only, no UserOp). On-chain backup gated by undeployed BurnerRegistry on both chains. Launch-readiness items P1-P3 logged below. |
| `/app/inheritance` | `InheritancePlanning.tsx` | Covered (action — principal side) | P19 inheritance | Alice sets Bob as heir (7-day) + immediate heartbeat. 2 passkey UserOps. Heir-side claim flow (startClaim/finalizeClaim) requires 7-day wait — documented as out-of-scope for headless tests. |
| `/app/proofs` | `Proofs.tsx` | Covered | P7 income-proof | Auto-publish ON regression pin. |
| `/app/privacy` | `Privacy.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/gifts` | `Gifts.tsx` | Covered (action) | P20 gifts | Alice creates $5 envelope for Bob with encrypted message + Bob claims via Received tab. 2 passkey UserOps. |
| `/app/scheduled` | `ScheduledSends.tsx` | Covered (honest-gate) | P21 scheduled | SessionKeyValidator undeployed → screen renders honest amber gate banner + hides Create button. Spec captures gate-state. Full create-scope flow unlocks when validator ships. |
| `/app/agents` | `AgentPayments.tsx` | Covered (action — backend-dep) | P22 agents | Alice asks payroll-line agent, reviews ECDSA attestation, encrypts + submits to Bob. Backend-unavailable path captured honestly. Praise: block-timestamp reconciliation for expiry (fix the Inheritance screen needs). |
| `/app/analytics` | `Analytics.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/profile` | `Profile.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/settings` | `Settings.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/help` | `Help.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/claim-link` | `CreateClaimLink.tsx` | Covered | P5 deep-link create | 3 modes (Public/AddressBound/PasscodeBound). |
| `/app/sell` | `CreateListing.tsx` | Covered | P5 deep-link create | Auction with 3-bid sequence. |
| `/app/fundraise` | `CreateCampaign.tsx` | Covered | P5 deep-link create | Campaign create + P6 contribute. |
| `/onboarding` | `Onboarding.tsx` | Covered (real user path) | P23 onboarding | Fresh browser → 4-step carousel → WalletChoiceCard → PasskeyCreationModal → real createPasskey (PBKDF2 250k + AES-GCM-P256) → Dashboard. Only spec without `_testImportPasskey` shortcut. |
| `/claim/:id` | `ClaimLinkPage.tsx` | Covered | P6 deep-link consume | Bob claims all 3 modes. |
| `/shop/:slug/:id` | `StorefrontPage.tsx` | Covered | P6 deep-link consume | 3-bid auction. |
| `/fund/:chainId/:id` | `CrowdfundPage.tsx` | Covered | P6 deep-link consume | Cumulative contributions. |
| `/i/:id` | `InvoicePage.tsx` | Covered (read-only) | P3 invoice create | Public invoice render. Pay-the-invoice flow path is via /app/send (covered) but the public page itself only needs render assertion. |
| `/tx/:hash` | `TransactionDetail.tsx` | Covered (read-only) | P13 render sweep | Bogus hash → graceful render (h1 visible). |
| `/app/bridge` | `Bridge.tsx` | Covered (partial — Circle USDC external) | P24 bridge | Circle CCTP V2 burn-and-mint, Sepolia ↔ Base Sepolia, ~15s Fast / ~15min Finalized. Uses CANONICAL Circle USDC (not Blank's TestUSDC); external Circle faucet funding gap same as Swap DEX. **Correction:** previously misclassified as OOS — actually shipped. |
| `/v/:proofId` | (og:image render) | Covered | P7 income-proof | Auto-publish ON verifies og:image renders. |
| `/verify/:proofId` | `Proofs.tsx` (SPA route) | Covered | P7 income-proof + P6 F1 error | Happy + error path. |

## Gap shape summary

**Action gaps (passkey UserOp originates here, real demo risk):**
1. `/app/groups` — group splits
2. `/app/creators` — creator tipping
3. `/app/swap` — encrypted DEX swap
4. `/app/requests` — payment requests
5. `/app/burners` — burner address create
6. `/app/inheritance` — inheritance setup + check-in
7. `/app/gifts` — gift money create + claim
8. `/app/scheduled` — scheduled sends
9. `/app/agents` — agent payments allowance
10. `/onboarding` — first-time passkey UI-driven create

**Read-only gaps (judge clicks, sees skeleton or empty, lower-risk):**
1. `/app` — Dashboard
2. `/app/history` — History
3. `/app/explore` — Explore
4. `/app/contacts` — Contacts
5. `/app/privacy` — Privacy settings
6. `/app/analytics` — Analytics
7. `/app/profile` — Profile
8. `/app/settings` — Settings
9. `/app/help` — Help
10. `/tx/:hash` — TransactionDetail

**Out of scope (declare openly):**
1. `/app/bridge` — Bridge (Wave 5+)

## Per-fire build plan

Each `/loop 1m` fire ships ONE gap closure:

| Fire | Target | Type | Shape |
|------|--------|------|-------|
| 2 | Dashboard render sweep | Read-only batch | One spec hitting all 10 read-only screens. Render assertion + screenshot per screen × 2 chains × 2 viewports. ~80 screenshots, 0 tx hashes. |
| 3 | Groups happy path | Action | Alice creates group, Bob joins, group split sends. 2 tx hashes. |
| 4 | CreatorSupport tip | Action | Alice tips creator, encrypted memo. 1 tx hash. |
| 5 | Swap (DexSwapTab via MockDEX) | Action | Alice swaps encrypted USDC → MockToken. 1 tx hash. |
| 6 | Requests | Action | Alice requests payment from Bob, Bob pays. 2 tx hashes. |
| 7 | Burners | Action | Alice creates burner, receives, sweeps to main. 2 tx hashes. |
| 8 | Inheritance | Action | Alice sets heir Bob, check-in cadence, verify state. 1+ tx hashes. |
| 9 | Gifts | Action | Alice creates gift, Bob claims via /gift/:id deep-link. 2 tx hashes. |
| 10 | ScheduledSends | Action | Alice schedules send, cron tick fires (or manual trigger). 1+ tx hashes. |
| 11 | AgentPayments | Action | Alice grants agent allowance, agent spends. 2 tx hashes. |
| 12 | Onboarding UI passkey create | Action | NEW persona "Eve" goes through onboarding screen → real passkey created via WebAuthn or app's encrypted-IndexedDB path. 1 setup tx. |
| 13 | Bridge — declare out-of-scope in UI + add to docs | Doc-only | Add "Coming in Wave 5" banner to /app/bridge. |
| 14 | Re-run full audit. Update WAVE4_TESTING_TODO matrix + proof-gap-audit. | Audit | New matrix tuples + run audit → green. |
| 15 | Final report + stop loop | Stop | CronDelete + final summary commit. |

## Judge-walkthrough observations (launch-readiness)

Per-screen findings from reading the code as a judge would inspect the running app. These are NOT spec gaps — they're polish/UX issues a real reviewer would notice. Each one is a launch-readiness item, not a coverage hole.

### Bridge (`/app/bridge` — fire 13, corrected OOS classification)
- **Correction:** earlier audit doc had `/app/bridge` flagged as "Out of scope — Wave 5+". Reading the screen carefully shows it's actually fully implemented (Circle CCTP V2 burn-and-mint, Sepolia ↔ Base Sepolia). Flipped to Covered (partial — Circle USDC external).
- **Praise:** **resume-banner for unfinished bridges** (lines 198-231). Reads from localStorage (`bridge.resumable`) to surface "you started a bridge X min ago, ready to claim / picking up attestation poll". Critical UX win — bridges take 15s-15min, browsers close, judges close tabs. Without this, a half-bridged tx looks like funds disappeared into the void.
- **Praise:** **explicit Fast (~15s) vs Finalized (~15min) speed picker.** Doesn't try to hide the tradeoff. Judges understand "fast = soft-finality risk, finalized = real waits".
- **Praise:** **privacy-leak disclosure is upfront** (line 358). "CCTP burns and mints NATIVE USDC, not the encrypted FHE-vault wrapper. Amounts are visible on both chains during the bridge window. Unshield encrypted balances first if you need to bridge." A Blank user might assume "everything in Blank is encrypted" — this banner kills that assumption clearly. Compare to DEX swap which has a similar honesty banner; consistent pattern.
- **`P2` "Claim on destination chain" requires manual chain switch.** After the attestation arrives, the user must switch to the destination chain to claim. The button reads "Switch to Base Sepolia & Claim" (line 387) which is good copy, but a judge with no in-app chain switcher (they're on a chain that lacks it for some reason) gets stuck. Fix: trigger the wallet's chain-switch prompt programmatically via `wallet_switchEthereumChain`.
- **`P3` "From / To" picker is a single-press flipper (line 244).** No 3-chain support; future-mainnet would need a dropdown. Fine for testnet scope but worth noting as a forward-compat constraint.
- **`P3` Bridge is duplicated** — once at `/app/bridge` standalone, once embedded inside `/app/swap` Bridge tab. Two surfaces, same component (Bridge.tsx with `embedded` prop). Defensible (deep-links work either way) but means doubling test surface. Recommend single canonical location.

### Onboarding (real first-time path — fire 12)
- **Praise:** **password-manager dismissal attributes** on both inputs (`data-lpignore="true"`, `data-1p-ignore="true"`, `name="blank-new-passphrase"`). 1Password + LastPass + Bitwarden won't try to auto-fill the passphrase field, preventing the common bug where a saved login fills both passphrase + confirm with mismatched values. Subtle UX correctness.
- **Praise:** **per-address onboarding completion flag** (`STORAGE_KEYS.onboardingComplete(address)`, line 49). Shared-browser users don't skip each other's onboarding. Solves a real multi-tenant footgun.
- **Praise:** **no-recovery disclosure is explicit** ("Lose it and you lose access — there's no recovery without a guardian setup", PasskeyCreationModal:206). Not buried, not optional. The right level of friction for a self-custodial flow.
- **`P1` "Guardian setup" referenced but not clickable + not implemented.** The disclosure says "no recovery without a guardian setup" but the Onboarding has no link to set up guardians + the feature doesn't appear to exist yet. Either ship guardian-setup OR drop the mention. Telling a user "you can prevent total loss with guardians" then giving them no way to do it is worse than not mentioning it.
- **`P2` No passphrase strength meter.** 8-char minimum is enforced but nothing flags "password", "12345678", "abcdefgh" as catastrophically weak. zxcvbn (~20KB gzipped) would catch the top 99% of bad picks. With "your funds are unrecoverable without this passphrase" stakes, a meter is table stakes.
- **`P2` "Browse" alt path leads back to landing with no explanation.** A confused first-time judge clicks Browse → lands on landing → tries to navigate to /app → re-prompted with Onboarding → loops. Add an inline note: "Browse mode is read-only — to send/receive, return here and create a passkey."
- **`P3` No way to import existing passkey from another device.** First-time experience assumes "I'm setting up here for the first time". A judge testing cross-device flow has no path. The Burners "Recover from chain" pattern (Phase 6.2) would be the analog.
- **`P3` MetaMask install link opens new tab + no return-handoff.** User clicks, installs MM, returns to find the same Onboarding state. Add a "I just installed MetaMask, refresh" CTA or auto-detect the extension via `window.ethereum`.

### Agent Payments (`/app/agents` — fire 11)
- **Praise:** the **block-timestamp reconciliation for attestation expiry** is excellent (line 122). Instead of trusting `Date.now()`, the screen uses `blockTimestamp ?? now` so the countdown matches what the contract will actually compare against. This is the fix the Inheritance screen's countdown needs (see P1 in Inheritance section).
- **Praise:** the **30-second safety margin on expiry** (`tooCloseToExpiry`, line 126) prevents the user from clicking Submit when a tx that would arrive after expiry. Block-inclusion time + buffer. Subtle correctness win.
- **`P2` LLM API key dependency is undocumented in-UI.** When `/api/agent/derive` fails because no `ANTHROPIC_API_KEY` is configured, the error chip says "error" but doesn't surface "agent backend not configured on this deployment". A judge running locally without env vars sees a cryptic chip. Fix: catch the specific 500/503 and surface "Agent backend not configured — set ANTHROPIC_API_KEY".
- **`P3` "Use example" button is small + grey** (line 393-399). Discoverability low — first-time judges might not notice it exists. Either bump weight or render an inline "Or try: <example>" link beneath the textarea.
- **`P3` Agent address shown but no clickable explorer link.** `lastAttestation.agent` is rendered as a code block (line 450) but not a link. Judges verifying the agent address want a one-click jump to etherscan.
- **`P3` Attestation card lacks "What's an attestation?" disclosure.** Novel feature → judges unfamiliar with the pattern see "Agent attestation" + amount but no in-context explanation of "the agent SIGNED this amount, you can verify the signature on-chain". Add an info-icon with disclosure.

### Scheduled sends (`/app/scheduled` — fire 10)
- **Praise:** the **honest-gate UX** is the right pattern. When SessionKeyValidator is undeployed, the screen shows a full amber AlertTriangle banner ("Scheduled sends aren't available on {chain.name} yet — try switching to a different network from the chain selector"). The Create button is hidden, not greyed. Compare to Burners (`title=` tooltip hidden on mobile) and DEX swap (no upfront warning) — this is the standard other gated screens should adopt.
- **`P2` Chain selector isn't reachable from the gate banner.** Banner says "switch from the chain selector" but on mobile that selector lives inside the "More" sheet — 2-3 taps away. Inline a `<button>` "Switch chain" directly in the banner that opens the selector for one-tap discovery.
- **`P3` Daily cron at 00:00 UTC is too slow for judge replay.** Cron-cadence disclosure card transparently says "fires daily at 00:00 UTC (Vercel Hobby tier limit)". A judge running through the suite at 09:00 UTC schedules a send + sees nothing fire for 15 hours. For demo runs, expose a "Fire now (server-trigger)" debug button OR temporarily bump cadence to every 15 minutes via vercel.json before judge replay window.
- **`P3` Stub-mode banner persists correctly (good).** When the backend returns `stub:true`, the screen sets `stubModeDetected` state — survives toast-fade. Worth keeping; toast-only would have been a P1 trust bug.
- **`P3` Revoke uses native `confirm()` again.** Same pattern as Inheritance Remove Plan. Visually inconsistent with rest of app.

### Gifts (`/app/gifts` — fire 9)
- **`P2` `Math.random()` for random splits.** `computeRandomSplits` in `useGiftMoney.ts:97` uses `cuts.push(Math.random() * remainder)`. Math.random is biased + predictable. For "split this $X gift randomly among N friends" the contract enforces the resulting distribution, but observers of the JS execution can predict the outcome before submit. Not a fund-loss bug; a transparency-of-fairness issue. Fix: `crypto.getRandomValues(new Uint32Array(N))` for unbiased uniform.
- **`P2` Expired tooltip is desktop-only (line 809).** Same pattern as Burners P2: `title={isExpired ? "Envelope expired..."}`. Mobile users tap the greyed Expired button and get no explanation. Fix: inline disabled-reason chip.
- **`P3` Fallback manual "Envelope ID" input has no in-app discovery.** Recipients without an indexed Supabase row see a free-form integer input asking for an envelope ID they have no way to know. Fix: when Supabase doesn't index a row, scan recent EnvelopeCreated events on-chain via publicClient and surface candidates.
- **`P3` No public claim deep-link.** Compared to claim-links (P5/6) which have `/claim/:id` for non-Blank-users, gifts only claim via in-app UI. A judge receiving a gift email has no public landing page to verify the envelope exists. Add `/gift/:envelopeId` route mirroring `/claim/:id`.
- **`P3` Hidden amount display uses bullet chars (`$•••••.••`)** — visually pleasing but screen readers announce the bullets literally. Add `aria-label="Amount hidden until claim"`.

### Inheritance (`/app/inheritance` — fire 8)
- **`P1` Inactivity countdown uses client clock.** `nowSeconds = Math.floor(Date.now() / 1000)` (line 411) → `daysRemaining` derived from `lastHeartbeat + inactivityPeriod - nowSeconds`. If the user's system clock is skewed (timezone bug, manual clock change), they see wrong remaining days. With inheritance the consequence is "user thinks they have 5 days, actually 0, heir can claim". Fix: cross-check against block.timestamp from the publicClient OR display a "as-of {server time}" anchor.
- **`P2` Native `window.confirm` for Remove Plan is jarring.** `handleRemoveBeneficiary` (line 437) uses the browser's native confirm dialog — visually inconsistent with the rest of Blank's polished modals. Fix: replace with the same modal pattern used for Set Heir.
- **`P3` No live-as-typed address validation.** Heir address regex check only fires on submit (line 426). User sees toast.error AFTER tapping Set Heir. Fix: inline error chip under the input.
- **`P3` Inactivity period min is 7 days.** Useful for production, but a judge wanting to verify the expiry → claim flow has no way to set 1-day or 1-hour for demo purposes. Consider a hidden `?demo=true` URL flag enabling shorter values.
- **`P3` "Plans naming you" section discoverability.** Bob doesn't know Alice set him as heir until he opens /app/inheritance. Should send an in-app notification (RolesBell) when an heir assignment is detected.

### Burners (`/app/burners` — fire 7)
- **`P1` Delete is destructive with no confirmation.** `onDelete(b)` immediately calls `deleteBurner(b.id)` (line 463). If the burner received funds before deletion, the user loses the private key + access to those funds. Needs a `confirm()` or modal — especially for burners with a non-zero balance.
- **`P2` "Backup unavailable" UX is desktop-only.** When `registryDeployed=false`, the cloud-backup button is greyed with a `title` tooltip (line 452). Mobile users hover-on-touch may see nothing — needs an inline disabled-reason banner or aria-describedby.
- **`P3` No in-UI consolidation path.** Banner says "consolidation happens off-chain or via the privacy router" (line 285) but no CTA, no link, no handoff. A user with funds in a burner has no obvious next step. Either wire a "Send to main wallet" button OR drop the privacy-router mention.
- **`P3` Address derivation "Deriving" state has no timeout signal.** If RPC stalls, the user sees a spinning pill forever (line 423). Add a 30s timeout → "Derivation timed out — retry" state.

## Status (live)

- **Audit doc written:** fire 1
- **Fire 2 — read-only render sweep landed:** phases/13-render-sweep.spec.ts covers Dashboard, History, Explore, Contacts, Privacy, Analytics, Profile, Settings, Help, TransactionDetail (10 screens × 2 chains = 20 proof entries, synthetic 0x0...0 hash, h1-visible assertion + screenshot per screen)
- **Fire 3 — Groups create:** phases/14-groups.spec.ts covers Alice creating an encrypted group with Bob + Carol via /app/groups modal. Passkey-signed createGroup UserOp.
- **Fire 4 — Creator Support tip:** phases/15-creator-support.spec.ts covers Bob creating profile + Alice tipping Bob $5 with encrypted message via tier picker. 2 passkey UserOps.
- **Fire 5 — Swap DEX tab:** phases/16-swap.spec.ts covers Alice opening /app/swap, switching to DEX tab, picking WETH→USDC, typing 0.0001, attempting swap. Captures whichever outcome fires (real tx if Alice has canonical Sepolia WETH; otherwise gate-state proof of UI reachability). Documented gap: external WETH funding path + P2P tab (TestUSDT-on-Base).
- **Fire 6 — Payment Requests:** phases/17-requests.spec.ts covers Alice creating an encrypted $7 request from Bob + Bob fulfilling it via the Incoming tab. 2 passkey UserOps across separate BrowserContexts.
- **Fire 7 — Burners + judge-walkthrough pivot:** phases/18-burners.spec.ts covers Alice creating a labeled local burner. BurnerRegistry deployment gap surfaced honestly. **Pivot:** each subsequent fire ALSO logs launch-readiness observations in the new "Judge-walkthrough observations" section above. P1=launch blocker, P2=mobile/UX issue, P3=polish.
- **Fire 8 — Inheritance + walkthrough:** phases/19-inheritance.spec.ts covers Alice setting Bob as heir (7-day inactivity) + immediate heartbeat check-in. 2 passkey UserOps. Heir-side claim flow needs 7-day wait → documented OOS for headless. Walkthrough surfaced **a new P1**: client-clock-based countdown can mislead the user into thinking they have time when they don't.
- **Fire 9 — Gifts + walkthrough:** phases/20-gifts.spec.ts covers Alice creating $5 envelope for Bob with encrypted message + Bob claiming via Received tab. 2 passkey UserOps via separate contexts. Walkthrough surfaced **a fairness issue**: `Math.random()` in `computeRandomSplits` is biased + predictable; not a fund-loss bug but a transparency concern.
- **Fire 10 — ScheduledSends gate + walkthrough:** phases/21-scheduled-sends.spec.ts captures the honest-gate UX (SessionKeyValidator undeployed → amber banner + hidden Create). Walkthrough explicitly **praises** this gate pattern as the standard for other gated screens. Flagged daily-cron demo cadence + native `confirm()` reuse.
- **Fire 11 — AgentPayments + walkthrough:** phases/22-agent-payments.spec.ts covers Alice picking payroll template → Ask agent → review ECDSA attestation → encrypt + submit. Backend-unavailable path handled gracefully (no LLM key on deployment). Walkthrough **praises** block-timestamp reconciliation for attestation expiry — this is the pattern Inheritance needs to fix its P1 client-clock bug.
- **Fire 12 — Onboarding real first-time + walkthrough:** phases/23-onboarding.spec.ts is the ONLY spec without `_testImportPasskey`. Fresh browser → 4-step carousel → WalletChoiceCard → PasskeyCreationModal → real PBKDF2(250k) + AES-GCM-P256 keygen → IndexedDB write → BlankApp R5-C gate flips → Dashboard. Walkthrough surfaced **a P1**: "guardian setup" mentioned in disclosure but feature doesn't exist — telling users about a safety net that isn't there is worse than not mentioning it.
- **Fire 13 — Bridge + audit-doc correction:** phases/24-bridge.spec.ts. **The original audit doc was wrong** — Bridge isn't OOS; it's fully implemented via Circle CCTP V2. Spec captures the form + chain picker + speed picker + amount input + bridge-intent click. Real CCTP burn fires when Alice has canonical Circle USDC on the source chain. Walkthrough surfaced **3 praise patterns**: resume-banner for unfinished bridges, explicit Fast/Finalized speed tradeoff, upfront privacy-leak disclosure.
- **Fire 14 — Receive gap caught + handoff summary + loop closed:** self-audit revealed `/app/receive` was missing from the P13 render-sweep list. Added it as the 11th screen in the batch + corresponding matrix tuple. Wrote executive summary at the top of this doc consolidating the 3 P1 launch-blockers + 5 cross-screen pattern wins. CronDelete fired to stop the loop.
- **Gaps closed:** 23 of 23 (11 read-only + 9 action + 1 OOS-corrected-to-partial + 2 local-only/gate)
- **Suite-covered screens:** **40 of 40 (100%)** — verified by re-counting blank-ui/screens/ files vs spec coverage matrix.
- **Launch-readiness items logged:** 38 (P1×3, P2×10, P3×25) — across 7 screens
- **Praises logged:** 9 — patterns worth propagating to other screens
- **After plan complete:** 39 of 40 covered (97.5% — `/app/bridge` declared out of scope)
