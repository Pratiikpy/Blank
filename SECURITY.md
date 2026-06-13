# Security Policy

Blank is encrypted-payments infrastructure on Fhenix CoFHE plus ERC-4337
account-abstraction. Several layers compose: smart contracts, an
account-abstraction relayer, a paymaster, an FHE coprocessor (Fhenix
Threshold Network), and the React frontend. Each layer has different
threat assumptions; this document covers the project as a whole.

## Reporting a vulnerability

If you find a vulnerability, **do not open a public GitHub issue**.

Primary channel:
- GitHub Security Advisory (private): `Security` tab in this repository

Include:
- Affected component (contract address + function, API route + verb,
  hook + method, screen + flow).
- Reproduction steps (one paragraph, code snippet, or test case).
- Network (Ethereum Sepolia `11155111`, Base Sepolia `84532`, or
  Arbitrum Sepolia `421614`).
- Your assessment of impact (fund-loss path, privacy regression,
  DoS, info leak, etc.).

We aim to acknowledge within 72 hours. Mainnet is explicitly out of
scope until the contracts have completed an external audit; testnet
deployments are not insured.

## Scope

In scope:
- Solidity contracts under `packages/contracts/contracts/`.
- Vercel functions under `packages/app/api/` (relayer, paymaster
  monitor, share endpoint, og endpoint, faucet, cron jobs).
- React frontend hooks + screens under `packages/app/src/`.
- The deployment scripts and hardhat tasks that handle signers,
  funded wallets, or paymaster top-ups.

Out of scope:
- Third-party packages (`@cofhe/sdk`, `@cofhe/react`, `viem`, `wagmi`,
  `ethers`, `react`). Report those upstream.
- The Fhenix Threshold Network itself. Report to Fhenix.
- The Ethereum / Base / Arbitrum Sepolia testnets themselves.
- Browser extensions (MetaMask, etc.).
- Phishing of users via lookalike domains (`blank.example` etc).
- Denial of service that requires sustained spam at a cost greater
  than the asset value protected by the targeted flow.

## Threat model highlights

These are the load-bearing security assumptions. Issues outside these
are still valid but rank lower than these.

- **FHE plaintext stays off chain.** No code path may decrypt an
  encrypted handle to plaintext on chain or in a public event. The
  only legitimate decrypt paths are the Threshold Network signing a
  ciphertext for an authorized address, or the prover voluntarily
  publishing via `publishProof` / `revealWinner` / `publishCloseResult`.
- **Approve race protection.** Vault approvals must mine before the
  caller's main tx, otherwise the main tx reverts with `insufficient
  allowance` and the localStorage approval cache wrongly skips
  re-approve on retry. Fixed in §3.4; regressions are high-severity.
- **Replay window.** Signature-gated email flows use a 90-second window
  per the §15.x `sig-auth` audit. The window is asymmetric: past
  tolerance up to 90s, future tolerance only ~60s for clock skew.
- **Per-chain isolation.** A contract at the same `address` on Ethereum
  Sepolia, Base Sepolia, and Arbitrum Sepolia is **not** the same
  contract. The frontend + server registries (`lib/constants.ts`,
  `api/_lib/addresses.ts`) must agree on the per-chain map across all
  three testnets.
- **EncryptedEscrow no-arbiter dispute.** `disputeEscrow` reverts when
  `arbiter == 0x0`. Without this, funds lock forever. Fixed in §1.2.
- **ClaimLinks expiry cap.** `MAX_EXPIRY_SECONDS = 365 days` prevents
  fund-then-grief. Fixed in §1.5.

## Known classes of issue we triage hardest

1. Fund-loss paths (unrecoverable lock, unauthorized withdraw).
2. Plaintext leaks (any path that exposes a decrypted amount to a
   party that should not see it).
3. Replay vulnerabilities (signature reuse, off-by-one in nonce, AA
   `getNonce` race).
4. Cross-chain confusion (signing for one testnet, executing on
   another, across Eth / Base / Arbitrum Sepolia).
5. Smart-account permission escalation (session keys, paymaster
   abuse, factory hijack).

## Disclosure timeline

| Day | Event |
|-----|-------|
| 0 | Report received |
| 0-3 | Acknowledgement |
| 0-14 | Fix proposed (smaller surfaces) |
| 0-30 | Fix proposed (contracts) |
| Fix + 7 | Public disclosure with reporter credit (opt-out available) |

For testnet-only issues we may disclose faster since no funds are at
risk. For issues that require a UUPS upgrade, we follow the §3 storage-
layout discipline (`pnpm storage:check` must pass) before deploying the
fix.

## Bug bounty

No formal bounty program is active at this stage. Critical findings
will be credited in the changelog and a follow-up bounty may be
extended retroactively once the project completes its external audit
and ships to mainnet.
