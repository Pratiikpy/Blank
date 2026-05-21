# Blank Launch Readiness

Date: 2026-05-21

Live product: https://www.myblank.app

## Current Verdict

Blank is ready for a public testnet launch in this scope:

- Desktop browser app
- Standard EVM wallet path, proven with Rabby EOA
- Base Sepolia and Ethereum Sepolia
- Amount-private payment flows backed by real testnet transactions
- Public marketing pages, whitepaper, brand kit, manifesto, live page, and link previews

This is not a mainnet readiness claim. Mainnet waits for external audit,
Fhenix mainnet readiness, threshold-network decentralization, and production
key management.

## What Was Checked In The Final Pass

### Live site

All of these routes returned healthy responses from `https://www.myblank.app`:

| Surface | Result |
| --- | --- |
| `/` | 200 HTML |
| `/app` | 200 HTML |
| `/whitepaper` | 200 HTML |
| `/whitepaper.pdf` | 200 PDF |
| `/brand-kit` | 200 HTML |
| `/manifesto` | 200 HTML |
| `/live` | 200 HTML |
| `/pricing` | 200 HTML |
| `/roadmap` | 200 HTML |
| `/blog` | 200 HTML |
| `/api/badge?for=pratik.eth` | 200 PNG |
| `/api/og/proof?id=13&chain=84532` | 200 PNG |

Homepage metadata includes the `www.myblank.app` canonical URL and Open Graph
metadata. Old public domains were not found in the tracked launch surfaces.

### App route coverage

Desktop Rabby route sweep on live Vercel:

- Base URL: `https://www.myblank.app`
- Wallet profile: Dave, Rabby EOA
- Chain: Base Sepolia
- Result: 30 routes checked, 30 ok, 0 blank, 0 crash, 0 404
- Report: `packages/app/test-results/qa-live-sweep/REPORT.md`

Mobile route and responsive baseline:

- Viewport: 390 x 844
- Chain: Base Sepolia
- Result: 30 routes checked, 30 ok, 0 red
- Bottom navigation visible on dashboard
- Report: `packages/app/test-results/qa-live-mobile-sweep-base/REPORT.md`

The mobile result is a route and layout baseline. The full mobile transaction
matrix is still a follow-up, not a blocker for this desktop-first testnet
launch scope.

### CI and deployment

- Branch: `main`
- Latest product checked commit: `eb58fb1`
- GitHub CI run: `26212834385`
- App and contracts checks: green
- Latest Vercel deployment: `app-hzqnlljmk-pratiikpys-projects.vercel.app`
- Public alias: `https://www.myblank.app`

### Public docs and copy

Checked public launch copy for:

- Old domains
- Banned launch-copy words
- Em dashes
- Overclaims around mainnet, mobile, gas, and automatic delivery

Current public positioning is aligned around:

- Public sender
- Public receiver
- Encrypted amount
- Testnet status
- No mixer claim
- No mainnet claim before audit

## Product Coverage Already Proven

The product has two proof layers:

1. Live UI proof with Rabby on Vercel.
2. Contract and multi-wallet proof with real transactions on both chains.

### Live UI proof

Live Vercel UI flows have been driven with Rabby and produced real success
states or transaction hashes for:

| Area | Proof shape |
| --- | --- |
| Send | Encrypted payment tx hash |
| Deposit and shield | On-chain txs, completion banner, activity row |
| Gift envelope | On-chain tx hash and success state |
| Stealth inbox setup | On-chain tx and accessible inbox |
| Group create | New group card and admin role |
| Storefront listing | Public `/shop/:chainId/:listingId` URL, seller delivery handoff |
| Crowdfund campaign | Public `/fund/:chainId/:campaignId` URL |
| Encrypted proof | Proof visible in the user's proof list |
| Inheritance | Contract path proven in multi-wallet sweep |
| Payment request | Contract path proven in multi-wallet sweep |
| Claim link | Contract path proven in multi-wallet sweep |
| Business payroll and invoice stack | Contract path proven in multi-wallet sweep |

### Multi-wallet and cross-chain proof

Local proof artifacts:

- `packages/contracts/test-results/FINAL_RESULTS.md`
- `packages/contracts/test-results/LAUNCH_READINESS.md`
- `packages/contracts/test-results/truly-final-base-sepolia-40-pass.log`
- `packages/contracts/test-results/truly-final-eth-sepolia-40-pass.log`

Latest contract sweep result:

| Chain | Result |
| --- | --- |
| Base Sepolia | 40+ pass, 0 fail, 4 intentional skips |
| Ethereum Sepolia | 40+ pass, 0 fail, 4 intentional skips |

The sweep used four wallets:

- Alice
- Bob
- Carol
- Dave

The sweep included real transaction hashes for:

- Funding personas
- Shielding
- Encrypted P2P payments
- Group create
- Group settlement
- Gift send and claim
- Escrow create, delivery mark, and release approval
- Bearer claim link create and claim
- Address-bound claim link create and claim
- Inheritance set-heir
- Storefront listing and purchase
- Crowdfund create and contribute
- P2P exchange offer create
- Payroll run
- Unshield request
- Creator profile and support
- Stealth send and claim

Negative checks confirmed expected rejects for:

- Self-pay
- Non-member group expense
- Wrong or already-used claim link
- Address-bound claim by wrong wallet
- Non-depositor escrow release
- Creator self-tip
- Zero shield
- Same-token P2P exchange offer
- Empty payroll batch
- Gift replay
- Gift wrong recipient

## Known Limits To State Honestly

These are not blockers for the current testnet launch, but they should not be
hidden.

| Area | Current truth |
| --- | --- |
| Mainnet | Not supported until external audit and Fhenix mainnet readiness. |
| Mobile | Route and layout baseline is green. Full mobile transaction matrix is next. |
| Storefront delivery | Payment and purchase are proven. Digital file delivery is seller-handled today, with buyer and seller handoff copy in the UI. It is not an automatic Gumroad-style file system. |
| Crowdfund close, release, refund | Covered by contract tests and sweep logic where timing allows. Full live UI close waits on real testnet duration. |
| Inheritance claim | Set-heir path is proven. Final claim requires inactivity and challenge windows. |
| Stealth keys | Current setup stores local stealth keys in browser storage and warns the user. Production-grade custody should move to stronger key storage before mainnet. |
| Realtime | UI should update after writes, but some surfaces depend on Supabase or indexer delay. Key feeds now show checked times and manual refresh. Refresh-after-delay is still part of the QA standard. |
| Storefront management | Public listing and purchase are live. Seller listings show on-chain state, delivery channel, copy URL, and deactivate controls. Automatic file fulfillment is still a product follow-up. |
| Claim link management | Create and claim work. Sender links show on-chain state, claim/refund status, copy URL, and refund controls. Advanced sender analytics are still a product follow-up. |
| Encrypted escrow UI | Contract path is live. Full BusinessTools UI consolidation is still a focused follow-up. |
| API health | Public route health is good. `/api/health` can report service-level 503 if optional relayer or provider env is not configured. |

## Launch Owner Checklist

Before announcing widely:

- Confirm Vercel production env vars are set for Supabase, RPCs, WalletConnect,
  relayer or KMS signing, and any email provider being marketed.
- Keep the Rabby QA profile, seed phrase, password, faucet keys, and local
  test logs out of public launch material.
- Keep `www.myblank.app` as the public domain in site metadata, README,
  whitepaper, PDF, and footer links.
- Keep the supported scope clear: public testnet, Base Sepolia and Ethereum
  Sepolia, standard EVM wallet path, desktop-first.
- Do not claim mainnet readiness before audit.
- Do not claim automatic digital file delivery for storefront until that
  product exists.
- If a new deployment is made, re-check the alias, homepage metadata, PDF,
  brand kit, badge API, OG proof API, and the 30-route app sweep.

## Final Status

There is no known blocker for a professional public testnet launch in the
stated scope.

The remaining items are product expansion and mainnet-hardening work, not
reasons to hold the desktop Rabby testnet launch.
