<div align="center">

<img src="https://img.shields.io/badge/Base-Sepolia-0052FF?style=for-the-badge&logo=coinbase&logoColor=white" alt="Base Sepolia" />
<img src="https://img.shields.io/badge/FHE-Encrypted-8B5CF6?style=for-the-badge&logo=shield&logoColor=white" alt="FHE Encrypted" />
<img src="https://img.shields.io/badge/Solidity-0.8.25-363636?style=for-the-badge&logo=solidity&logoColor=white" alt="Solidity" />
<img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 18" />
<img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge" alt="MIT License" />

<br /><br />

# Blank

### Private payments for the real world.

Blank is an encrypted payment platform where transaction amounts are invisible on-chain.<br />
Built on Fully Homomorphic Encryption. The blockchain processes data it cannot read.

[Live Demo](https://blank-pay.vercel.app) · [Documentation](https://docs.blank.finance) · [Contracts](https://sepolia.basescan.org/address/0x62a8559AfE6147cCA57D1bd8CC4F0Fc72D97BA38)

</div>

---

## Why

Every transaction on a public blockchain is a postcard — amount, sender, receiver, all visible to anyone. This creates real consequences:

**$900M+ extracted** by sandwich bots exploiting visible swap amounts. **272K home addresses leaked** from hardware wallet breaches, enabling targeted attacks. **Enterprise adoption stalled** because competitors can map supply chains from payment flows. **DAO contributors' salaries** visible to every token holder on Etherscan.

Financial privacy isn't a feature. It's missing infrastructure.

## What Blank Does

Blank encrypts every financial amount using Fully Homomorphic Encryption — a cryptographic technique that allows computation on encrypted data without decryption. Smart contracts add, compare, and transfer encrypted values. The plaintext never touches the blockchain.

```
You type:     $250.00
Chain sees:   0x7a3f...encrypted ciphertext...9e2b
Recipient:    $250.00 (unsealed with their permit)
Everyone else: $*****
```

Social context stays transparent. Financial details stay private.

## Features

<table>
<tr>
<td width="50%">

### 💳 Core Payments
- Encrypted wallet (shield/unshield)
- P2P transfers with encrypted amounts
- Payment requests and batch send (30 max)
- QR codes, payment links, merchant checkout

### 👥 Social
- Group expense splitting with quadratic voting
- Creator tips with encrypted tier badges
- Gift envelopes (equal or random splits)
- Stealth payments via claim codes

</td>
<td width="50%">

### 🏢 Business
- Encrypted invoicing with two-phase verification
- Batch payroll (employees can't see each other's pay)
- Escrow with 2-of-2 approval and arbiter
- P2P exchange with encrypted settlement

### 🔐 Advanced Privacy
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
│  @cofhe/react · Framer Motion · Glass morphism         │
├──────────────────────────────────────────────────────┤
│  Smart Contracts (16 deployed)                        │
│  Solidity 0.8.25 · UUPS proxies · FHE.sol             │
│  28 unique FHE operations · ReentrancyGuard            │
├──────────────────────────────────────────────────────┤
│  FHE Coprocessor                                      │
│  Fhenix CoFHE · Threshold Network · ZK Verifier        │
│  Async decryption · Permit-based unsealing             │
├──────────────────────────────────────────────────────┤
│  Data Layer                                           │
│  Supabase (realtime) · localStorage · On-chain state   │
└──────────────────────────────────────────────────────┘
```

**Privacy model:** User encrypts client-side → contract stores ciphertext → CoFHE computes without decrypting → user unseals with 7-day permit → plaintext visible only in their browser.

**Data hierarchy:** On-chain state is the source of truth. Supabase caches public metadata for real-time UX. Encrypted amounts never leave the chain.

## Contracts

16 contracts on Base Sepolia. All use UUPS upgradeable proxy pattern.

| Contract | Address | Purpose |
|----------|---------|---------|
| **FHERC20Vault** | [`0x62a8...BA38`](https://sepolia.basescan.org/address/0x62a8559AfE6147cCA57D1bd8CC4F0Fc72D97BA38) | Encrypted token vault |
| **PaymentHub** | [`0x9000...c85A`](https://sepolia.basescan.org/address/0x9000eB2d1F207261B5fDf7Aba8CFA2a23D40c85A) | P2P payments, requests, batch |
| **GroupManager** | [`0x9113...53c4`](https://sepolia.basescan.org/address/0x91136d7c3029D9F7E768dc4Beaed584Fa57d53c4) | Groups, splits, voting |
| **CreatorHub** | [`0x9649...86f0`](https://sepolia.basescan.org/address/0x9649b402FE50E8255eF7b9B46C244086715c86f0) | Tips, tiers |
| **BusinessHub** | [`0x4137...66e3`](https://sepolia.basescan.org/address/0x4137dD45097559b0d9d081896060b46c276566e3) | Invoicing, payroll, escrow |
| **P2PExchange** | [`0xe439...C88C`](https://sepolia.basescan.org/address/0xe439c7f19B7E3CAB4e0b78ecda484534EE9dC88C) | Atomic swaps |
| **StealthPayments** | [`0x1636...7D68`](https://sepolia.basescan.org/address/0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68) | Anonymous transfers |
| **GiftMoney** | [`0x53CB...a084`](https://sepolia.basescan.org/address/0x53CBAF7407Ab26cd4C75a04587bb3F7172C2a084) | Encrypted envelopes |
| **PrivacyRouter** | [`0xE233...888A`](https://sepolia.basescan.org/address/0xE2333a6c58E21A8Cc45982612a31dB1440D9888A) | Swap pipeline |
| **InheritanceManager** | [`0x976b...DDB5`](https://sepolia.basescan.org/address/0x976b79128D1d4269942EA4500e89A18D8918DDB5) | Dead man's switch |
| **PaymentReceipts** | [`0xC458...c215`](https://sepolia.basescan.org/address/0xC458E7D3A16B48ccF3180cc20b1c127283C26215) | Encrypted receipts |
| **EncryptedFlags** | [`0x3088...f8C9`](https://sepolia.basescan.org/address/0x308862f79cCd0f625F2EBc1998E7B14a1D9d85C9) | Compliance engine |
| **EventHub** | [`0x19A2...52b8`](https://sepolia.basescan.org/address/0x19A29d280983dF7Fcb7b957f33559927456D52b8) | Event aggregator |
| **TokenRegistry** | [`0x80D2...bb68`](https://sepolia.basescan.org/address/0x80D2FC38657F2B27C4bEA6D73d5D9Ab17362bb68) | Token mapping |
| **MockDEX** | [`0x2d45...3f2c`](https://sepolia.basescan.org/address/0x2d45d8B82a1fB7b2F60D3359F8dF36bCDb7B3f2c) | Test swap backend |
| **TestUSDC** | [`0x36f6...4f1`](https://sepolia.basescan.org/address/0x36f6Ec6A77AbCE769063751ABddD30263a62c4f1) | Testnet stablecoin |

## FHE Operations

28 unique operations across all contracts:

| Category | Operations |
|----------|-----------|
| **Arithmetic** | `add` `sub` `mul` `square` |
| **Comparison** | `eq` `ne` `gt` `gte` `lt` `lte` `min` `max` |
| **Bitwise** | `and` `or` `xor` `not` `shl` `shr` |
| **Control** | `select` `req` |
| **Types** | `asEuint64` `asEuint8` `asEbool` |
| **Access** | `allowThis` `allowSender` `allow` `allowTransient` |
| **Decrypt** | `decrypt` `getDecryptResultSafe` |
| **Random** | `randomEuint64` |

Key pattern: `FHE.select()` replaces `require()` for all balance checks. A revert would leak "balance < amount" — select returns encrypted success/failure, preserving privacy.

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Chain | Base Sepolia | 84532 |
| Contracts | Solidity + FHE.sol | 0.8.25 |
| FHE SDK | @cofhe/sdk + @cofhe/react | 0.4.0 |
| Frontend | React + Vite + TypeScript | 18 / 5 / 5 |
| Styling | Tailwind CSS | 3.4 |
| Wallet | wagmi + viem | 2.x |
| State | React Query + Zustand | 5.x |
| Realtime | Supabase | — |
| Animation | Framer Motion | — |
| Icons | Lucide React | — |
| Fonts | Outfit + Inter + JetBrains Mono | — |

## Getting Started

```bash
git clone https://github.com/Pratiikpy/Blank.git
cd Blank && pnpm install

# Configure
cd packages/app
cp .env.example .env
# Add your Supabase URL and anon key

# Run
pnpm dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | For full features | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | For full features | Supabase public anon key |
| `VITE_WALLETCONNECT_PROJECT_ID` | Optional | WalletConnect integration |

The app works without Supabase in offline mode — all on-chain features function, but activity feeds and real-time notifications are disabled.

### Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Run `packages/app/supabase/schema.sql` in the SQL Editor
3. Enable Realtime on key tables (activities, payment_requests, invoices, escrows, exchange_offers, group_expenses)
4. Add credentials to `.env`

### Contract Deployment

All contracts are already live on Base Sepolia. To redeploy:

```bash
cd packages/contracts
cp .env.example .env
# Add deployer private key

npx hardhat compile
npx hardhat deploy-all --network base-sepolia
npx hardhat deploy-new-features --network base-sepolia
```

## Design

Light theme with glass morphism. Responsive — desktop sidebar with bento grid, mobile bottom nav with full-screen flows.

| Element | Spec |
|---------|------|
| Glass cards | `rgba(255,255,255,0.6)` + `blur(40px)` + `border: rgba(255,255,255,0.6)` |
| Primary text | `#1D1D1F` |
| Primary buttons | `#1D1D1F` background, white text, `rounded-full` |
| Card radius | `2rem` (32px) |
| FHE badge | Emerald pill with shield icon |
| Encrypted text | `blur(4px)` with 0.7s cubic-bezier transition |
| Headings | Outfit font |
| Body | Inter font |
| Financial data | JetBrains Mono with `tabular-nums` |

## Security Measures

| Measure | Description |
|---------|-------------|
| ReentrancyGuard | Storage-variable approach on 35+ functions, proxy-safe |
| FHE.select() | Privacy-preserving balance checks — never reverts |
| Receipt verification | Every tx receipt checked for revert before Supabase write |
| Approval cache | 24-hour TTL, auto-clears on on-chain revert |
| Stealth anti-frontrun | Claim codes bound to `keccak256(code, msg.sender)` |
| Input validation | Address regex, amount bounds, note length on all forms |
| Authorized callers | Whitelist on PaymentReceipts.issueReceipt |
| Double-submit guards | Ref-based locks on all async operations |
| Cross-tab sync | BroadcastChannel API for multi-tab state coherence |
| Permit expiry | 30-second polling with proactive renewal warnings |

## Project Structure

```
Blank/
├── packages/
│   ├── app/                    # Frontend application
│   │   ├── src/
│   │   │   ├── blank-ui/       # Design system + screens
│   │   │   │   ├── components/ # Glass cards, buttons, inputs, badges
│   │   │   │   ├── screens/    # 17 page components
│   │   │   │   ├── theme.css   # Light theme design tokens
│   │   │   │   └── BlankApp.tsx
│   │   │   ├── hooks/          # 18 custom hooks (contract + data)
│   │   │   ├── lib/            # ABIs, constants, utilities
│   │   │   └── providers/      # wagmi, cofhe, query providers
│   │   └── supabase/
│   │       └── schema.sql      # Database schema (10 tables)
│   └── contracts/              # Smart contracts
│       ├── contracts/          # 16 Solidity files
│       ├── deployments/        # Deployed addresses
│       └── tasks/              # Deployment scripts
├── package.json
└── pnpm-workspace.yaml
```

## License

[MIT](LICENSE)
