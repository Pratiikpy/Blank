<div align="center">
  <img src="../packages/app/public/logo-circle.svg" alt="Blank logo" width="72" />

  <h1>Blank: Private Amount Payments on Ethereum</h1>

  <p><strong>Same chain. Same finality. Different visibility.</strong></p>

  <p>
    Version 1.0 | Testnet launch paper | May 2026<br />
    <a href="Blank-Whitepaper.pdf">Designed PDF</a> |
    <a href="https://blank-omega-jade.vercel.app">Live app</a> |
    <a href="ARCHITECTURE.md">Architecture</a>
  </p>
</div>

---

## Executive Summary

Blank is a private amount payment system for Ethereum.

Public blockchains make settlement transparent, composable, and easy to
audit. They also expose commercial information that normal businesses and
individuals do not publish in traditional finance: salaries, invoice sizes,
vendor spend, campaign contributions, balance thresholds, and purchase
amounts.

Blank keeps the parts Ethereum needs for auditability and compliance:
sender, receiver, chain, contract, and transaction finality remain public.
It encrypts the amount before it touches the chain. Smart contracts operate
on ciphertext through Fhenix CoFHE, and only permitted parties can decrypt
the result.

Blank is not a mixer. It does not hide counterparties. It is amount privacy
for normal payments.

The current public testnet deployment runs on Base Sepolia and Ethereum
Sepolia. It supports standard EVM wallet connections and Blank passkey smart
accounts, with product surfaces for sends, invoices, payroll, public links,
commerce, crowdfunding, escrow, Swap, and Bridge.

## Contents

1. Problem
2. Blank's Model
3. How It Works
4. Product Surface
5. Architecture
6. Security And Privacy
7. Testnet Status
8. Roadmap

---

## 1. Problem

Public payment rails make every amount public.

That is acceptable for some DeFi primitives. It is a poor default for normal
commerce.

| Use case | What leaks on a public chain |
| --- | --- |
| Payroll | Employee salary and contractor rates |
| Invoices | Customer spend, vendor pricing, margin clues |
| Vendor payments | Supply chain and operating cost maps |
| Fundraising | Donor size, goal progress, failed campaigns |
| Storefronts | Purchase prices and buyer behavior |
| Treasury operations | Balance thresholds, run rate, capital movement |

In traditional finance, counterparties can prove a payment happened without
publishing the amount to the whole world. Ethereum has the opposite default:
the payment is verifiable because every field is visible.

Blank changes that default for payment amounts.

The design goal is narrow:

- Keep public settlement.
- Keep public counterparties.
- Keep contract composability.
- Hide the amount from bystanders.

This makes Blank useful for businesses, creators, DAOs, and individuals who
want Ethereum settlement without turning every private commercial detail into
public data.

---

## 2. Blank's Model

Blank uses a public-counterparty, private-amount model.

| Field | Visibility |
| --- | --- |
| Sender | Public |
| Receiver | Public |
| Chain | Public |
| Contract | Public |
| Timestamp | Public |
| Amount | Encrypted |
| Balance | Encrypted |
| Threshold result | Public only when explicitly revealed |

This is a different privacy model from mixers and shielded pools.

Mixers hide who paid whom. Blank does not. Sender and receiver stay visible
on-chain by design. The privacy boundary is the amount.

That gives Blank a narrower and more practical posture:

- Auditors can still follow counterparties.
- Compliance teams can still see transaction relationships.
- Users do not publish salaries, invoice sizes, gift values, or contribution
  amounts.
- Applications can compose with the payment rail without learning plaintext
  values.

Blank also avoids a token dependency. There is no BLANK token, no points
system, and no yield loop. The product is payment infrastructure.

---

## 3. How It Works

Blank uses Fully Homomorphic Encryption through Fhenix CoFHE.

At a high level:

```text
User enters amount
      |
      v
Browser encrypts amount with TFHE WASM
      |
      v
Fhenix CoFHE verifies encrypted input and signs the ciphertext
      |
      v
Blank contract stores and computes over ciphertext
      |
      v
Permitted parties decrypt through threshold-network permits
```

### Client-side encryption

Plaintext amounts are encrypted before they are submitted to the chain. The
browser loads TFHE WASM and produces an encrypted input plus proof material.
The plaintext amount is not stored on-chain.

### CoFHE verification

Fhenix CoFHE validates encrypted inputs and signs the ciphertext. Contracts
accept only verified encrypted handles, which prevents arbitrary ciphertext
injection.

### Ciphertext state

Balances, payment amounts, goals, bids, and escrow amounts are stored as
ciphertext handles. Contracts use FHE operations such as:

- `FHE.add` for balances and contributions.
- `FHE.eq` for amount matching.
- `FHE.gte` for threshold checks.
- `FHE.gt` and `FHE.select` for sealed-bid auction winner selection.

### Permit-based decryption

Decrypt access is controlled through FHE permissions. A sender, receiver,
contract, or verifier gets access only when the contract grants it.

Common access patterns:

- `allowThis` for contract-owned computation.
- `allowSender` for sender access.
- `allow` for explicit recipient or contract access.
- `allowTransient` for one-transaction cross-contract use.

The result is a payment system where the chain can settle and enforce rules
without exposing the amount to every observer.

---

## 4. Product Surface

Blank is not a single send screen. It is a payment surface for common
commercial workflows.

| Surface | What it does |
| --- | --- |
| Send | Private amount P2P transfers |
| Invoice | Vendor creates invoice, client pays encrypted amount |
| Request | Recipient asks for payment through a request flow |
| Payroll | Batch payments where employee amounts stay private |
| Gifts | Equal or random gift envelopes with claim codes |
| Groups | Private group expenses and split flows |
| Proofs | Shareable balance threshold proofs |
| Claim links | Bearer, email-bound, or address-bound payment URLs |
| Storefront | Fixed price, pay-what-you-want, and sealed-bid auction listings |
| Crowdfund | Encrypted goal and encrypted contributions |
| Escrow | Encrypted amount escrow with arbiter or deadline release |
| Swap | Token swaps through the Blank swap surface |
| P2P exchange | Encrypted amount offer creation and fill |
| Bridge | USDC movement across supported testnets |

The product principle is consistent across all of them:

> The transaction can be public. The amount does not need to be.

---

## 5. Architecture

Blank has four main layers.

```text
Frontend
  React, Vite, wagmi, viem, FHE pipeline UI

Wallet layer
  Standard EVM wallets, passkey smart accounts, ERC-4337, paymaster

Contract layer
  Vault, hubs, claim links, storefront, crowdfund, escrow

Data layer
  Chain as source of truth, Supabase for cache and notifications
```

### Contracts

The contract system is built around an encrypted vault plus feature-specific
hubs.

Core components:

- `FHERC20Vault`: encrypted asset balances, shield, unshield, transfer.
- `PaymentHub`: P2P sends, requests, batch sends.
- `BusinessHub`: invoices, payroll, escrow-style business flows.
- `ClaimLinks`: bearer, email-bound, and address-bound claim URLs.
- `Storefront`: fixed price, auction, and pay-what-you-want commerce.
- `EncryptedCrowdfund`: encrypted goal and contribution tracking.
- `EncryptedEscrow`: encrypted escrow with release, dispute, or expiry.
- `BlankAccount`: ERC-4337 smart account for passkey users.
- `BlankPaymaster`: gas sponsorship path for smart accounts.

Contracts that need upgradeability use UUPS proxies with storage layout
checks. Storage changes are guarded by layout snapshots and CI.

### Vault and hubs

The vault owns encrypted balances. Hubs verify and route user intent into the
vault.

This keeps the payment primitive consistent while allowing product surfaces
to add their own rules.

Examples:

- Invoice payment checks encrypted amount equality before finalization.
- Crowdfund close checks whether encrypted raised amount is greater than or
  equal to encrypted goal.
- Auction close computes over encrypted bids and reveals only the winner
  index after threshold-signed decryption.

### Supabase cache

Supabase is not the source of truth for payments. It stores user-facing cache,
activity rows, notifications, public metadata, and discovery records.

The chain remains authoritative for settlement and encrypted state. UI state
is expected to survive refresh, account switch, and indexer delay by reading
from chain-backed or chain-confirmed data.

### Wallet paths

Blank supports two wallet paths through a shared write layer:

- Standard EVM wallets for users who already use a wallet.
- Passkey smart accounts for no-extension onboarding, with sponsored gas when
  the paymaster is available.

Both routes use the same product surface. The application does not maintain
separate feature implementations per wallet type.

### FHE pipeline

Encrypted operations have a visible pipeline:

1. Load CoFHE SDK.
2. Encrypt the input.
3. Receive signed ciphertext proof.
4. Submit transaction.
5. Confirm transaction.

The goal is to avoid silent waits. Users should know whether the app is
encrypting, proving, signing, broadcasting, or confirming.

---

## 6. Security And Privacy

### What Blank hides

- Payment amounts.
- Encrypted balances.
- Contribution sizes.
- Bid amounts.
- Payroll amounts.
- Invoice and escrow amounts.
- Threshold values unless explicitly proved or revealed.

### What Blank does not hide

- Sender address.
- Receiver address.
- Contract address.
- Chain.
- Transaction existence.
- Timing.
- Gas usage.

This is intentional. Blank is not designed for sender anonymity. It is designed
for private commercial amounts on public rails.

### Contract safety posture

Blank uses several patterns to reduce privacy and upgrade risk:

- `FHE.select` instead of plaintext-style `require` checks when a revert would
  leak information.
- Reentrancy guards on money-moving surfaces.
- UUPS storage layout checks for upgradeable contracts.
- Domain-separated hashes for claim links.
- Expiry caps for public payment links.
- Threshold-signed decryption results for async decrypt flows.
- FHE ACL grants scoped to the actor or contract that needs them.

### Account abstraction posture

Passkey accounts use P-256 signatures and ERC-4337. The relayer and paymaster
path is built for onboarding users who do not want a browser extension.

EOA wallets remain first-class because many crypto-native users prefer to
manage keys directly.

### Mainnet posture

Blank is testnet-only today.

Mainnet is gated on:

- Third-party contract audit.
- Fhenix mainnet readiness.
- Threshold operator decentralization.
- Production monitoring and incident response.
- Mainnet-grade relayer and paymaster operations.

---

## 7. Testnet Status

Blank is live at:

https://blank-omega-jade.vercel.app

Supported public testnets:

- Base Sepolia, chain ID 84532.
- Ethereum Sepolia, chain ID 11155111.

Public testnet support includes:

- Standard EVM wallet connections on both supported chains.
- Passkey smart accounts for no-extension onboarding.
- Private amount sends, invoices, requests, payroll, gifts, groups, proofs,
  claim links, storefront, crowdfund, escrow, Swap, Bridge, and P2P exchange.
- Mobile UI across the product route map.
- Public links for invoices, proofs, claim links, storefronts, crowdfunds, and
  escrow detail pages.

---

## 8. Roadmap

Blank's roadmap is gated by proof, not dates.

### Near-term

- Keep standard EVM wallet flows stable on Base Sepolia and Ethereum Sepolia.
- Expand mobile transaction coverage beyond route sweeps.
- Improve account switch and realtime recovery behavior.
- Continue hardening public links, storefront, crowdfund, and escrow.
- Move client-side chain filtering into stronger server-side indexed queries
  where appropriate.

### Mainnet gates

- Complete external audit.
- Confirm Fhenix mainnet and threshold network readiness.
- Harden production monitoring, alerting, and relayer operations.
- Run a mainnet-readiness validation matrix on supported wallets and chains.
- Publish a mainnet risk disclosure before real funds are supported.

### Long-term

- Make private amount payments a reusable primitive.
- Let developers build invoices, payroll, storefronts, crowdfunds, proofs,
  and escrow on top of encrypted balances.
- Preserve the same privacy line: public counterparties, private amounts.

---

## Closing

Ethereum made payments public by default. Blank keeps the parts that make
public settlement valuable and encrypts the part that makes normal commerce
unsafe.

Same chain. Same finality. Different visibility.
