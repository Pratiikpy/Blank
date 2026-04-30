<div align="center">

<img src="https://img.shields.io/badge/Live-blank--omega--jade.vercel.app-000000?style=for-the-badge" alt="Live" />
<img src="https://img.shields.io/badge/Base_Sepolia-84532-0052FF?style=for-the-badge&logo=coinbase&logoColor=white" alt="Base Sepolia" />
<img src="https://img.shields.io/badge/Ethereum_Sepolia-11155111-627EEA?style=for-the-badge&logo=ethereum&logoColor=white" alt="Eth Sepolia" />
<img src="https://img.shields.io/badge/FHE-Fhenix_CoFHE-8B5CF6?style=for-the-badge" alt="FHE" />
<img src="https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge" alt="MIT" />

<br /><br />

# Blank

### Send a private invoice. Get paid privately.

Blank is an encrypted payment workspace for freelancers, teams, and small
businesses. Amounts are FHE-encrypted on-chain — only sender and receiver
decrypt. The blockchain processes your money without ever seeing the numbers.

<br />

[**Launch App**](https://blank-omega-jade.vercel.app) &nbsp; | &nbsp; [**See It Live**](https://blank-omega-jade.vercel.app/live)

<br />

<img src="docs/screenshots/landing.gif" alt="Blank — the amount is the secret" width="800" />

</div>

---

## The problem

Every payment on a public blockchain is a postcard — amount, sender,
receiver, all visible to anyone with a block explorer.

- Employees can see each other's salaries
- Competitors can map your supply chain from payment flows
- High-balance wallets become targets
- MEV bots front-run visible swap amounts

Financial privacy isn't a feature request. It's missing infrastructure.

## The solution

Blank encrypts every amount using **Fully Homomorphic Encryption** before
it reaches the chain. Smart contracts add, compare, and transfer
ciphertext. The plaintext never exists on-chain.

```
You send $250         →  Encrypted in your browser (TFHE ciphertext + ZK proof)
Smart contract runs   →  FHE.add(balance, amount) — operates on ciphertext
Recipient receives    →  Decrypts with their key → sees $250
Everyone else sees    →  $████.██
```

No trusted intermediary. No hardware enclaves. No MPC committees. Pure math.

---

## What's inside

### Private invoice escrow

Issue an invoice with an encrypted amount. The client opens a public link
and pays into a vault-held escrow. The contract releases funds on
amount-match and refunds on mismatch — no arbiter, no manual dispute.
The vendor sees a proof-of-payment card with a real explorer link.

### Workspace modes

Pick a focus — Freelancer, Business, Privacy, or Full. The nav, search,
and feature surface adapt to your role. One source of truth in
`nav-registry.ts` drives the desktop sidebar, mobile bottom-bar, and
search index, so adding a screen lights up everywhere at once.

### Encrypted payments

Send to contacts, QR codes, payment links, or batch up to 30 recipients
in one transaction. Confidential payroll — employees can't see each
other's pay. Two-phase invoicing for clients who want a separate review
step before settling.

### Stealth + inheritance

One-time claim-code anonymous transfers, with a 30-day refund window if
unclaimed. Dead-man's-switch inheritance with encrypted beneficiary
amounts.

### Group expenses + gifts

Split bills with encrypted shares. Resolve disputes via quadratic voting.
Send encrypted gift envelopes with equal or random splits and expiry.

### Verifiable balance proofs

Generate a shareable URL that proves "balance ≥ $X" without revealing the
actual balance. Threshold-network signed; no trusted backend.

### Passkey smart wallets + paymaster

Sign up with a passphrase — no extension. The app deploys an ERC-4337
account signed by P-256 passkeys; BlankPaymaster sponsors gas. The
MetaMask path also works — both go through the same `useUnifiedWrite`
hook so we don't maintain two versions of the app.

### AI agent payments

Plain-English prompt → on-chain payment. The server signs an
authorization with an agent key; PaymentHub verifies via `ecrecover` and
ties every agent-authored payment to the agent that signed it.
Signatures expire in ten minutes.

### Dual-chain

Same contracts deployed on Base Sepolia and Ethereum Sepolia. Per-chain
activity feeds and explorer links — transactions show on the chain they
actually happened on, not the viewer's active chain.

---

## Wallets

| | Passkey wallet | MetaMask / EOA |
|---|---|---|
| **Setup** | Passphrase only — no extension | Connect any browser wallet |
| **Signing** | P-256 passkey (WebAuthn) | Standard ECDSA |
| **Gas** | Free — sponsored via Paymaster | User pays |
| **Transactions** | Batched into single UserOp (ERC-4337) | One popup per operation |
| **Best for** | New users, mobile, passwordless UX | Existing crypto users |

Both paths use the same encrypted contracts and the same UI.

---

## How it works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Your browser    │     │  Fhenix CoFHE    │     │  Base / Eth Sepolia │
│                  │     │  threshold net   │     │  smart contracts    │
│  1. Enter $250   │     │                  │     │                     │
│  2. TFHE encrypt │────►│  3. ZK verify    │     │                     │
│     in WebWorker │     │  4. ECDSA sign   │────►│  5. ecrecover       │
│                  │     │                  │     │  6. FHE.add()       │
│                  │     │                  │     │  7. Store ciphertext│
│                  │◄────│                  │◄────│                     │
│  8. Recipient    │     │  Async decrypt   │     │  Permit-gated       │
│     sees $250    │     │  via permits     │     │  access control     │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
```

1. **Client-side encryption** — Plaintext never leaves your browser. TFHE WASM runs in a Web Worker.
2. **Zero-knowledge verification** — CoFHE threshold network validates the proof and signs it.
3. **On-chain computation** — Smart contracts operate on ciphertext using FHE operations (add, compare, select).
4. **Permit-based decryption** — Only authorized parties can decrypt values via the threshold network.

---

## Deployed contracts

All contracts are UUPS-upgradeable proxies, live on **Base Sepolia**
(84532) and **Ethereum Sepolia** (11155111).

| Contract | Base Sepolia | Purpose |
|----------|-------------|---------|
| FHERC20Vault | `0x789f0bC4...B0ff23` | Encrypted token vault — shield, unshield, transfer |
| PaymentHub | `0xF420102D...e831` | P2P payments, requests, batch send |
| BusinessHub | `0xEfD67E33...EFD` | Invoicing, payroll, escrow |
| GroupManager | `0x1749E0E0...9D3d` | Group expenses, quadratic voting |
| StealthPayments | `0x76aDF6D8...F1C` | Anonymous transfers via claim codes |
| GiftMoney | `0x37374487...cDDf` | Gift envelopes with expiry |
| P2PExchange | `0xDa606096...f116` | Atomic swaps with encrypted settlement |
| CreatorHub | `0x5dc36868...12ea` | Creator tips with tier badges |
| InheritanceManager | `0x289714c4...73d5` | Dead-man's-switch |
| PaymentReceipts | `0x23f0530e...AD7c` | Qualification proofs |
| BlankAccountFactory | `0xd19Bfd90...16fb` | ERC-4337 smart wallet factory |
| BlankPaymaster | `0xB1CbBD59...63de` | Gas sponsorship for passkey users |

The same set is deployed on Ethereum Sepolia. See
`packages/contracts/deployments/` for full addresses.

---

## Security

| Layer | Approach |
|-------|----------|
| **Privacy** | `FHE.select()` over `require()` — a revert leaks 1 bit of information. Enough reverts reconstruct a balance. Blank never reverts on insufficient funds. |
| **Encryption** | Every encrypted input is ZK-verified and signed by the CoFHE threshold network before on-chain use |
| **Access control** | 4-tier FHE permit system: `allowThis` → `allowSender` → `allow` → `allowTransient` |
| **Contracts** | Reentrancy guards on state-changing functions. UUPS upgradeable with append-only storage layout (snapshot-checked in CI). |
| **AA** | ERC-1271 length guards on passkey accounts. Paymaster validates every target in `executeBatch` — no bypass via batched calls. |
| **Stealth** | Claim codes bound to `keccak256(code, claimer)` — intercepting the code is useless without the claimer's address |
| **Frontend** | Input validation on all addresses, empty-string guards on `parseUnits`, toast feedback on every error |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| **Chains** | Base Sepolia (84532) + Ethereum Sepolia (11155111) |
| **Contracts** | Solidity 0.8.25, UUPS proxies, `@fhenixprotocol/cofhe-contracts` |
| **FHE** | Fhenix CoFHE SDK (`@cofhe/sdk` v0.5.1, `@fhenixprotocol/cofhe-contracts` v0.1.3), TFHE WASM, threshold decryption |
| **Account abstraction** | ERC-4337, P-256 passkey signing, EntryPoint v0.7 |
| **Frontend** | React, Vite, TypeScript, Tailwind |
| **Wallet** | wagmi + viem (MetaMask, Coinbase Wallet, WalletConnect) |
| **Realtime** | Supabase (notifications + activity feed; not a source of truth) |
| **Deployment** | Vercel (frontend), Hardhat (contracts) |

---

## Getting started

**Use the app** — no setup required:

Visit [**blank-omega-jade.vercel.app**](https://blank-omega-jade.vercel.app),
create a passkey wallet with any passphrase, and you're in. Gas is free.

**Run locally:**

```bash
git clone https://github.com/Pratiikpy/Blank.git
cd Blank && pnpm install

# Frontend
cd packages/app
cp .env.example .env
pnpm dev                # http://localhost:3000

# Contracts
cd packages/contracts
cp .env.example .env
npx hardhat compile
npx hardhat test
```

---

## License

MIT
