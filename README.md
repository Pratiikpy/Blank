<div align="center">

# Blank

**Private payments for the open blockchain.**

Blank encrypts every transaction amount using Fully Homomorphic Encryption.
Smart contracts process your money without ever seeing the numbers.

[Launch App](https://blank-omega-jade.vercel.app) · [How It Works](#how-it-works) · [Features](#features)

</div>

---

## Why Blank

Every payment on a public blockchain is visible to everyone. Your salary, your purchases, your savings — all exposed on a block explorer. This limits real-world adoption for individuals and makes enterprise use impossible.

Blank fixes this. Transaction amounts are encrypted before they touch the chain. The blockchain computes on data it cannot read. Only sender and recipient can see the value.

No trusted intermediary. No hardware enclaves. Pure cryptography.

---

## How It Works

```
You send $250         →  Encrypted in your browser (TFHE + ZK proof)
Smart contract runs   →  FHE.add(balance, amount) on ciphertext
Recipient receives    →  Decrypts $250 with their key
Everyone else sees    →  $████.██
```

Blank uses **Fhenix CoFHE** — a Fully Homomorphic Encryption coprocessor — to perform arithmetic on encrypted values directly inside smart contracts. Amounts never exist as plaintext on-chain.

---

## Features

### Payments
- **Encrypted transfers** — Send money with amounts hidden from the public chain
- **Payment requests** — Request money from anyone, fulfill or cancel anytime
- **Batch payments** — Send to up to 30 recipients in a single transaction
- **QR codes & payment links** — Share a link, get paid instantly

### Business
- **Encrypted invoicing** — Create invoices where only vendor and client see the amount. Two-phase verification ensures payment matches the invoice
- **Confidential payroll** — Run batch payroll where employees cannot see each other's compensation
- **Escrow** — Lock funds with optional arbiter for dispute resolution

### Social
- **Group expenses** — Split bills with encrypted amounts and quadratic voting on disputes
- **Gift envelopes** — Send encrypted gifts to multiple recipients with equal or random splits
- **Creator support** — Tip creators with dynamic tier badges, all amounts private
- **Stealth payments** — Anonymous transfers via one-time claim codes. 30-day refund window

### Privacy Infrastructure
- **Shield / Unshield** — Move between plaintext and encrypted token vaults
- **Inheritance planning** — Dead man's switch with automatic vault transfer to beneficiaries
- **Qualification proofs** — Prove "income above $X" or "balance above $Y" without revealing the actual number
- **P2P exchange** — Atomic swaps with encrypted settlement amounts

---

## Wallet Support

Blank supports two wallet paths:

| Path | How It Works | Gas |
|------|-------------|-----|
| **Passkey (recommended)** | Create a wallet with just a passphrase. No extension needed. Uses ERC-4337 account abstraction with P-256 passkey signing. | Sponsored (free) via Paymaster |
| **MetaMask / EOA** | Connect any injected wallet. Standard transaction signing. | User pays gas |

Both paths use the same encrypted contracts. The passkey wallet batches multiple operations into a single transaction for better UX.

---

## Architecture

```
Frontend            React · Vite · TypeScript · Tailwind · wagmi
                    23 screens · 15 hooks · WCAG AA accessible

Smart Contracts     16 UUPS-upgradeable contracts on Base Sepolia
                    Solidity 0.8.25 · Fhenix CoFHE FHE operations

FHE Coprocessor     Fhenix CoFHE Threshold Network
                    Client-side TFHE encryption · ZK proof verification
                    Async decryption via permits

Data Layer          Supabase for notifications and activity feed
                    Blockchain is always the source of truth
```

---

## Deployed Contracts

Live on **Base Sepolia** (Chain ID: 84532).

| Contract | Purpose |
|----------|---------|
| **FHERC20Vault** | Encrypted token vault — shield, unshield, encrypted transfers |
| **PaymentHub** | P2P payments, payment requests, batch send |
| **BusinessHub** | Invoicing, payroll, escrow with arbiter disputes |
| **GroupManager** | Group expenses, quadratic voting, debt settlement |
| **StealthPayments** | Anonymous transfers via claim codes |
| **GiftMoney** | Encrypted gift envelopes with expiry |
| **P2PExchange** | Atomic swaps with encrypted settlement |
| **CreatorHub** | Creator profiles, encrypted tips, tier badges |
| **InheritanceManager** | Dead man's switch with vault transfer |
| **PaymentReceipts** | Cryptographic qualification proofs |
| **BlankAccountFactory** | ERC-4337 smart wallet factory (passkey-based) |
| **BlankPaymaster** | Gas sponsorship for smart wallet users |

All contracts are also deployed on Ethereum Sepolia (Chain ID: 11155111) for dual-chain support.

---

## Security

- **No information leakage** — Uses `FHE.select()` instead of `require()` to prevent balance inference from reverts
- **Reentrancy protection** — Custom guard on all state-changing functions
- **ZK-verified inputs** — Every encrypted value signed by CoFHE threshold network before on-chain use
- **Non-custodial** — No server ever holds user funds or private keys
- **Stealth claim binding** — Claim codes bound to `keccak256(code, claimer)`, unusable by interceptors
- **UUPS upgradeable** — All contracts upgradeable without state migration

---

## Development

```bash
git clone https://github.com/Pratiikpy/Blank.git
cd Blank && pnpm install

# Frontend
cd packages/app
cp .env.example .env
pnpm dev

# Contracts
cd packages/contracts
cp .env.example .env
npx hardhat compile
npx hardhat test
```

---

## License

MIT
