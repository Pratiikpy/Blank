# Wave 4 — build tracker

Short lines. One per thing. So we don't lose track in the long build.

Format: `[status] task — short note`
Status: `✅` done · `🟡` in-progress · `⏳` pending · `❌` blocked

## Design rules (match the rest of the app)

- Containers: `glass-card-static rounded-[2rem]` with soft shadow
- Background: `#F9FAFB` light cream
- Headlines: Outfit/Inter font, `font-medium`, no all-caps unless small label
- Icons: lucide-react, contained in `rounded-2xl` colored bubble (16-20px icon, 48-64px bubble)
- Color accents: emerald=success, blue=info, amber=warning, rose=destructive, pink=gifts, slate=neutral
- Primary CTA: `h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black`
- Secondary CTA: ghost border, same height + radius
- Spacing: `p-8` for cards, `gap-3/4` for stacks, `mb-6/8` between sections
- "FHE" badges: `bg-emerald-500/10 text-emerald-600 border border-emerald-500/20`
- Mobile-first, desktop-polished — never let mobile look squished
- ZERO compromise on this — every Wave 4 screen ships at this bar

---

## Foundation (Wave 4 kickoff)

- ✅ Pulled latest references (cofhesdk, reineira, fhenix-neo)
- ✅ Spotted SDK's new `onStep` callback (PR #239) for FHE progress UI
- ✅ Set up task list

## #244 Magic Claim Links — DONE

- ✅ `ClaimLinks.sol` — bearer / email / address-bound, refund, expiry
- ✅ Domain-separated hash scheme `BLANK_CLAIM_v1`
- ✅ 10/10 contract tests
- ✅ `lib/claim-links.ts` — secret gen, hash, URL build/parse + 13 tests
- ✅ `useClaimLinks` hook — full create/claim/refund flow
- ✅ `CreateClaimLink.tsx` screen
- ✅ `ClaimLinkPage.tsx` screen (public `/claim/:chain/:id`)
- ✅ Routing wired in `App.tsx` + `BlankApp.tsx`
- ✅ ABI in `abis.ts`, address in `constants.ts`
- ✅ Deploy task `deploy-claim-links`
- ✅ Wire script `wire-claim-links.js` (whitelist + PaymentReceipts)
- ✅ Deployed Eth Sepolia: `0x9E2189149deec5e78cB2976d8DF64CAec40B12Be`
- ✅ Deployed Base Sepolia: `0x2eD78815299C2B1F2cBd2313CF763B56A0654665`

## #245 FHE loading states — DONE

- ✅ `useFhePipeline` hook — 5 SDK steps + submit + confirm
- ✅ `FhePipelineProgress` component — full + compact modes
- ✅ `cofhe-shim.encryptInputsAsync` accepts optional `onStep`
- ✅ Wired into `useClaimLinks` (both create + claim)
- ✅ 6/6 unit tests

## #246 History context labels — DONE

- ✅ `lib/history-labels.ts` — direction-aware labels for ALL 60+ activity types
- ✅ Added 3 `claim_link_*` activity types + formatters
- ✅ `useCounterpartyName` hook — contact → ENS → hex
- ✅ `HistoryRow` sub-component (lifted out of `.map()` for hooks)
- ✅ `History.tsx` refactored to use new label module
- ✅ 8/8 unit tests

## #251 E2E + screenshots — DONE

- ✅ Spec: 8 public probes (landing, pricing, roadmap, blog, /app, claim 3 variants)
- ✅ Spec: 3 auth-gated probes (dashboard, claim-link create, history)
- ✅ Spec: form interaction probe (validation + click)
- ✅ Spec: real on-chain link probe (visits real `/claim/:chain/:id`)
- ✅ Bug fixed via testing: missing-secret precedence over link-not-found
- ✅ All probes green on local dev :3000
- ✅ Real createLink Eth Sepolia tx `0xb7bf6f83...`
- ✅ Real createLink Base Sepolia tx `0x75649e97...`
- ✅ Real claimBearer Eth Sepolia tx `0x9e57040f...` (consumed link 0)
- ✅ Visual proof of 4 states: claimable / claimed / not-found / missing-secret
- ✅ Hardhat tasks: `test-claim-link-flow`, `claim-claim-link`

---

## Live links for manual smoke (until 5/15/2026)

- Eth Sepolia (fresh): `/claim/11155111/1#b.4KcQOvBV3VylKcJbuBRabimrxYDovUT0zijGBRsjCz4`
- Base Sepolia (fresh): `/claim/84532/0#b.swp21MMhlv39iOnHHjNhl6RmhgGGBHfLRVAExvRRers`

---

## Now building

- ✅ #252 Tap-to-reveal balance — ALREADY BUILT
  - `EncryptedAmount.tsx` has full pattern: tap → scramble animation → reveal → 10s countdown ring → auto-hide
  - Dashboard + Profile have an inline eye-toggle pattern that ALSO handles permit creation
  - Used everywhere balance is shown with a decrypted value
  - History rows correctly show permanent `"••••.••"` (no client-side decrypt available per row)
  - Verdict: feature exists at quality bar. No rebuild needed.

- ✅ #253 Empty states that teach
  - `EmptyState.tsx` reusable component + 5 tests
  - Applied: History (3 substates), Dashboard ActivityList, BusinessTools invoices + payroll, Burners, Contacts, Gifts received/sent, StealthInbox
  - All match design rules above (rounded-2xl bubble + Outfit font + dark CTA + tone palette)

- ✅ #254 Storefront + sealed-bid auction
  - `Storefront.sol` (3 modes: Fixed / Auction / PayWhatYouWant) + 12 contract tests
  - `useStorefront` hook + `CreateListing.tsx` + `StorefrontPage.tsx`
  - Routes: `/shop/:chainId/:listingId` (public) + `/app/sell` (auth)
  - Eth Sepolia: `0x786C85880e0FCF123D726600D9784ee88B84695b`
  - Base Sepolia: `0xeA8a38f25ECF9Cc8C9240aafb35b561D14Dfd419`

- ✅ #255 Proof of income — already built (PaymentReceipts + useQualificationProof + Verify route)

- ✅ #256 Confidential payroll
  - CSV upload + parser + live row-by-row preview added to existing payroll modal in `BusinessTools.tsx`
  - Backend (BusinessHub.runPayroll) was already shipped

- ✅ #257 Encrypted crowdfunding
  - `EncryptedCrowdfund.sol` + 7 contract tests (success path with FHE.gte verdict; failure with refunds)
  - `useCrowdfund` hook + `CreateCampaign.tsx` + `CrowdfundPage.tsx` (5 phases)
  - Routes: `/fund/:chainId/:campaignId` (public) + `/app/fundraise` (auth)
  - Eth Sepolia: `0x383B58973f7e8DC3E47D1C2f55393E2ac48b24e1`
  - Base Sepolia: `0x0F21705575e2CC83dC410AE2af6973B150a4183C`

- ✅ #247 Stealth payment scanner — already built
  - 366-line client-side scanner (useStealthInbox) with view-tag filter + ECDH match
  - 287-line sweep flow (useStealthSweep) for ERC-20 sweeps
  - Better than Vercel-cron approach: RPC providers never see match results

- ✅ #249 Encrypted escrow refactor
  - `EncryptedEscrow.sol` — fully-encrypted, NO plaintext amount field at all
  - 9/9 contract tests (happy path, dispute → arbiter, expiry refund, edge cases)
  - `useEncryptedEscrow` hook (createEscrow, markDelivered, approveRelease, disputeEscrow, arbiterDecide, claimExpiredEscrow)
  - Deployed both chains, wired to PaymentReceipts
  - Eth Sepolia: `0x4253163CfCd0cf9885333E0a7B7476d61F010feC`
  - Base Sepolia: `0x6414742D2da28eCEf06D79b82F406B6b8ab3e421`
  - Existing BusinessHub plaintext escrow kept for back-compat
- ⏳ #255 Proof of income
- ⏳ #256 Confidential payroll
- ⏳ #257 Encrypted crowdfunding

## Sprint week (BEST_VERSION_FULL_PLAN §1)

- ✅ §1.1 gitignore e2e-test-wallet.json. Scoped at `packages/contracts/.gitignore`. Verified with `git check-ignore`. History clean (never committed). Operator warning added to `tasks/fund-mm-test-wallet.ts`.
- ✅ §1.2 EncryptedEscrow no-arbiter dispute fix. `disputeEscrow` now reverts when `arbiter == 0x0`. Regression test added (10/10 tests pass). Storage layout unchanged (no struct fields touched, only runtime guard). UI guard pending (forthcoming escrow screen, deferred to §3 hooks debt).
- ✅ §1.3 Storefront fake-green test drop + auction settlement disabled (phase A). `closeAuction` now reverts with "auction settlement disabled pending fix". Existing 5/8/10 ascending test marked `.skip` (couldn't differentiate the bug). New 5/10/7 differentiating test added marked `.skip` for phase B (proper FHE-tournament impl returns charlie at $10 not dave at $7). New phase-A revert test verifies disable. Storefront tests: 12 passing, 2 pending (phase B).
- ✅ §1.4 Storefront auction phase B (all 4 steps). Step 1: storage variable. Step 2: FHE-tournament loop in `closeAuction` using `FHE.select` to track encrypted winner index alongside running max. Step 3: new `revealWinner(listingId, plaintextIdx, signature)` function mirroring `EncryptedCrowdfund.publishCloseResult`. Step 4: tests rebuilt: existing 5/8/10 ascending test re-enabled with revealWinner step, new 5/10/7 differentiating test confirms charlie at $10 wins (NOT dave at $7), new double-reveal rejection test. `claimAuctionWin` now requires `winner != 0x0`. Storefront tests: 14/14 passing, 0 pending. storage:check passes against baselines. **Storefront phase A workaround removed**: `closeAuction` now executes the proper FHE-tournament instead of reverting.
- ✅ §1.5 ClaimLinks expiry cap. Added `MAX_EXPIRY_SECONDS = 365 days` public constant (no storage slot). Range check at create rejects expirySeconds > 365 days while preserving `expirySeconds == 0` default-fallback semantics. 3 regression tests added (reject too-long, accept exactly 1 year, accept default 0). ClaimLinks tests: 13/13 passing.
- ✅ §1.7 extractEventId silent zero-fallback fix. Function now returns `number | null` instead of `0` on miss. 12 call sites across 9 hooks (useClaimLinks, useCrowdfund, useEncryptedEscrow, useStorefront, useBusinessHub x2, useExchange, useGiftMoney, useGroupSplit x2, useRequestPayment) updated to throw a "tx mined but id could not be read" error on null instead of silently routing share-links at id=0. tsc --noEmit exit=0.
- ✅ §1.6 useInheritance bricked fix. `useCofheEncryptAndWriteContract` was a stub at cofhe-shim.ts that threw "Use writeContractAsync directly with Encryptable values" on every call. useInheritance.finalizeClaim depended on it and was unusable. Migrated finalizeClaim to `unifiedWrite` (already imported in the hook), which accepts InEuint64 values directly and routes through both EOA and AA paths. Also migrated useSendPayment which used the same stub. Removed the stub entirely from cofhe-shim.ts to prevent re-introduction. Burners screen UI guard / Burners.tsx audit deferred (the screen consumes the now-working hook). tsc --noEmit exit=0.
- ✅ §1.8 cancel-defaults-to-zero at 2 sites (surgical fix only). CrowdfundPage L205 + StorefrontPage L384 both used `Number.parseInt(prompt(...) ?? "0", 10)` which silently routed cancel + empty input to refund/bid index 0 (someone else's first record). Fixed by explicit null-check + trim + non-negative-integer validation + toast.error on invalid input. The full UX redesign with `<select>` of records (per §1.8 spec) is deferred to §3 hooks debt sprint. tsc --noEmit exit=0.
- ⏳ §1.9 README marketing-shape rewrite
- 🟡 §1.10 CI uplift partial (4 of 6 checks). Added: vitest unit tests (103 tests passing), tsc typecheck for Vercel functions (api/tsconfig.json), tsc typecheck for hardhat tasks, UUPS storage layout check (`pnpm storage:check`, 19 contracts). Deferred: ESLint (no eslint config exists in packages/app; needs setup before wiring), Playwright (the `if: false` flag stays until E2E suite stability is confirmed standalone). All 4 added checks verified passing locally before CI commit.
- ✅ §1.11 TRACKED_CONTRACTS sweep. 12 → 19 contracts tracked. Added Wave 4 contracts (ClaimLinks, Storefront, EncryptedCrowdfund, EncryptedEscrow) plus 3 pre-Wave-4 missing UUPS contracts (EncryptedFlags, EventHub, TokenRegistry). Wrote 19 storage-layout baselines via `hardhat check-storage-layout --write`. Verified `--check` exits 0 against the new baselines.

---

## Links / addresses cheat-sheet

| Item | Eth Sepolia | Base Sepolia |
|---|---|---|
| ClaimLinks | `0x9E218914...0B12Be` | `0x2eD78815...0654665` |
| EventHub | `0x06F8fc38...A20eB` | `0xD764e11e...4a590` |
| Vault USDC | `0x3a587f22...AB51` | `0x789f0bC4...0ff23` |
| Deployer | `0xb860513A...c53F` | (same) |
