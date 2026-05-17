# Wave 4 — headless passkey E2E suite

Reproducible cloud-headless run where any judge sees every shipped Wave 4 feature working end-to-end on chain with proof.

## Judge replay guide

```
git clone <repo> && cd <repo>
pnpm install
pnpm e2e
```

That single command runs the full chain:

1. **preflight** — verifies Node ≥ 20, both RPCs reachable, all 9 Wave 4 deployments present per chain. Fails fast with a clear list if anything is missing.
2. **wave4** — boots Vite via Playwright's `webServer`, then runs the 9 phases on Eth Sepolia + Base Sepolia. Mobile sweep (`features/wave4-mobile.spec.ts`) runs alongside at 375×812.
3. **audit** — compares the auto-block in `WAVE4_TESTING_TODO.md` to the 27-tuple coverage matrix in `scripts/proof-gap-audit.ts`. Exits non-zero if any (phase, chainId) is missing.
4. **summary** — prints the final report: tx-hash counts (real vs synthetic), URL artifacts by surface kind, screenshot + video counts, and the absolute paths to the HTML/JSON reports.

`pnpm e2e` exits 0 only when every gate passes. The proof block under `WAVE4_TESTING_TODO.md` is the artifact a judge inspects after the run.

### Opt-in extras

- `TEST_METAMASK=1` enables Phase 9 (MetaMask EOA smoke). Requires the MM extension dist at `e2e/fixtures/metamask/ext/` and a real display (xvfb-run on CI).
- `PRIVATE_KEY=...` is consumed by Phase 8's external-EOA gas-deposit step. Without it the Dave-funds-Alice step skips, the self-pay UserOp still runs against existing AA balance.

## Stopping conditions (the hard gate)

Every shipped feature must hit ALL or it's not "covered":

1. One real tx hash on the right chain's explorer (no mock, no fork)
2. Screenshots at every meaningful state transition: pre-action → encrypting → post-confirm → final-result
3. URL artifact for any public surface (verify/v, claim, shop, fund)
4. Both chains — Eth Sepolia 11155111 AND Base Sepolia 84532
5. A line in `WAVE4_TESTING_TODO.md` with tx hash + screenshot path + chain

## Coverage rules

- **No mocks. No injected ethereum.** Real passkey virtual authenticator (Blank's passkey is passphrase-encrypted P-256 in IndexedDB, so no WebAuthn prompt is needed — fully headless) + real RPC + real testnet chain.
- **Multi-party flows drive each wallet independently** — separate `BrowserContext` per persona.
- **Happy path AND one negative case per fund-flow** — wrong wallet, expired link, below-min bid, zero-goal grief, no-arbiter dispute.
- **Both viewports** — 1280×800 desktop AND 375×812 mobile for any user-facing screen.
- **Video on transitions** — Playwright `video: "on"` per phase.
- **Fresh deployer + fresh passkeys per chain.** No state from prior runs.

## Personas

| Name | Wallet type | Role |
|------|-------------|------|
| Alice | Passkey (passphrase-encrypted P-256 in IndexedDB) | Primary actor — creates everything |
| Bob | Passkey | Second party — receives sends, takes auctions, contributes to campaigns, gets payroll, claims links |
| Carol | Passkey | Third party — arbiter on escrow, third member on group splits |
| Dave | MetaMask EOA | Final smoke test + supplies ETH for the gas-wallet deposit flow |

Determinism: each persona has a pinned 32-byte private key in `fixtures/wallets.ts` so the AA addresses are stable across runs.

## Phase order (9 phases × 2 chains)

| # | Phase | Spec file |
|---|-------|-----------|
| 1 | Bootstrap (spawn passkeys + faucet TestUSDC) | `phases/01-bootstrap.spec.ts` |
| 2 | P2P payments (Alice ↔ Bob) | `phases/02-p2p-payments.spec.ts` |
| 3 | Business (invoice + payroll) | `phases/03-business.spec.ts` |
| 4 | Escrow (Alice/Bob/Carol) | `phases/04-escrow.spec.ts` |
| 5 | Public deep-link create (claim/shop/fund) | `phases/05-deep-link-create.spec.ts` |
| 6 | Public deep-link consume + F1 error UI | `phases/06-deep-link-consume.spec.ts` |
| 7 | Privacy primitives (stealth + income-proof viral artifact) | `phases/07-privacy.spec.ts` |
| 8 | Gas wallet (Dave MM → Alice AA `receive()` → self-pay UserOp) | `phases/08-gas-wallet.spec.ts` |
| 9 | MetaMask smoke (Dave end-to-end) | `phases/09-mm-smoke.spec.ts` |

## "Done" definition

```
pnpm e2e
```

on a clean machine:

1. Spawns 4 wallets (Alice/Bob/Carol passkey + Dave MM).
2. Runs the 9 phases in order on both chains.
3. Outputs ~30 tx hashes + ~100 screenshots + per-feature URLs.
4. Updates `WAVE4_TESTING_TODO.md` with each line.
5. Exits 0.

Any phase failing = not done. Any feature without a tx hash + screenshot = not covered.

## Not-stopping-conditions (push back if asked)

- "It compiled" — type-check doesn't prove the UI works.
- "Click registered" — selector pass doesn't prove the contract path ran.
- "Looks like it works" — connect-only / screenshot-only / hardhat-task-only don't count.
- "Tests pass in CI" — without artifacts (hash + screenshot + URL), no proof.

## File layout

```
e2e/wave4/
  playwright.config.ts           # 2-chain × 2-viewport projects, 5-min timeout, video on, webServer auto-start
  README.md                      # this file
  fixtures/
    wallets.ts                   # 4 personas (Alice/Bob/Carol passkey + Dave MM)
  helpers/
    screenshot.ts                # snap(page, ctx, label) — auto-named PNG
    testing-todo.ts              # recordProof(entry) — appends to WAVE4_TESTING_TODO.md
    app-actions.ts               # enterPassphrase, readTxHashFromSuccess, shieldUsdc
  phases/                        # desktop project testMatch (1280×800)
    01-bootstrap.spec.ts         # spawn personas, faucet TestUSDC
    02-p2p-payments.spec.ts      # happy + over-balance negative
    03-business.spec.ts          # invoice + payroll batch
    04-escrow.spec.ts            # create + delivered + release
    05-deep-link-create.spec.ts  # 3 claim modes + auction + crowdfund (URL handoff via recordProof)
    06-deep-link-consume.spec.ts # Bob claims + 3-bid auction + cumulative contributions + F1 verify-error
    07-privacy.spec.ts           # income-proof viral artifact + stealth scanner
    08-gas-wallet.spec.ts        # external-EOA → AA receive() → self-pay UserOp
    09-mm-smoke.spec.ts          # MetaMask EOA Send (opt-in via TEST_METAMASK=1)
    11-negative-cases.spec.ts    # §1.14 A4 / §1.2 / C4 audit-fix regression pins
  features/                      # mobile project testMatch (375×812 iPhone 13)
    wave4-mobile.spec.ts         # BottomNav + More sheet + mobile P2P + public-surface reachability
  scripts/
    preflight.ts                 # RPC + deployments + Node version + Vite info
    proof-gap-audit.ts           # 27-tuple × 2-chain coverage matrix
    summary.ts                   # final report (counts + paths)
```

Artifacts land under `packages/app/test-results/wave4-{shots,artifacts,html,results.json}`.
