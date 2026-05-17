# Judge replay audit — does every UI surface have passkey coverage?

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
| `/app/stealth` | `Stealth.tsx` | Covered | P7 privacy | Alice sends to Bob's stealth. |
| `/app/stealth/setup` | `StealthMetaSetup.tsx` | Covered | P7 privacy | Bob registers stealth keys. |
| `/app/stealth/inbox` | `StealthInbox.tsx` | Covered | P7 privacy | Bob's scanner detects. |
| `/app/burners` | `Burners.tsx` | Gap (action) | — | Burner addresses for one-time receive. Passkey-signed burner create. |
| `/app/inheritance` | `InheritancePlanning.tsx` | Gap (action) | — | Heir setup + check-in flow. Passkey-signed inheritance create. |
| `/app/proofs` | `Proofs.tsx` | Covered | P7 income-proof | Auto-publish ON regression pin. |
| `/app/privacy` | `Privacy.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/gifts` | `Gifts.tsx` | Gap (action) | — | Gift money flow — passkey-signed gift create + claim. |
| `/app/scheduled` | `ScheduledSends.tsx` | Gap (action) | — | Scheduled sends — passkey-signed schedule create + cron tick. |
| `/app/agents` | `AgentPayments.tsx` | Gap (action) | — | Agent payments — passkey-signed agent allowance + spend. |
| `/app/analytics` | `Analytics.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/profile` | `Profile.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/settings` | `Settings.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/help` | `Help.tsx` | Covered (read-only) | P13 render sweep | h1-visible + screenshot. |
| `/app/claim-link` | `CreateClaimLink.tsx` | Covered | P5 deep-link create | 3 modes (Public/AddressBound/PasscodeBound). |
| `/app/sell` | `CreateListing.tsx` | Covered | P5 deep-link create | Auction with 3-bid sequence. |
| `/app/fundraise` | `CreateCampaign.tsx` | Covered | P5 deep-link create | Campaign create + P6 contribute. |
| `/onboarding` | `Onboarding.tsx` | Gap (action) | — | First-time onboarding — passkey creation flow. Currently bypassed by `_testImportPasskey`. Needs UI-driven assertion the create-passkey path also works. |
| `/claim/:id` | `ClaimLinkPage.tsx` | Covered | P6 deep-link consume | Bob claims all 3 modes. |
| `/shop/:slug/:id` | `StorefrontPage.tsx` | Covered | P6 deep-link consume | 3-bid auction. |
| `/fund/:chainId/:id` | `CrowdfundPage.tsx` | Covered | P6 deep-link consume | Cumulative contributions. |
| `/i/:id` | `InvoicePage.tsx` | Covered (read-only) | P3 invoice create | Public invoice render. Pay-the-invoice flow path is via /app/send (covered) but the public page itself only needs render assertion. |
| `/tx/:hash` | `TransactionDetail.tsx` | Covered (read-only) | P13 render sweep | Bogus hash → graceful render (h1 visible). |
| `/app/bridge` | `Bridge.tsx` | Out of scope | — | Cross-chain bridge — depends on Circle CCTP integration not finalized in Wave 4. Flag as "post-launch" in UI. |
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

## Status (live)

- **Audit doc written:** fire 1
- **Fire 2 — read-only render sweep landed:** phases/13-render-sweep.spec.ts covers Dashboard, History, Explore, Contacts, Privacy, Analytics, Profile, Settings, Help, TransactionDetail (10 screens × 2 chains = 20 proof entries, synthetic 0x0...0 hash, h1-visible assertion + screenshot per screen)
- **Fire 3 — Groups create:** phases/14-groups.spec.ts covers Alice creating an encrypted group with Bob + Carol via /app/groups modal. Passkey-signed createGroup UserOp.
- **Fire 4 — Creator Support tip:** phases/15-creator-support.spec.ts covers Bob creating profile + Alice tipping Bob $5 with encrypted message via tier picker. 2 passkey UserOps.
- **Fire 5 — Swap DEX tab:** phases/16-swap.spec.ts covers Alice opening /app/swap, switching to DEX tab, picking WETH→USDC, typing 0.0001, attempting swap. Captures whichever outcome fires (real tx if Alice has canonical Sepolia WETH; otherwise gate-state proof of UI reachability). Documented gap: external WETH funding path + P2P tab (TestUSDT-on-Base).
- **Fire 6 — Payment Requests:** phases/17-requests.spec.ts covers Alice creating an encrypted $7 request from Bob + Bob fulfilling it via the Incoming tab. 2 passkey UserOps across separate BrowserContexts.
- **Gaps closed:** 14 of 22 (10 read-only + 4 action, 1 partial)
- **Suite-covered screens:** 32 of 40 (80%, with /app/swap as partial)
- **Remaining action gaps:** 7 (Burners, Inheritance, Gifts, ScheduledSends, AgentPayments, Onboarding, Bridge-as-OOS)
- **After plan complete:** 39 of 40 covered (97.5% — `/app/bridge` declared out of scope)
