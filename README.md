<div align="center">

<img src="https://img.shields.io/badge/Base-Sepolia-0052FF?style=for-the-badge&logo=coinbase&logoColor=white" alt="Base" />
<img src="https://img.shields.io/badge/FHE-Encrypted-8B5CF6?style=for-the-badge&logo=shield&logoColor=white" alt="FHE" />
<img src="https://img.shields.io/badge/Solidity-0.8.25-363636?style=for-the-badge&logo=solidity&logoColor=white" alt="Solidity" />
<img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
<img src="https://img.shields.io/badge/CoFHE-SDK-10B981?style=for-the-badge&logo=lock&logoColor=white" alt="CoFHE" />
<img src="https://img.shields.io/badge/Contracts-16-F59E0B?style=for-the-badge" alt="Contracts" />
<img src="https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge" alt="MIT" />

<br /><br />

# Blank

### Private payments for the real world.

Blank is an encrypted payment platform where transaction amounts are invisible on-chain.<br />
Built on Fully Homomorphic Encryption. The blockchain processes data it cannot read.

[Launch App](https://blank-omega-jade.vercel.app) &nbsp;&middot;&nbsp; [View Contracts](#deployed-contracts) &nbsp;&middot;&nbsp; [Architecture](#architecture)

</div>

---

## The Problem

Every transaction on a public blockchain is a postcard. Amount, sender, receiver &mdash; all visible to anyone with a block explorer.

| Consequence | Scale |
|------------|-------|
| MEV sandwich bots exploiting visible swap amounts | **$900M+ extracted** (2023) |
| Hardware wallet breaches leaking home addresses | **272K addresses exposed** |
| Enterprise adoption stalled | Competitors map supply chains from payment flows |
| DAO salary transparency | Every contributor's compensation visible to every holder |
| Targeted physical attacks | High-balance wallets become robbery targets |

Financial privacy isn't a feature. It's missing infrastructure.

---

## How It Works

Blank encrypts every financial amount using **Fully Homomorphic Encryption** &mdash; computation on encrypted data without decryption. Smart contracts add, compare, and transfer encrypted values. The plaintext never touches the blockchain.

```
You type:         $250.00
SDK encrypts:     ZK proof + TFHE ciphertext (generated in Web Worker)
CoFHE verifies:   ECDSA signature from threshold network
Chain stores:     0x7a3f...encrypted ciphertext handle...9e2b
Contract computes: FHE.add(balance, amount) — on encrypted data
Recipient sees:   $250.00 (unsealed with their FHE permit)
Everyone else:    $████.██
```

No trusted intermediary. No TEE. No MPC with threshold assumptions. Pure math.

---

## Encryption Pipeline

```
                    CLIENT                          OFF-CHAIN                       ON-CHAIN
                      │                                │                               │
    User enters $250  │                                │                               │
          ┌───────────┤                                │                               │
          │ @cofhe/sdk│                                │                               │
          │ (dynamic) │                                │                               │
          ├───────────┤                                │                               │
          │ TFHE WASM │  ZK Proof of Knowledge         │                               │
          │ in Worker ├───────────────────────────────►│ CoFHE ZK Verifier             │
          │           │                                │ POST /verify                  │
          │           │  { ctHash, signature }         │ Validates proof               │
          │           │◄───────────────────────────────┤ Signs with ECDSA              │
          ├───────────┤                                │                               │
          │ wagmi     │  writeContractAsync({          │                               │
          │           │    ctHash, signature,           │                               │
          │           │    securityZone, utype          │                               │
          │           │  })                             │                               │
          │           ├────────────────────────────────┼──────────────────────────────►│
          │           │                                │                    TaskManager│
          │           │                                │                    ecrecover  │
          │           │                                │                    ✓ verified │
          │           │                                │                               │
          │           │                                │              FHE.asEuint64()  │
          │           │                                │              FHE.add()        │
          │           │                                │              FHE.select()     │
          │           │                                │              FHE.allowThis()  │
          │           │                                │              FHE.allowSender()│
          └───────────┘                                └───────────────────────────────┘
```

Every encrypted input passes through:
1. **Client-side TFHE encryption** &mdash; plaintext never leaves the browser
2. **Zero-Knowledge proof generation** &mdash; proves knowledge without revealing value
3. **Off-chain verification** &mdash; CoFHE threshold network signs the proof
4. **On-chain signature check** &mdash; TaskManager validates via `ecrecover`
5. **Homomorphic computation** &mdash; smart contract operates on ciphertext

---

## Features

<table>
<tr>
<td width="50%">

### Payments
- Encrypted wallet (shield / unshield)
- P2P transfers with encrypted amounts
- Payment requests with create / fulfill / cancel
- QR codes and payment links
- Batch send (up to 30 recipients)

### Social
- Group expense splitting (equal + custom splits)
- Quadratic encrypted voting on expenses
- Creator tips with dynamic tier badges
- Gift envelopes (equal / random splits with expiry)
- Stealth payments via anonymous claim codes

</td>
<td width="50%">

### Business
- Encrypted invoicing with 2-phase verification
- Batch payroll (employees can't see each other's pay)
- Escrow with 2-of-2 approval + arbiter disputes
- P2P exchange with encrypted settlement

### Privacy Infrastructure
- Dead man's switch inheritance with vault transfer
- Cryptographic receipts with FHE-random IDs
- FHE permit management with local access tracking
- 30-day stealth payment refunds

</td>
</tr>
</table>

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Frontend                                                                 │
│  React 18 · Vite 5 · TypeScript · Tailwind · wagmi · viem                │
│  @cofhe/sdk (dynamic WASM) · Framer Motion · Supabase Realtime           │
│                                                                           │
│  23 screens · 15 hooks · 99 aria-labels · WCAG AA compliant              │
├──────────────────────────────────────────────────────────────────────────┤
│  Smart Contracts (16 deployed on Base Sepolia)                            │
│  Solidity 0.8.25 · UUPS upgradeable proxies · FHE.sol v0.0.13           │
│  28 unique FHE operations · ReentrancyGuard on all state-changing fns    │
├──────────────────────────────────────────────────────────────────────────┤
│  FHE Coprocessor (Fhenix CoFHE)                                          │
│  Threshold Network · ZK Verifier · TaskManager Precompile                │
│  ECDSA signature verification · Async decryption via permits             │
├──────────────────────────────────────────────────────────────────────────┤
│  Data Layer                                                               │
│  Supabase (notification layer, NOT source of truth)                      │
│  Blockchain is always authoritative · Realtime on 8 tables               │
│  localStorage fallback for offline mode                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Deployed Contracts

All contracts are UUPS-upgradeable proxies deployed on **Base Sepolia (Chain ID: 84532)**.

| Contract | Address | Purpose |
|----------|---------|---------|
| **TestUSDC** | `0x6377...0b1a` | Test ERC-20 token with faucet |
| **FHERC20Vault** | `0x789f...ff23` | Encrypted token vault &mdash; shield, unshield, transfer |
| **PaymentHub** | `0xF420...e831` | P2P payments, requests, batch send |
| **GroupManager** | `0x1749...9D3d` | Group expenses, quadratic voting, debt settlement |
| **CreatorHub** | `0x5dc3...12ea` | Creator profiles, encrypted tips, tier badges |
| **BusinessHub** | `0xEfD6...1EFD` | Invoicing, payroll, escrow with arbiter |
| **P2PExchange** | `0xDa60...f116` | Atomic swaps with encrypted settlement |
| **StealthPayments** | `0x98Df...1C97` | Anonymous transfers via claim codes |
| **GiftMoney** | `0x8cf2...5b8c` | Encrypted gift envelopes with expiry |
| **PrivacyRouter** | `0x30E7...Cc7B` | Decrypt-swap-re-encrypt pipeline |
| **InheritanceManager** | `0x2897...73d5` | Dead man's switch with vault transfer |
| **PaymentReceipts** | `0x23f0...AD7c` | Cryptographic receipts with FHE-random IDs |
| **EncryptedFlags** | `0x75FF...DA75` | Compliance engine with encrypted KYC flags |
| **EventHub** | `0xD764...a590` | Unified event aggregation |
| **TokenRegistry** | `0x6889...Ec2E` | ERC-20 to vault mapping |
| **MockDEX** | `0xb202...4821` | Test exchange for privacy router |

---

## FHE Operations

28 unique operations across all contracts:

| Category | Operations | Why |
|----------|-----------|-----|
| **Arithmetic** | `add` `sub` `mul` `square` | Encrypted balance math |
| **Comparison** | `eq` `ne` `gt` `gte` `lt` `lte` `min` `max` | Conditional logic without branching |
| **Bitwise** | `and` `or` `xor` `not` `shl` `shr` | Flag manipulation |
| **Control** | `select` `req` | Privacy-preserving conditionals |
| **Access** | `allowThis` `allowSender` `allow` `allowTransient` | Fine-grained ciphertext permissions |
| **Decrypt** | `decrypt` `getDecryptResultSafe` | Async decryption via threshold network |
| **Random** | `randomEuint64` | On-chain encrypted randomness |

### Why `FHE.select()` instead of `require()`

```solidity
// WRONG: require() leaks information via revert
require(balance >= amount, "Insufficient"); // Attacker learns: balance < amount

// RIGHT: select() preserves privacy
euint64 newBalance = FHE.select(
    FHE.gte(balance, amount),    // encrypted comparison
    FHE.sub(balance, amount),    // if true: deduct
    balance                       // if false: no change, no revert
);
```

A revert is a 1-bit information leak. Enough reverts reconstruct the balance. `FHE.select()` always succeeds &mdash; the result is encrypted, the observer learns nothing.

---

## Security Model

| Layer | Measure | Detail |
|-------|---------|--------|
| **Contract** | Reentrancy protection | Custom `nonReentrant` guard on 35+ functions |
| **Privacy** | `FHE.select()` over `require()` | Zero information leakage from transaction outcomes |
| **Encryption** | ZK-verified inputs | Every encrypted value signed by CoFHE threshold network |
| **Access Control** | 4-tier ACL | `allowThis` → `allowSender` → `allow` → `allowTransient` |
| **Anti-frontrunning** | Stealth claim codes | Bound to `keccak256(code, claimer)` &mdash; unusable by interceptor |
| **Frontend** | Input validation | `isAddress()` from viem on all address inputs |
| **Frontend** | parseUnits guards | Empty string checks before every `parseUnits` / `parseFloat` |
| **UX** | No silent failures | Toast feedback on every disabled button and validation error |
| **Accessibility** | WCAG AA | 99 aria-labels, 44px touch targets, keyboard focus indicators |
| **Upgrades** | UUPS proxy | All 16 contracts upgradeable without state loss |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Chain** | Base Sepolia (EVM L2, Chain ID: 84532) |
| **Contracts** | Solidity 0.8.25 + @fhenixprotocol/cofhe-contracts v0.0.13 |
| **FHE Encryption** | @cofhe/sdk v0.4.0 (dynamic WASM, Web Workers for ZK proofs) |
| **Contract Framework** | Hardhat + cofhe-hardhat-plugin v0.3.1 |
| **Frontend** | React 18, Vite 5, TypeScript 5.5 |
| **Styling** | Tailwind CSS + glass morphism design system |
| **Wallet** | wagmi 2.17 + viem 2.38 |
| **State** | React Query + module-level singletons for cross-route persistence |
| **Realtime** | Supabase (8 tables with realtime subscriptions) |
| **Animation** | Framer Motion |
| **Deployment** | Vercel (frontend) + Hardhat tasks (contracts) |

---

## Development

```bash
# Clone
git clone https://github.com/Pratiikpy/Blank.git
cd Blank && pnpm install

# Frontend
cd packages/app
cp .env.example .env    # Add Supabase keys (optional)
pnpm dev                # http://localhost:3000

# Contracts
cd packages/contracts
cp .env.example .env    # Add PRIVATE_KEY + RPC URLs
npx hardhat compile
npx hardhat test

# Deploy to Base Sepolia
npx hardhat deploy-all --network base-sepolia
npx hardhat deploy-remaining --network base-sepolia
npx hardhat deploy-fhe-extras --network base-sepolia
npx hardhat deploy-new-features --network base-sepolia
```

---

## Project Structure

```
Blank/
├── packages/
│   ├── app/                          # React frontend
│   │   ├── src/
│   │   │   ├── blank-ui/
│   │   │   │   ├── screens/          # 23 screen components
│   │   │   │   ├── components/       # Shared UI (GlobalSearch, Keypad, Sidebar)
│   │   │   │   └── theme.css         # Glass morphism design system
│   │   │   ├── hooks/                # 15 custom hooks (shield, send, groups, etc.)
│   │   │   ├── lib/
│   │   │   │   ├── cofhe-shim.ts     # Dynamic @cofhe/sdk integration (bypasses MUI crash)
│   │   │   │   ├── constants.ts      # 16 contract addresses
│   │   │   │   ├── abis.ts           # All contract ABIs with InEuint64 tuples
│   │   │   │   └── supabase.ts       # Notification layer (NOT source of truth)
│   │   │   └── providers/            # Wagmi + React Query setup
│   │   ├── vite.config.ts            # WASM + top-level-await + @cofhe/react alias
│   │   └── vercel.json               # SPA rewrites
│   │
│   └── contracts/                    # Solidity smart contracts
│       ├── contracts/
│       │   ├── FHERC20Vault.sol      # Core encrypted token vault
│       │   ├── PaymentHub.sol        # P2P payments + requests
│       │   ├── GroupManager.sol      # Group expenses + voting
│       │   ├── CreatorHub.sol        # Creator economy
│       │   ├── BusinessHub.sol       # Invoicing + payroll + escrow
│       │   ├── P2PExchange.sol       # Atomic swaps
│       │   ├── StealthPayments.sol   # Anonymous transfers
│       │   ├── GiftMoney.sol         # Gift envelopes
│       │   ├── InheritanceManager.sol # Dead man's switch
│       │   └── ...                   # 7 more contracts
│       ├── tasks/                    # Deployment scripts (4 phases)
│       └── deployments/              # Deployed addresses per network
│

```

---

## Key Technical Decisions

### Why a shim instead of `@cofhe/react`?

`@cofhe/react` imports `@mui/material` which causes a production build crash (`isValidElementType` error from `react-is` version conflict). Our `cofhe-shim.ts` dynamically imports `@cofhe/sdk` at runtime, performs real TFHE encryption with ZK proofs, and falls back gracefully if WASM fails to load.

### Why manual gas limits?

The CoFHE TaskManager precompile doesn't execute during `eth_estimateGas` simulation. Without manual limits, viem defaults to 140M gas which exceeds the 25M block gas limit. All 55 `writeContractAsync` calls use `gas: BigInt(5_000_000)`.

### Why module-level singleton state for send flow?

React Router navigates between `/send/contacts` → `/send/amount` → `/send/confirm` → `/send/success`. Each route mounts a fresh component. `useState` dies on unmount. A module-level singleton persists the recipient, amount, and step across all 4 pages.

### Why Supabase is NOT the source of truth?

Supabase stores notifications and activity cache. Every write happens AFTER on-chain transaction confirmation. If Supabase is down, the app falls back to on-chain events. Encrypted amounts are NEVER stored in Supabase &mdash; only public context (who, when, type, note).

---

## License

MIT
