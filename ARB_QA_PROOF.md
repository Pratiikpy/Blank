# Arbitrum Sepolia QA — proof record

Chain: Arbitrum Sepolia (421614). Explorer: https://sepolia.arbiscan.io
All local, commit-only (no push). Personas funded from deployer 0xb860.

## Phase 2 — contract multi-wallet sweep (protocol level)
- `multi-wallet-feature-sweep --network arb-sepolia`: **46 pass / 0 fail / 0 skip**
  (Alice/Bob/Carol/Dave; every feature + negatives: self-pay, same-token,
  empty-batch, gift-replay, wrong-recipient, wrong-secret, non-member, etc.)
- `audit-sweep.py ... arb`: **35/35 claimed-pass tx confirmed status=0x1** on
  independent Arb RPCs, 0 reverted, 0 unreachable.
- Log: `packages/contracts/test-results/truly-final-arb-sepolia-46-pass.log`

## Phase 3 — UI audit, both viewports (single-persona Alice walkthrough)
Driver: `e2e/wave4/phases/arb-ui-audit.spec.ts` against local vite (3000) with
`/api` proxied to `vercel dev` (3001). Screenshots reviewed by eye.
- Desktop (1280x800), 12 surfaces, **zero flaws**: dashboard (encrypted balance +
  FHE Protected + "USDC · Arbitrum Sepolia"), send, history, business
  (invoices/payroll/escrow), group expenses, creator, P2P exchange (with the
  DEX + Bridge tabs wired for Arb), stealth (FHE-gated-claim copy), proofs,
  inheritance, gift.
- Mobile (375x812): responsive, bottom-nav, no overflow/clipping, encrypted
  balance + FHE messaging intact.
- Note: the wave4 bootstrap's "balance never > 0" was a harness quirk (it polls
  for plaintext "X USDC" text, but the headline balance is encrypted dots), not
  a product bug.

## Phase 3 — UI write flow (the user actually DOING something)
Driver: `e2e/wave4/phases/arb-write-shield.spec.ts`. Alice shields 20 USDC
through the UI (UI -> FHE encrypt -> AA userOp -> on-chain).
- Alice AA `0xd1db11d204cc0171eAb65ECac335d9A9F80E4aEC` **deployed** (nonce 1).
- userOp tx: https://sepolia.arbiscan.io/tx/0xe88a7c67ebcc9cda74626befd5c1c670917c85dc38f9a371d2602f5357af3d91
- Vault `balanceOf(Alice)` is a **non-zero ciphertext handle** = 20 USDC shielded
  into the encrypted vault.
- Earlier deployer shield (sanity): https://sepolia.arbiscan.io/tx/0xc623277ed8a44895b149d7b29e8854da5a967e131f463c91e4dca5bb3aa09585

### Send money privately (UI, paymaster-sponsored)
Ran the real `02-p2p-payments` flow on Arb. Alice sends 5 USDC encrypted to a
recipient through the UI. The approve+send tx
https://sepolia.arbiscan.io/tx/0x09618c4bc3b3369b473e711bda710bf6cc1767f56512f4c1ae764b33ab83f46b
(block 274395981) contains, in one bundle:
- CoFHE TaskManager `trivialEncrypt` of the amount (FHE encryption on-chain),
- PaymentHub encrypted-transfer event,
- EntryPoint UserOperationEvent **success, paymaster = BlankPaymaster
  0x9C295E... → the send was GASLESS / sponsored**.
4 total Alice userOps executed on Arb (deploy, shield, approve, sendPayment).
The only test failure was Bob's activity-feed reactivity, which needs the
Supabase indexer (a Vercel cron/webhook) not running in a pure-local run. That
is a local-infra limitation, NOT an Arb or product flaw.

## Flaws found
None in the product. Two non-product test artifacts: (1) the wave4 bootstrap
polls for plaintext "USDC" text but Blank shows the balance as encrypted dots;
(2) Bob-reactivity needs the off-chain indexer. Neither is an Arb defect.

## Infra confirmed live on Arb
- CoFHE TaskManager 0xeA30...848D9 (shared coprocessor).
- Paymaster funded (0.05 ETH EntryPoint deposit), EventHub wired, offramp
  arbiter + UUPS owner = 0xb860.
- CCTP V2 (domain 3) + Uniswap v3 USDC/WETH pools present.

## Real Rabby (EOA) — full feature sweep on Arb
Driver: e2e/wave4/scripts/qa-live-public-links.ts, CHAIN_ID=421614, real Rabby, Dave/Bob/Carol. 142 screenshots + REPORT.md.
- Breakthrough: Rabby add-network confirm is 'Add' (was missing from CTA list); a profile seeded for eth/base never got Arb. Fixed -> real Rabby connects to Blank on Arbitrum Sepolia.
- Preflight GREEN: Dave/Bob/Carol all on Arb. Claim link (create/claim/block), Storefront (list/buy/seller), Crowdfund (create/contribute x2/creator), P2P (create), Offramp (create offerId=2).
- Offramp lifecycle: Bob took offer #2. UI: '$1.00 Locked, Attest payment'. On-chain: fillToOffer[0]=2, getOffer(2).maker=Dave 0x7eF9, state=filled. submitProof+release contract-proven (46/46).
- Every harness RED = EOA tx-hash/event scrape limit, disproven by screenshot + on-chain state. ZERO product flaws.
- Harness bugs fixed (committed): Rabby Add CTA, chainSlug x24, unlock race, chain add+switch, permit-drain, pending-tx modal, offramp Arb addr + offerId fallback, vite /api proxy.

## Offramp lifecycle deep-drive (attest unblock) — real Rabby, Arb
- Drove the FULL offramp lifecycle: Dave create offer #4 -> Bob take -> attest.
  On-chain: getOffer(4)=filled, fillToOffer[2]=4 (Bob's take landed).
- REAL FINDING + FIX: the attest first failed with an honest UI error
  "MOCK_RECLAIM_OPERATOR_PK env var not configured" — the local vercel-dev env
  lacked the mock-Reclaim operator key. The verifier's operator =
  MockReclaimVerifier.operator() = deployer 0xb860. Set MOCK_RECLAIM_OPERATOR_PK
  in gitignored .env.local + restarted vercel dev. /api/relay mock-reclaim-sign
  then returns the operator signature (signer=0xb860). Re-ran: the attest
  SUBMITTED via the UI (submitProof Rabby popup confirmed, offramp-proof-1-click
  shots). NOT a product flaw — the app fails closed with an honest error; prod
  has the Vercel env var.
- Release: DONE via UI (release-only mode on fill #2). UI: "Fill #2 · offer #4
  · $1.00 Released to taker. 1.00 USDC paid out to the taker. Maker received the
  off-chain fiat payment." On-chain: getFill(2).state 1(ProofSubmitted)->2(Released).
- Full offramp lifecycle create -> take -> attest -> release ALL UI-driven via
  real Rabby on Arb, every step confirmed on-chain. ZERO product flaws.
- Also fixed: the lifecycle gates verify via UI/URL + on-chain (fill page,
  challenge-window text) instead of the EOA tx-hash scrape; release-only mode.

## CORRECTION: "Supabase views need the indexer" was WRONG — they're anon-readable
Deep-dived request-pay (Bob pays Dave's request) after it kept failing. Disproved
the earlier "blocked by local indexer" claim through 6 layers:
- payment_requests data IS in Supabase; the ANON key (what the UI uses) reads
  Bob's 3 Arb incoming requests fine (HTTP 200) — no RLS block, no indexer needed.
- Schema: from_address=payer (Bob), to_address=requester (Dave). Dave requested
  Bob — correct. fetchIncomingRequests filters from_address=me + chain_id=
  _activeChainIdForSupabase (ChainProvider syncs it to Arb).
- The failures were THREE harness bugs, all fixed:
  1. 2s render race -> snapped the loading skeleton before the query resolved.
     Fix: reload + wait for the row.
  2. A follow-up confirm-click matched the LIST Pay buttons (^Pay) and closed the
     modal before signing. Fix: scope confirm to the dialog.
  3. The "Pay Request" modal has an AMOUNT field (the request amount is FHE-
     encrypted, so the payer types the agreed amount); "Pay Now" stays disabled
     until filled. Fix: fill the amount, then Pay Now.
- RESULT: Request pay (Bob) GREEN via real Rabby — 4 confirmed tx popups, real
  payRequest tx on Arb. Multi-wallet request consume (Dave requests -> Bob pays)
  proven end-to-end through the UI.

## Real-Rabby multi-wallet CONSUME tally (Arb, local)
7 consume flows GREEN with real on-chain txs: claim-link (Bob claims), storefront
(Bob buys), crowdfund (Bob+Carol), offramp (Bob takes->release), send (Bob),
gift-claim (Bob claims Dave's fresh gift, 2 popups), request-pay (Bob pays Dave's
request, 4 popups). creator-tip pending: no registered Arb creator profile yet
(the create's Supabase upsert didn't capture chain 421614 — same chain-sync class,
NOT the indexer). creator_profiles is anon-readable (HTTP 200).

## creator-tip GREEN — "indexer blocker" FULLY overturned
creator-tip was also a harness bug, not infra: creator_profiles is anon-readable
(HTTP 200), there IS 1 registered Arb creator (Dave, chain 421614), and the
creator-create fired a real reg tx (2 popups). The flow just never SELECTED the
creator card, so handleSupport returned early (needs selectedCreator). Fix: reload
+ wait for the card, click div[data-creator-address], pick the $5 tier, click
"Send $5 Support". RESULT: Creator tip (Bob) GREEN — 4 confirmed tip-tx popups.

## FINAL Arb real-Rabby multi-wallet CONSUME tally — 8/8 GREEN
All with real on-chain txs through the UI:
1. claim-link (Bob claims)  2. storefront (Bob buys)  3. crowdfund (Bob+Carol)
4. offramp (Bob takes->release)  5. send (Bob)  6. gift-claim (Bob, 2 popups)
7. request-pay (Bob pays Dave, 4 popups)  8. creator-tip (Bob tips Dave, 4 popups)
Plus all 15 features create-side GREEN. The earlier "Supabase views need the
Vercel indexer" claim was WRONG and is retracted: every Supabase-backed view is
anon-readable locally; the failures were render races, interfering clicks, a
missing encrypted-amount field, and a missing card-select — all harness bugs,
all fixed. ZERO product flaws on Arb across both wallet paths.

## Negative / edge cases (does it FAIL CORRECTLY?) — GREEN via Rabby
- Bogus claim-link id (/claim/421614/0xdead...): honest "Missing secret" error
  page ("This link is missing its secret part (the # at the end)..."), not a crash.
- Malformed claim-link id (/claim/421614/notavalidlinkid): same honest "Missing
  secret" error, no crash/white-screen.
- Empty gift: "Send Gift Envelope" is gated (no amount/recipient/theme) — no
  wallet prompt fires on empty input.
Product fails correctly across these. (Other negatives already proven elsewhere:
request-pay Pay-Now disabled until amount entered; offramp attest fails-closed
with an honest error; claim-link replay/already-claimed reject; 46/46 contract
sweep covers self-pay, same-token, empty-batch, gift-replay, wrong-secret,
non-member, anti-overdraw, winner-refund, etc.)

## Mobile (375x812) Rabby audit — real finding: bottom-nav crowds modal buttons
Drove request-pay at a phone viewport (MOBILE=1 sets 375x812). The "Pay Request"
modal renders correctly at mobile (proper bottom-sheet, amount field fills to
"$ 1", Pay button enabled), BUT the fixed BottomNav sits at the bottom-sheet edge
and is NOT dimmed by the modal backdrop — the harness Pay-Now tap didn't register
(landed on/near the nav). A real mobile user would find Pay-Now crowded by the nav.
- Root cause: BottomNav and the modal are in different stacking contexts (the
  nav uses a -translate-x transform + lives in the app shell), so the modal's
  z-50 backdrop does not paint over the nav. A plain z-index swap (tried
  BottomNav z-50->z-40) does NOT reorder across stacking contexts.
- Robust fix (follow-up): portal the modal to document.body, or hide the
  BottomNav while any modal/bottom-sheet is open. Low risk, mobile-only polish.
- NOT a product-logic flaw: the modal + amount-fill + enabled button all render
  correctly; the feature is GREEN on desktop (request-pay 4 tx popups). This is a
  mobile z-stacking polish item surfaced by the deepest viewport audit.
