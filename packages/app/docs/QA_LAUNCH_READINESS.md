# Blank testnet QA launch report

Generated: 2026-05-20 11:55 IST

Live URL: https://blank-omega-jade.vercel.app

Latest deployed commit: `873ae97`

## Claim

Desktop Rabby EOA on Base Sepolia and Ethereum Sepolia is launch-ready within the tested scope. The live Vercel alias was used for every run. Dave, Bob, and Carol were driven through Rabby with real signatures and real testnet transactions where the feature required a write.

Mobile responsive quality is green for route coverage on both chains with Rabby connected. A full mobile transaction matrix is not claimed in this report.

## Supported in this claim

- Chains: Base Sepolia, Ethereum Sepolia.
- Wallet path: Rabby EOA.
- Viewport: desktop transaction matrix, mobile responsive route sweep.
- Personas: Dave, Bob, and Carol for Rabby multi-wallet checks.
- Data sources: chain transactions plus Supabase-backed UI after refresh and open-session recovery.

## Proof table

| Area | Result | Proof |
|---|---|---|
| Desktop Base feature matrix | 9/9 green | `test-results/qa-live-batch/REPORT.md` |
| Desktop Ethereum feature matrix | 9/9 green | `test-results/qa-live-batch-eth/REPORT.md` |
| Base public links, cross-user | green | `test-results/qa-live-public-links/REPORT.md` |
| Ethereum public links, cross-user | green | `test-results/qa-live-public-links-eth/REPORT.md` |
| Ethereum direct send | green | `test-results/qa-live-send-eth/REPORT.md`, tx `0x83869b7b4544db102dc9817361b3bad667c4dc4efb4b9e628ed1e2131944347f` |
| External asset Bridge and Swap | green | `test-results/qa-live-external-assets/REPORT.md`, Bridge mint tx `0x5c4b16f9a9b2f8108e4e63a1697ddb262c4ae8383ce285dffddb0ce27d9443f4`, Swap tx `0xb3670e57dbca188cf3dd057a5637388b952612be5902b4daefa06bf14399d58e` |
| Base P2P exchange create and fill | green | `test-results/qa-live-outcome-p2p-base/REPORT.md`, txs `0x415184702a44cdd6f1df690164bc6d50767ce67d7871764a5841207bfa6cb471`, `0x1db8ef8dec9e9dad668cfc39f57305e7593512da0a187028e9dd569d36382bfa`, `0x1a3cbbb4b0d3fe0768c3fc5a5a14fd947e9bc4fb6cf27e3974114848f8168066` |
| Base 3-wallet public links | green for user flows | `test-results/qa-live-public-links-base/REPORT.md`, claim link Bob claim and Carol used-link block, storefront Bob buyer and Carol non-buyer, crowdfund Bob and Carol contributors |
| Base realtime soak | green | `test-results/qa-live-soak-base/REPORT.md`, tx `0x60da850efce66f6397fd4cb27987f55531ceb4797f448f756c71bd6f64d7718c`, 10 refresh samples, Carol private-state exclusion green |
| Ethereum realtime soak | green | `test-results/qa-live-soak-eth/REPORT.md`, tx `0x1e5e2bb8541ffa1237412625cb1296279229c0487a8d81dedd84d8c88319e727` |
| Ethereum payment request create and pay | green | `test-results/qa-live-outcome-payments-eth/REPORT.md`, txs `0xc946de22548fe22376026254fac4a1007db19009cb8c8759bd2e8891bca48c3c`, `0x4d20857a3325f2ecc9fd4acf374752fd6192379c8ca9c9eef753b2347b0ef788` |
| Ethereum invoice pay and finalize | green | `test-results/qa-live-outcome-invoice-eth/REPORT.md`, invoice `7`, txs `0xd9612b96701fc96dfb6f28670bc18022de613f6d2a1861f9f9e701e6a0cb8562`, `0xa47de8db20530cc43ba06b0ecd257c91245f6d17f61fd93b53fdd76d8abb6f86`, `0xb437a031dd8e6c4a765a38afec057016d154cb6a03e484941d6a4f2a7e2406a2`, `0xa1c6215c50c2079b169b0e5b34d412691569680758afc1f204326962a187922e` |
| Ethereum escrow delivery and release | green | `test-results/qa-live-outcome-escrow-eth/REPORT.md`, txs `0xea7347ad6e8f6e2c4c245dafc95a85aeba5150680d0df6e7698f2609ff760c35`, `0x89a3ee405359ce286fe8f25bb6fbc795624fb3283e9b0c938090a61adb36805f`, `0xfed657fc03164b73a2fff74238875c6511e896db968c0f46dd317e4378e9ebdc`, `0x72e96f8b239967d91e5be017a2a17bf32b50bacc723d294bcf1cb259fbc254ac` |
| Ethereum payroll to three wallets | green | `test-results/qa-live-outcome-payroll-eth/REPORT.md`, txs `0x375a78ccf9ec59218f73bfb5541506458090ab129788bc21a458229a37ff31a0`, `0x8cddc7e8e88c85d0f4bf56ab1f7baae2058ff0b297470f0dd030767d72effb24`, Dave, Bob, and Carol history visible |
| Ethereum creator profile and support | green | `test-results/qa-live-outcome-creator-eth/REPORT.md`, txs `0xa5bf6b0bb8095b91983852a6e8155082f46f7b0f4a4649775ef31c70c83a8bd8`, `0x43590bef305a94f9b1734068df6015fc57f431a42226bdef5e2f9f1bfa3924e5`, `0x6fcb57ea11ff5057aafb3fd75c0360ae4e3943c3a1406969a4bca7315e80131b` |
| Base failure handling | green | `test-results/qa-live-failure-base/REPORT.md`, duplicate-click tx `0x611742ef681eb63cdd69e92f95c4d9358206cf922613e754dd9301a5621736c3` |
| Ethereum failure handling | green | `test-results/qa-live-failure-eth/REPORT.md`, duplicate-click tx `0x1372a6ac4f43dff1a8d5e5a16729a1c103cddfef69542555d35ff500837090cd` |
| Desktop current live render sweep | 30/30 ok | `test-results/qa-live-sweep/REPORT.md` |
| Mobile Base current live sweep | 30/30 ok | `test-results/qa-live-mobile-sweep-base/REPORT.md`, refreshed after `873ae97` |
| Mobile Ethereum current live sweep | 30/30 ok | `test-results/qa-live-mobile-sweep-eth/REPORT.md`, refreshed after `873ae97` |

## Product fixes from QA

- `38b880a`: send confirmation now names the active chain instead of always saying Ethereum Sepolia.
- `d2423ff`: mobile service banner, bottom padding, and gift card layout polish.
- `287d551`: notification toasts no longer consume feed events before the activity feed can render them.
- `5200f58`: activity feed polls every 30 seconds while visible so an open dashboard recovers if Supabase push misses an insert.
- `7568b17`: legacy activity rows without `chain_id` are filtered by known per-chain contract addresses to avoid cross-chain feed bleed.
- `3b97238`: Bridge mint now switches the injected wallet to the destination chain, passes the destination `chainId` into EOA writes, and waits for mined receipts before showing success. This fixed a real false-success state found during CCTP QA.
- `7bb1a54`: client invoice history keeps terminal statuses visible after payment and finalization.
- `daa0228`: decimal P2P offers persist as base units in Supabase, and failed offer inserts now fail visibly instead of showing false success.
- `873ae97`: EOA writes wait for receipts through the target chain RPC first. This fixed a real payment-request stale-state bug on Ethereum Sepolia.

## Current honest gaps

- Full mobile transaction matrix is not claimed. Mobile route coverage is green on both chains, and prior mobile P2P passkey sends exist in Wave 4 proof, but every Rabby transaction flow was not repeated on mobile.
- Real phone hardware was not used. Mobile checks used Playwright mobile viewport and touch emulation.
- Passkey AA sponsorship is degraded on the live env. The app surfaces an honest banner and Rabby EOA sends still work.
- Supabase should still receive a schema migration for `activities.chain_id`. The live app now filters legacy rows client-side, but server-side chain filtering is the better long-term state.
- Mainnet is not in scope.
- P2P Exchange is Base Sepolia only right now. The Ethereum Sepolia UI states that the protocol needs two distinct tokens and only Base has them today.
- The shared-profile public-link script still records one wallet-preflight red line when switching active Rabby accounts inside one already-authorized browser session. The stricter isolated 3-session soak is green and is the multi-wallet truth source for this report.
- Time-locked auction close and crowdfund release/refund are not live-waited here because testnet UI durations are one day. Contract tests cover those paths.

## Final status

No unresolved blocker remains for desktop Rabby EOA on Base Sepolia and Ethereum Sepolia in the tested scope. The current live alias renders cleanly on desktop and mobile viewport, external asset Bridge/Swap produce real transaction and balance proof, and the cross-user activity path recovers in open sessions and after refresh.
