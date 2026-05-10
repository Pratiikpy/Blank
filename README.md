<div align="center">

<img src="https://img.shields.io/badge/Live-blank--omega--jade.vercel.app-000000?style=for-the-badge" alt="Live" />
<img src="https://img.shields.io/badge/Base_Sepolia-84532-0052FF?style=for-the-badge&logo=coinbase&logoColor=white" alt="Base Sepolia" />
<img src="https://img.shields.io/badge/Ethereum_Sepolia-11155111-627EEA?style=for-the-badge&logo=ethereum&logoColor=white" alt="Eth Sepolia" />
<img src="https://img.shields.io/badge/FHE-Fhenix_CoFHE-8B5CF6?style=for-the-badge" alt="FHE" />

<br /><br />

# Blank

### Send a private invoice. Get paid privately.

**Same chain. Same finality. Different visibility.**

</div>

| What everyone sees on Etherscan today | What everyone sees on Blank |
|---|---|
| `0xAlice → 0xBob:` &nbsp; `5,200.00 USDC` | `0xAlice → 0xBob:` &nbsp; `████.██ USDC` |
| `0xCarol → 0xDave:` &nbsp; `12.50 USDC` | `0xCarol → 0xDave:` &nbsp; `████.██ USDC` |
| `0xEve → 0xFrank:` &nbsp; `87,500.00 USDC` | `0xEve → 0xFrank:` &nbsp; `████.██ USDC` |

<div align="center">

Blank is encrypted payments on Ethereum. Amounts are FHE-encrypted before
they touch the chain; smart contracts add, compare, and transfer ciphertext;
sender and receiver decrypt with their own keys. Everyone else sees ████.

[**Launch the app →**](https://blank-omega-jade.vercel.app) &nbsp; · &nbsp; [**Watch it live →**](https://blank-omega-jade.vercel.app/live) &nbsp; · &nbsp; [**Read the manifesto →**](https://blank-omega-jade.vercel.app/manifesto)

<br />

<img src="docs/screenshots/hero-loop.gif" alt="X-Ray slider: public dollar bill resolves into FHE ciphertext" width="800" />

<sub>See it in motion: <a href="docs/screenshots/demo.mp4">24-second product walkthrough →</a></sub>

</div>

---

## In 5 seconds

Stripe-shaped product on Ethereum where the amount is private. Sender + receiver public; the number isn't.

## In 5 minutes

Every payment on a public blockchain is a postcard. Amount, sender, receiver: all visible to anyone with a block explorer. Employees see each other's salaries. Competitors map your supply chain from payment flows. MEV bots front-run visible swaps.

Blank fixes one of those: the amount. We use Fully Homomorphic Encryption (Fhenix CoFHE) so smart contracts can `add`, `compare`, and `transfer` ciphertext without ever decrypting it. The plaintext is never on-chain. Senders and receivers decrypt locally with their own keys; bystanders see ████.

```
You send $250         →  Encrypted in your browser (TFHE ciphertext + ZK proof)
Smart contract runs   →  FHE.add(balance, amount), operates on ciphertext
Recipient receives    →  Decrypts with their key → sees $250
Everyone else sees    →  $████.██
```

No mixer. No trusted custodian. No hardware enclaves. Pure math + a threshold network for decryption permits.

---

## Why now

- **Encrypted compute went from research to production in 2024–25.** Fhenix CoFHE made it cheap enough for real apps. We're standing on infra that didn't exist 18 months ago.
- **Web3 payroll just crossed the "real money" threshold.** Bitwage, Toku, Request Finance moved from crypto-curious to default-payment-rail for thousands of contractors. Their amounts are public.
- **Nobody owns the privacy layer for normal payments.** Tornado-style mixers got sanctioned for hiding senders. Blank inverts the model: public sender, private amount. Different threat model, different legal posture, different market.

---

## What you can do today

| | | |
|---|---|---|
| **Send** | Encrypted P2P transfers | One person → another, amount hidden |
| **Invoice** | Private invoice escrow | Vendor + client + auto-refund-on-mismatch |
| **Request** | Payment requests | "Pay me $X" links, encrypted on accept |
| **Payroll** | Confidential batch sends | Up to 30 employees, nobody sees each other's pay |
| **Split** | Group expenses | Splitwise but nobody can see the dinner total |
| **Gift** | Encrypted gift envelopes | Equal or random splits, expiry, claim codes |
| **Stealth** | Anonymous claim-code transfers | One-time codes, 30-day refund window |
| **Inherit** | Dead-man's-switch wallet | Heir claims after N days inactive |
| **Prove** | Verifiable balance proofs | Share "balance ≥ $X" without the balance |
| **Tip** | Creator support with tiers | Encrypted tip totals, on-chain Bronze/Silver/Gold |
| **Swap** | P2P encrypted exchange | Atomic settlement, encrypted amounts |
| **Agent** | AI-derived payments | Plain English → signed → on-chain |

Twelve product surfaces. One encrypted vault. One link to share.

---

## Send any of these links

```
https://blank.app/i/12345              ← invoice (public link, private amount)
https://blank.app/r/0xabc?amt=10       ← payment request
https://blank.app/g/<claim-code>       ← gift envelope
https://blank.app/v/<proof-id>         ← balance proof
```

Each link is the entire payment flow. No login required to pay. No app to install. Recipients can interact with Blank without ever creating a wallet (we provision a passkey-signed smart account on their first claim).

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

1. **Client-side encryption**: plaintext never leaves your browser. TFHE WASM runs in a Web Worker.
2. **Zero-knowledge verification**: Fhenix's threshold network validates the proof and signs it.
3. **On-chain computation**: contracts operate on ciphertext via `FHE.add`, `FHE.eq`, `FHE.select`. They never see plaintext.
4. **Permit-based decryption**: only addresses you've granted (`allowSender`, `allow`) can ask the threshold network to decrypt.

---

## Wallets: two paths, same UI

| | Passkey wallet | MetaMask / EOA |
|---|---|---|
| **Setup** | Passphrase, no extension | Connect any browser wallet |
| **Signing** | P-256 passkey (WebAuthn) | Standard ECDSA |
| **Gas** | Free, sponsored via Paymaster | User pays |
| **Transactions** | Batched into one UserOp (ERC-4337) | One popup per op |
| **Best for** | New users, mobile, passwordless | Existing crypto users |

Both routes through `useUnifiedWrite`. We don't maintain two versions of the app.

---

## Anti-FAQ

The questions a skeptical reader is already asking.

**Isn't this just a mixer with extra steps?**
No. Mixers hide *who* paid *whom*; the amount is public. Blank inverts that: sender + receiver are public, the amount isn't. Different threat model, different legal posture. We don't break the link between addresses; we encrypt the field between them.

**Why FHE and not zero-knowledge proofs?**
ZK proves a statement ("this address paid the right amount"). FHE *computes on hidden data*. ZK still needs plaintext to exist somewhere; FHE keeps the amount as ciphertext through every contract operation. Different tools, different problems. We pick FHE because the threat model (bystanders reading amounts off-chain) is exactly the one FHE is built for.

**Threshold network = trusted third party?**
It's a t-of-n threshold. You trust that the majority of operators isn't colluding (same trust model as a multisig validator set, weaker than a single-prover ZK proof, stronger than any custodial product). We're explicit about this. As Fhenix decentralizes the operator set, the trust assumption weakens.

**What about regulators / FATF travel rule?**
Sender + receiver are on-chain in cleartext, which means jurisdictions that require traceable counterparties get exactly that. Only the *amount* is encrypted, which is closer to bank-account privacy than to mixer-style anonymity. We're testnet-only until the operator set decentralizes; mainnet conversations will involve regulatory counsel.

**Why testnet only?**
Two reasons: Fhenix's threshold operator set is still small enough that we don't recommend storing real-money amounts. And our team hasn't been audited by a third party yet. Testnet lets users build muscle memory; we'll graduate when both are ready.

**When token?**
Never. There is no $BLANK token and there will not be one. Read the next section.

---

## What Blank will not be

- **A mixer.** Sender + receiver are public on purpose.
- **A speculation app.** No token. No points farm. No "encrypted DeFi yield."
- **Cross-chain.** We pick two chains and ship them well.
- **Mainnet** until the threshold operator set is decentralized and the contracts are audited.
- **A creator economy super-app.** Privacy is the wedge; we'll keep cutting features that don't sharpen it.

This list is not aspirational. It's what we say no to in design reviews.

---

## Compared honestly

| | Tornado Cash | Aztec | zkBob | **Blank** |
|---|---|---|---|---|
| Amount privacy | ✓ | ✓ | ✓ | **✓** |
| Sender privacy | ✓ | ✓ | ✓ | **✗** *(public on purpose)* |
| Composable with public DeFi | ✗ | ✗ | ✗ | **✓** |
| Audit posture | sanctioned | encrypted accounts | shielded pools | **public sender + private amount** |
| Speed today | n/a | seconds | seconds | **slow on Sepolia threshold** |
| Token-free | ✗ | ✗ | ✗ | **✓** |

The honest weaknesses (sender privacy is *intentionally absent*; threshold decrypt on testnet is slow today) are why the green checkmarks are credible.

---

## How we got here

We ship in waves. If you have 30 seconds, read the box below. If you have 10 minutes, read the wave detail underneath. Every commit hash links to `main` so you can verify any claim.

> **The story so far. Read this if you have 30 seconds:**
>
> - **Wave 1** *(Mar 29 to Apr 16)*. **We built the core app.** A working encrypted-payment app with 16 smart contracts, 12 features, and 23 screens. Live on testnet.
> - **Wave 2** *(Apr 17 to Apr 30)*. **We made it usable for real people.** Passkey wallets so users don't need MetaMask. The same app runs on two chains. AI agents can sign payments. Anyone can verify a balance proof without a wallet or a server.
> - **Wave 3** *(May 1 to Apr 30)*. **We made it explainable and faster.** Public pricing page, roadmap, and blog with four long-form posts. Recovered from a production white-screen incident. Fixed a multichain bug. Shipped a Fhenix-recommended performance optimization on both chains in one day. Tests grew from 17 to 154.
> - **Wave 4** *(May 1 to present)*. **We made it composable.** Magic claim links over email, sealed-bid storefronts, encrypted crowdfunding, encrypted escrow with arbiter-or-deadline release. 4 new contracts (ClaimLinks, Storefront, EncryptedCrowdfund, EncryptedEscrow) plus FHE pipeline UI for every encrypted op.

The pattern: **build → harden → open.** Wave 1 added the surface; Wave 2 disciplined the code that runs it; Wave 3 made the rationale public and shipped a perf optimization onchain.

---

### Wave 1. Foundation *(Mar 29 to Apr 16)*

> **In one line:** A working app where you send USDC and the amount stays hidden. 16 smart contracts. 12 features. 23 screens. Live on testnet.

**What the app does** *(live at [blank-omega-jade.vercel.app](https://blank-omega-jade.vercel.app))*

*Core payments:*
- Encrypted wallet: turn public USDC into encrypted eUSDC ("shield"), and back ("unshield")
- Send a private payment to anyone. The amount is encrypted in your browser before it hits the chain
- Request money via a payment link
- Receive money via a QR code

*Social features:*
- Split a group expense. Equal share or custom per person, with encrypted voting if you want a quadratic split
- Tip a creator. Public tier badges (Bronze / Silver / Gold) but encrypted tip totals
- Send gift envelopes. Equal or random splits, with expiry dates
- Pay anonymously with one-time stealth codes that resist front-running

*Business tools:*
- Invoice a client with the amount encrypted
- Run payroll for up to 30 employees. Nobody sees anyone else's salary
- 2-of-2 escrow with arbiter dispute resolution
- P2P exchange with real-time order book

*Advanced:*
- Inheritance dead-man's-switch. Heir claims after a 7-day challenge period if you go inactive
- Privacy permits. Track who has decryption access to your encrypted data
- Global search, transaction details, settings, help

**How it's built**

*Smart contracts (Solidity 0.8.25):*
- All 16 contracts use the UUPS upgradeable proxy pattern (we can fix bugs without redeploying)
- We use `FHE.select()` instead of `require()` everywhere. A normal `require` revert would leak "balance insufficient" to anyone watching the chain
- Cross-contract encrypted transfers use `FHE.allowTransient()` (one-transaction-only access)
- Built on `@fhenixprotocol/cofhe-contracts` v0.1.3

*Frontend (React):*
- Fhenix's SDK loads only when needed (lazy-load). Loading it eagerly conflicted with our styling library
- Real homomorphic encryption happens in your browser via TFHE WASM in a Web Worker. Plaintext never leaves your device
- Each encrypted input goes through Fhenix's ZK verifier, which returns a signed ciphertext we can submit on-chain
- Manual 5M gas limit on FHE transactions (the standard gas estimator can't see the FHE precompile)
- Accessibility from day one: 99 aria-labels, WCAG AA contrast, 44px touch targets, keyboard focus indicators

*Data:*
- Supabase is for notifications and cache only. The blockchain is always the source of truth
- Real-time updates on 8 tables for instant UI refresh
- We log activity *after* on-chain confirmation, never before
- Input validation on every one of the 18 contract calls that touch FHE

**Anchor commits:** [`a4c320f`](https://github.com/Pratiikpy/Blank/commit/a4c320f) initial · [`fb11f42`](https://github.com/Pratiikpy/Blank/commit/fb11f42) full release · [`321f6c3`](https://github.com/Pratiikpy/Blank/commit/321f6c3) initial 17-test suite

---

### Wave 2. Hardening + business *(Apr 17 to Apr 30)*

> **In one line:** Made the app usable for real people. Passkey wallets, dual-chain, AI-signed payments, public balance proofs, five-phase hardening pass.

**Passkey wallets, the biggest change this wave**
You sign up with a passphrase. No browser extension, no MetaMask. The app creates an ERC-4337 smart account, signs with P-256 (the same crypto your phone uses for Face ID and Touch ID), and our paymaster covers the gas. The user pays nothing. MetaMask still works for users who prefer it. Both paths run through one shared hook in the code, so we don't maintain two versions of the app.

**What you can do**  
Send encrypted payments. Request money. Invoice clients. Run payroll where no employee can see another's pay. Split group expenses. Tip creators. Send gifts. Plan inheritance as a dead-man's-switch. Claim stealth payments with one-time codes. Generate a proof that your balance is above some number, without revealing the actual balance.

**Dual-chain on one codebase**  
The app runs on both Base Sepolia and Ethereum Sepolia. Explorer links automatically point at the right chain. Activity feeds show each transaction on the chain it actually happened on, not on whichever chain you're currently looking at. Most of the bugs we caught came from us using the app as a real user with two wallets in two browser windows.

**AI agent payments**  
A user types "send Alice $50 every Friday" in plain English. The server runs Kimi K2 (Anthropic Claude as backup) to figure out the amount, then signs that amount with an agent-specific private key. On-chain, our PaymentHub contract uses `ecrecover` to verify the signature and ties every payment back to the agent that authored it. The agent's private key never leaves the server. Signatures expire in ten minutes; a stolen signature can't be replayed.

**Verifiable proofs, no trusted server**  
A user generates a proof that their balance is above some number (say "I make more than $5,000/month") and gets a shareable URL. Anyone, even without a wallet, can open the URL and click verify. The Threshold Network's decrypted answer gets published on-chain with a signature check, and the contract does the math. Nobody has to trust our server. The chain has the receipt.

**Under the hood**  
16 UUPS-upgradeable contracts, 28 FHE operations, all migrated from Fhenix's older testnet to the CoFHE v0.4 API. The pattern we're proudest of is `transferFromVerified`. A Hub contract verifies an encrypted input in its own context (where `msg.sender` is the user), then passes the verified handle along to the vault. Without this pattern, cross-contract FHE signature checks fail silently with no visible error. That one took a long time to figure out.

**Where we are**  
The CoFHE migration is done. Every feature that existed before still works, and everything new this wave sits on the v0.4 foundation. The product is usable on testnet today. That doesn't mean it's a real product yet. That gap will close in future waves.

PaymentHub on Base Sepolia: [`0xF420102D...e831`](https://sepolia.basescan.org/address/0xF420102Dea1acf437bfc49ded5F4E2f5ed32e831)

**Anchor commits:** [`34b1e8a`](https://github.com/Pratiikpy/Blank/commit/34b1e8a) P1 security · [`741ffa0`](https://github.com/Pratiikpy/Blank/commit/741ffa0) P2 storage gap · [`0ccd6f8`](https://github.com/Pratiikpy/Blank/commit/0ccd6f8) P3 cleanup · [`107fa41`](https://github.com/Pratiikpy/Blank/commit/107fa41) P4 architecture · [`7bfa6ca`](https://github.com/Pratiikpy/Blank/commit/7bfa6ca) P5 cofhe-shim CI · [`2c03451`](https://github.com/Pratiikpy/Blank/commit/2c03451) workspace modes + invoice escrow · [`8897baf`](https://github.com/Pratiikpy/Blank/commit/8897baf) AA contracts · [`cca2c42`](https://github.com/Pratiikpy/Blank/commit/cca2c42) passkey end-to-end

---

### Wave 3. Partner-grade ship-readiness *(May 1 to Apr 30)*

> **In one line:** Made the app explainable (public pricing, roadmap, four blog posts) and faster (Fhenix-recommended perf optimization shipped onchain on both chains in one day).

**Built the parts that aren't code**  
[`/pricing`](https://blank-omega-jade.vercel.app/pricing), [`/roadmap`](https://blank-omega-jade.vercel.app/roadmap), and [`/blog`](https://blank-omega-jade.vercel.app/blog) all shipped this wave. Pricing says we charge nothing today and we'll figure out mainnet pricing later, with the reasoning visible. Roadmap groups everything as **Shipped / Next / Blocked**, where the Blocked rows name their actual gates: Fhenix CoFHE mainnet readiness, third-party audit, threshold operator decentralization. Blog has four long-form posts: a deep dive on [why we picked FHE over zero-knowledge for our specific problem](https://blank-omega-jade.vercel.app/blog/fhe-vs-zk), an even deeper one on [why we picked Fhenix CoFHE over the FHE Layer 1 alternatives](https://blank-omega-jade.vercel.app/blog/why-fhenix-cofhe), the Wave 3 changelog, and a writeup on why we'll never issue a token. None of them are marketing. All of them link to real commits.

**The white-screen incident**  
Mid-wave, the live site went pure white on Vercel. We chased it for two passes. First diagnosis: the Content Security Policy was too strict and was blocking Web3 libraries from using `eval`. We relaxed the CSP. Still white. Second diagnosis: a Vite `manualChunks` bundling config was splitting `viem` and `wagmi` into separate JavaScript chunks, and one was loading before the other initialized, creating a runtime error. We removed the manual chunking (Vite's default is fine), pushed, and the site loaded again. We also wrote a Playwright diagnostic script during the chase. It captures console errors, page errors, and CSP violations on a real Vercel URL. It's now in the repo, so the next time something white-screens, the first move is *run the diagnostic*, not *guess*.

**Multichain bug fix**  
The "Encrypted USDC moved" counter on the landing page was showing a confusing dash on the Base Sepolia tab whenever the user's wallet was on Eth Sepolia. The bug was subtle: `usePublicClient()` from wagmi defaults to the wallet's chain, not whichever tab the user clicked. So clicking *Base Sepolia* while connected to Eth Sepolia tried to read Base Sepolia's contract address against Eth Sepolia's RPC: silent failure, dash. The fix is one line: pass `chainId: activeChainId` explicitly. Plus friendlier UX: instead of a dash, the page now says *Switch wallet to Base Sepolia* and offers a button that does the switch.

**Perf pass using Fhenix's own guide**  
Fhenix publishes a canonical AI training material called `marronjo/fhe-assistant`, a single `core.md` file they point their own AI assistants at. We pulled it into our local references and read it cover to cover. One thing jumped out: every `FHE.allow(x, msg.sender)` should be rewritten as `FHE.allowSender(x)`. Same effect, smaller bytecode, cheaper hot paths. Fhenix flags it explicitly as the slow form. We had 20 sites across nine contracts using the slow form. Twenty surgical edits, ran the full 154-test suite (still 154 passing, zero regression), and rolled the new bytecode out via UUPS upgrade on both chains the same day. Nine proxies on Eth Sepolia, nine plus the USDT alias proxy on Base Sepolia, every one verified by reading the EIP-1967 implementation slot directly from chain storage. We also wrote a `verify-upgrade.js` script that any future upgrade can use to prove correctness without trusting console output.

**Where we are**  
Wave 3 is the wave where Blank stops being a thing we shipped and starts being a thing we explain. Tests grew from 17 at the end of Wave 1 to 154 today, about a **9× increase**. Storage drift across every UUPS upgrade we ran: **zero**. UUPS upgrades shipped this wave: **18**, across two chains. Long-form blog posts live: **4**. Multichain bugs in landing-page widgets: **0**.

**Anchor commits:** [`925d5e4`](https://github.com/Pratiikpy/Blank/commit/925d5e4) CSP relax · [`ab4eaf4`](https://github.com/Pratiikpy/Blank/commit/ab4eaf4) /pricing + /roadmap + /blog · [`968b00a`](https://github.com/Pratiikpy/Blank/commit/968b00a) Why-Fhenix-CoFHE post · [`bdf9415`](https://github.com/Pratiikpy/Blank/commit/bdf9415) multichain GlobalCounter fix · [`015701e`](https://github.com/Pratiikpy/Blank/commit/015701e) allowSender refactor · [`c1ffa7e`](https://github.com/Pratiikpy/Blank/commit/c1ffa7e) UUPS rollout

---

**What's next** lives at [`/roadmap`](https://blank-omega-jade.vercel.app/roadmap). Explicit gates, no dates we can't keep.

---

## Live deployments

UUPS-upgradeable proxies, deployed on **Base Sepolia** (84532) and **Ethereum Sepolia** (11155111). Top contracts:

| Contract | Base Sepolia | Purpose |
|----------|-------------|---------|
| FHERC20Vault | `0x789f0bC4...B0ff23` | Encrypted vault: shield, unshield, transfer |
| PaymentHub | `0xF420102D...e831` | P2P, requests, batch send |
| BusinessHub | `0xEfD67E33...21EFD` | Invoicing, payroll, escrow |
| StealthPayments | `0x76aDF6D8...32F1C` | Anonymous claim-code transfers |
| InheritanceManager | `0x289714c4...973d5` | Dead-man's-switch |
| BlankPaymaster | `0xB1CbBD59...e63de` | Gas sponsorship for passkey users |

Full address list including Ethereum Sepolia: [`packages/contracts/deployments/`](packages/contracts/deployments).

---

## Security posture

| Layer | What we do |
|-------|------------|
| **Privacy** | `FHE.select()` over `require()`. A revert leaks one bit of information. Blank never reverts on insufficient funds. |
| **Encryption** | Every encrypted input is ZK-verified + threshold-signed before on-chain use |
| **ACL** | 4-tier FHE permits (`allowThis`, `allowSender`, `allow`, `allowTransient`) |
| **Contracts** | Reentrancy guards everywhere. UUPS storage layout snapshotted in CI; every upgrade fails the build if a slot moves. `uint256[50] private __gap` reserved on every hub. |
| **AA** | ERC-1271 length guards on passkey accounts. Paymaster validates every target in `executeBatch`. No bypass via batched calls. |
| **Stealth** | Claim codes bound to `keccak256(code, claimer)`. Intercepting the code is useless without the claimer's address. |
| **Stealth keystore** | AES-GCM-at-rest with PBKDF2-derived key (250k iterations) on the user's passphrase. Plaintext never on disk. |
| **Frontend** | Wallet-signed challenges on all email + push endpoints. CSP, X-Frame-Options DENY, Permissions-Policy headers. |

Find a hole? Open an issue or email. We treat security reports seriously.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| **Chains** | Base Sepolia, Ethereum Sepolia |
| **Contracts** | Solidity 0.8.25, UUPS proxies, `@fhenixprotocol/cofhe-contracts` v0.1.3 |
| **FHE** | Fhenix CoFHE (`@cofhe/sdk` v0.5.1), TFHE WASM, threshold decryption |
| **Account abstraction** | ERC-4337, P-256 passkey signing, EntryPoint v0.7 |
| **Frontend** | React, Vite, TypeScript, Tailwind |
| **Wallets** | wagmi + viem; MetaMask, Coinbase, WalletConnect |
| **Realtime** | Supabase (cache + notifications; never the source of truth) |
| **Deployment** | Vercel (frontend), Hardhat (contracts) |

---

## Get started in 30 seconds

**Use the live app:**

```
1. Visit blank-omega-jade.vercel.app
2. Create a passkey with any passphrase
3. Mint test USDC from the in-app faucet
4. Send a private payment in under a minute
```

Gas is free. No extension needed. Works on mobile.

**Run locally:**

```bash
git clone https://github.com/Pratiikpy/Blank.git
cd Blank && pnpm install

# Frontend (terminal 1)
cd packages/app && cp .env.example .env && pnpm dev

# Contracts (terminal 2)
cd packages/contracts && cp .env.example .env
npx hardhat compile && npx hardhat test
```

---

<sub>MIT · built with [Fhenix CoFHE](https://fhenix.io) · [report a bug](https://github.com/Pratiikpy/Blank/issues)</sub>
