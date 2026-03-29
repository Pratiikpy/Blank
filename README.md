<div align="center">

<img src="https://img.shields.io/badge/Base-Sepolia-0052FF?style=for-the-badge&logo=coinbase&logoColor=white" alt="Base" />
<img src="https://img.shields.io/badge/FHE-Encrypted-8B5CF6?style=for-the-badge&logo=shield&logoColor=white" alt="FHE" />
<img src="https://img.shields.io/badge/Solidity-0.8.25-363636?style=for-the-badge&logo=solidity&logoColor=white" alt="Solidity" />
<img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
<img src="https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge" alt="MIT" />

<br /><br />

# Blank

### Private payments for the real world.

Blank is an encrypted payment platform where transaction amounts are invisible on-chain.<br />
Built on Fully Homomorphic Encryption. The blockchain processes data it cannot read.

[Launch App](https://blank-omega-jade.vercel.app)

</div>

---

## Why

Every transaction on a public blockchain is a postcard — amount, sender, receiver, all visible to anyone. This creates real consequences:

- **$900M+** extracted by sandwich bots exploiting visible swap amounts (2023)
- **272K home addresses** leaked from hardware wallet breaches, enabling targeted physical attacks
- **Enterprise adoption stalled** — competitors can map supply chains from on-chain payment flows
- **DAO salary transparency** — every contributor's compensation visible to every token holder

Financial privacy isn't a feature. It's missing infrastructure.

## How It Works

Blank encrypts every financial amount using Fully Homomorphic Encryption — computation on encrypted data without decryption. Smart contracts add, compare, and transfer encrypted values. The plaintext never touches the blockchain.

```
You type:       $250.00
Chain stores:   0x7a3f...encrypted ciphertext...9e2b
Recipient sees: $250.00 (unsealed with their permit)
Everyone else:  $*****
```

Social context stays transparent. Financial details stay private.

## Features

<table>
<tr>
<td width="50%">

### Payments
- Encrypted wallet (shield/unshield)
- P2P transfers with encrypted amounts
- Payment requests and batch send
- QR codes, payment links, merchant checkout

### Social
- Group expense splitting with voting
- Creator tips with encrypted tier badges
- Gift envelopes with equal or random splits
- Stealth payments via anonymous claim codes

</td>
<td width="50%">

### Business
- Encrypted invoicing with verification
- Batch payroll — employees can't see each other's pay
- Escrow with 2-of-2 approval and arbiter
- P2P exchange with encrypted settlement

### Privacy
- Privacy router (decrypt → swap → re-encrypt)
- Cryptographic receipts with random FHE IDs
- Encrypted compliance flags
- Inheritance with dead man's switch

</td>
</tr>
</table>

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Frontend                                             │
│  React · Vite · TypeScript · Tailwind · wagmi          │
│  @cofhe/react · Framer Motion                          │
├──────────────────────────────────────────────────────┤
│  Smart Contracts (16 deployed)                        │
│  Solidity 0.8.25 · UUPS proxies · FHE.sol             │
│  28 unique FHE operations                              │
├──────────────────────────────────────────────────────┤
│  FHE Coprocessor                                      │
│  Fhenix CoFHE · Threshold Network · ZK Verifier        │
│  Async decryption · Permit-based unsealing             │
├──────────────────────────────────────────────────────┤
│  Data Layer                                           │
│  Supabase realtime · On-chain source of truth          │
└──────────────────────────────────────────────────────┘
```

User encrypts client-side → contract stores ciphertext → CoFHE computes without decrypting → user unseals with permit → plaintext visible only in their browser.

## Protocol

16 smart contracts on Base. All upgradeable via UUPS proxy pattern.

| Contract | Purpose |
|----------|---------|
| **FHERC20Vault** | Encrypted token vault — shield, unshield, transfer |
| **PaymentHub** | P2P payments, requests, batch send |
| **GroupManager** | Group expenses, quadratic voting, debt settlement |
| **CreatorHub** | Creator profiles, encrypted tips, tier badges |
| **BusinessHub** | Invoicing, payroll, escrow |
| **P2PExchange** | Atomic swaps with encrypted settlement |
| **StealthPayments** | Anonymous transfers via claim codes |
| **GiftMoney** | Encrypted gift envelopes |
| **PrivacyRouter** | Decrypt-swap-re-encrypt pipeline |
| **InheritanceManager** | Dead man's switch with challenge period |
| **PaymentReceipts** | Cryptographic receipts with FHE-random IDs |
| **EncryptedFlags** | Compliance engine with encrypted KYC flags |
| **EventHub** | Unified event aggregation |
| **TokenRegistry** | ERC-20 to vault mapping |

## FHE Operations

28 unique operations across all contracts:

| Category | Operations |
|----------|-----------|
| Arithmetic | `add` `sub` `mul` `square` |
| Comparison | `eq` `ne` `gt` `gte` `lt` `lte` `min` `max` |
| Bitwise | `and` `or` `xor` `not` `shl` `shr` |
| Control | `select` `req` |
| Access | `allowThis` `allowSender` `allow` `allowTransient` |
| Decrypt | `decrypt` `getDecryptResultSafe` |
| Random | `randomEuint64` |

Key pattern: `FHE.select()` replaces `require()` for balance checks — a revert would leak "balance insufficient," so select returns encrypted success/failure instead.

## Stack

| Layer | Technology |
|-------|-----------|
| Chain | Base (EVM L2) |
| Contracts | Solidity 0.8.25 + FHE.sol |
| Encryption | Fhenix CoFHE (@cofhe/sdk) |
| Frontend | React 18, Vite 5, TypeScript |
| Styling | Tailwind CSS, glass morphism |
| Wallet | wagmi + viem |
| Realtime | Supabase |
| Animation | Framer Motion |

## Development

```bash
git clone https://github.com/Pratiikpy/Blank.git
cd Blank && pnpm install
cd packages/app && cp .env.example .env
pnpm dev
```

## Security

| Measure | Detail |
|---------|--------|
| Reentrancy protection | Storage-variable guards on 35+ functions |
| Privacy-preserving checks | `FHE.select()` instead of `require()` on all balance operations |
| Transaction verification | Receipt status checked before every database write |
| Anti-frontrunning | Stealth claim codes bound to `keccak256(code, claimer)` |
| Access control | Authorized caller whitelist on receipt issuance |
| Double-submit prevention | Ref-based locks on all async operations |
| Cross-tab coherence | BroadcastChannel API for multi-tab state sync |

## License

MIT
