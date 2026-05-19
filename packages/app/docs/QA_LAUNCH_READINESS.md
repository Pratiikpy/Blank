# Blank testnet QA launch report

Generated: 2026-05-20 03:06 IST

Live URL: https://blank-omega-jade.vercel.app

Latest deployed commit: `7568b17`

## Claim

Desktop Rabby EOA on Base Sepolia and Ethereum Sepolia is launch-ready within the tested scope. The live Vercel alias was used for every run. Dave and Bob were driven through Rabby with real signatures and real testnet transactions.

Mobile responsive quality is green for route coverage on both chains with Rabby connected. A full mobile transaction matrix is not claimed in this report.

## Supported in this claim

- Chains: Base Sepolia, Ethereum Sepolia.
- Wallet path: Rabby EOA.
- Viewport: desktop transaction matrix, mobile responsive route sweep.
- Personas: Dave and Bob for Rabby multi-wallet checks.
- Data sources: chain transactions plus Supabase-backed UI after refresh and open-session recovery.

## Proof table

| Area | Result | Proof |
|---|---|---|
| Desktop Base feature matrix | 9/9 green | `test-results/qa-live-batch/REPORT.md` |
| Desktop Ethereum feature matrix | 9/9 green | `test-results/qa-live-batch-eth/REPORT.md` |
| Base public links, cross-user | green | `test-results/qa-live-public-links/REPORT.md` |
| Ethereum public links, cross-user | green | `test-results/qa-live-public-links-eth/REPORT.md` |
| Ethereum direct send | green | `test-results/qa-live-send-eth/REPORT.md`, tx `0x83869b7b4544db102dc9817361b3bad667c4dc4efb4b9e628ed1e2131944347f` |
| Base realtime soak | green | `test-results/qa-live-soak-base/REPORT.md`, tx `0x40046327697ac9b18f2ae3199aea055675ed8c72cf1e46f2c76df946aa424500` |
| Ethereum realtime soak | green | `test-results/qa-live-soak-eth/REPORT.md`, tx `0x1e5e2bb8541ffa1237412625cb1296279229c0487a8d81dedd84d8c88319e727` |
| Base failure handling | green | `test-results/qa-live-failure-base/REPORT.md`, duplicate-click tx `0x611742ef681eb63cdd69e92f95c4d9358206cf922613e754dd9301a5621736c3` |
| Ethereum failure handling | green | `test-results/qa-live-failure-eth/REPORT.md`, duplicate-click tx `0x1372a6ac4f43dff1a8d5e5a16729a1c103cddfef69542555d35ff500837090cd` |
| Desktop current live render sweep | 30/30 ok | `test-results/qa-live-sweep/REPORT.md` |
| Mobile Base current live sweep | 30/30 ok | `test-results/qa-live-mobile-sweep-base/REPORT.md` |
| Mobile Ethereum current live sweep | 30/30 ok | `test-results/qa-live-mobile-sweep-eth/REPORT.md` |

## Product fixes from QA

- `38b880a`: send confirmation now names the active chain instead of always saying Ethereum Sepolia.
- `d2423ff`: mobile service banner, bottom padding, and gift card layout polish.
- `287d551`: notification toasts no longer consume feed events before the activity feed can render them.
- `5200f58`: activity feed polls every 30 seconds while visible so an open dashboard recovers if Supabase push misses an insert.
- `7568b17`: legacy activity rows without `chain_id` are filtered by known per-chain contract addresses to avoid cross-chain feed bleed.

## Current honest gaps

- Full mobile transaction matrix is not claimed. Mobile route coverage is green on both chains, and prior mobile P2P passkey sends exist in Wave 4 proof, but every Rabby transaction flow was not repeated on mobile.
- Real phone hardware was not used. Mobile checks used Playwright mobile viewport and touch emulation.
- Passkey AA sponsorship is degraded on the live env. The app surfaces an honest banner and Rabby EOA sends still work.
- Supabase should still receive a schema migration for `activities.chain_id`. The live app now filters legacy rows client-side, but server-side chain filtering is the better long-term state.
- Mainnet is not in scope.
- Circle CCTP bridge and external WETH swap require external test assets. UI gates are honest, but this report does not claim those external-asset transaction paths.
- Time-locked auction close and crowdfund release/refund are not live-waited here because testnet UI durations are one day. Contract tests cover those paths.

## Final status

No unresolved blocker remains for desktop Rabby EOA on Base Sepolia and Ethereum Sepolia. The current live alias renders cleanly on desktop and mobile viewport, and the cross-user activity path recovers in open sessions and after refresh.
