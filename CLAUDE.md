# CLAUDE.md — Encrypted Payment Super-App (Fhenix Buildathon)

## Project Overview

Building a production-quality encrypted payment super-app on Fhenix CoFHE (Base Sepolia). Every financial amount is encrypted using Fully Homomorphic Encryption. Social context (who, when, why) is public. Financial details (how much) are private.

## REQUIRED SKILLS (Auto-Activate During Development)

### Frontend UI Development — MUST use these skills:
- **ui-ux-pro-max** — Full design intelligence (50+ styles, 161 palettes, 99 UX guidelines). Run `--design-system` before building ANY page. Follow the Quick Reference checklist (Priority 1-10) for every component.
- **frontend-design** — Production-grade interface quality
- **ui-styling** — Tailwind + shadcn/ui patterns
- **tailwind-theme-builder** — Theme setup and dark mode
- **aesthetic** — Design quality standards
- **typography** — Proper typographic rules (quotes, dashes, spacing)
- **color-palette** — Accessible color scale generation
- **web-design-patterns** — Card, CTA, hero, testimonial patterns
- **web-design-methodology** — BEM, responsive, accessibility, CSS architecture

### Smart Contract Development — MUST use these skills:
- **solidity-security** — Security patterns, vulnerability prevention
- **software-architecture** — Code quality standards
- **architecture** — System design decisions

### Before Delivery — MUST run:
- **ui-ux-pro-max** Pre-Delivery Checklist (Visual Quality + Interaction + Light/Dark Mode + Layout + Accessibility)
- **code-review** on all code
- **security-audit** on all contracts

### UI/UX Pro Max — Key Rules for This Project:
1. **Accessibility (CRITICAL):** Contrast 4.5:1, focus rings, aria-labels, keyboard nav, reduced-motion support
2. **Touch & Interaction (CRITICAL):** Min 44×44px targets, 8px spacing, loading feedback on all async FHE operations
3. **Performance (HIGH):** Skeleton/shimmer for FHE decryption (>1s), lazy load routes, virtualize lists
4. **Style:** Dark glassmorphism with emerald accent — see DESIGN_SYSTEM.md
5. **Animation:** 150-300ms micro-interactions, spring physics, page blur transitions, stagger 30-50ms per list item
6. **Forms:** Visible labels (never placeholder-only), error near field, encryption progress as multi-step indicator
7. **Navigation:** Bottom nav ≤5 items (mobile), sidebar (desktop), layoutId sliding pill indicator
8. **No emoji as icons** — Use Lucide React exclusively
9. **JetBrains Mono** for all financial numbers (tabular figures prevent layout shift)
10. **Every encrypted amount** shows as "████.██" with tap-to-reveal (10s auto-hide)

## SUBAGENT USAGE — MAXIMUM ALWAYS

**USE SUBAGENTS AS MUCH AS POSSIBLE.** This is a core rule:
- Spawn subagents aggressively for research, exploration, parallel file reads, code review, testing
- Never serialize what can be parallelized — if 3 files need reading, spawn 3 subagents
- Use specialized agents automatically: Explore, code-reviewer, code-architect, code-explorer, silent-failure-hunter, type-design-analyzer, build-error-resolver
- Use background agents for long-running tasks while continuing other work
- Chain agents — use one agent's output to feed the next
- No compute budget anxiety — subagents are free, use them liberally
- Before every task, ask: "Can I parallelize this with subagents?" If yes, DO IT.

## ABSOLUTE RULES

### 1. NEVER GUESS — ALWAYS READ THE DOCS
Before writing ANY Fhenix/CoFHE code:
1. **STOP** — Do NOT write from memory
2. **READ** — Open the relevant source file from the local repos below
3. **VERIFY** — Confirm types, methods, function signatures, gas costs
4. **CITE** — Note which file the information came from

A single wrong FHE type or operation = broken contract. The docs are LOCAL — reading costs nothing. Guessing costs everything.

### 2. ZERO COMPROMISE ON QUALITY
- Every contract MUST be production-grade, not hackathon-sloppy
- Every function MUST have proper access control (FHE.allowThis, FHE.allowSender, FHE.allow)
- Every encrypted operation MUST use the smallest possible type (euint8 over euint64 when possible)
- Every frontend component MUST handle loading states (FHE operations are async)
- Test EVERYTHING with mock contracts before testnet
- No shortcuts, no "we'll fix later", no TODO comments left in production code

### 3. USE SUBAGENTS AGGRESSIVELY
- Spawn Explore agents for codebase research
- Spawn code-reviewer agents after writing any code
- Spawn code-architect agents before implementing features
- Spawn build-error-resolver agents when builds fail
- Run multiple subagents in parallel whenever possible
- Never serialize work that can be parallelized

### 4. SMART CONTRACT SECURITY
- All encrypted state variables MUST be private (not public)
- All functions returning encrypted data MUST use permit-based access control
- NEVER pass raw euint64 handles between contracts — each contract manages its own FHE state
- Use ReentrancyGuard (nonReentrant) on ALL shield/unshield/transfer functions
- All contracts MUST use UUPS upgradeable proxy pattern
- Always call FHE.allowThis() after modifying encrypted state
- Always call FHE.allowSender() when users need to read their data
- Check for integer overflow (FHE arithmetic is unchecked/wrapping)
- Division by zero returns MAX_UINT — handle this
- NEVER use securityZone != 0. All FHE operations use zone 0. Anything else is a bug.

### 5. FHE.req() vs FHE.select() RULES
- In TRANSACTIONS: Use FHE.select() for balance checks (returns ebool success, never reverts)
  This preserves privacy — a revert would leak "balance < amount"
- In VIEW FUNCTIONS: Can use FHE.req() since no state change
- In SHIELD/UNSHIELD: Use plaintext require() since amounts are already public
- Return ebool from transfer functions so frontend can check if transfer succeeded

### 6. DIVISION IS NOT SUPPORTED ON euint64
- div() and rem() only work on euint8, euint16, euint32
- For splits/percentages: ALWAYS pre-compute shares off-chain, encrypt individually, submit as separate inputs
- For "divide by N": use multiplication trick (amount * 1/N as fixed-point) or shift right for powers of 2
- If you find yourself needing euint64 division, STOP and redesign

### 7. ASYNC DECRYPTION RULES
- FHE.decrypt() is ASYNC — the result is NOT available in the same transaction
- NEVER use tx.wait() for transactions containing decrypt()
- ALWAYS use the two-step pattern: requestDecrypt() → poll getDecryptResultSafe()
- Frontend MUST show "Decrypting..." state with progress indicator during polling
- Poll every 2 seconds, timeout after 60 seconds

### 8. GAS OPTIMIZATION
- euint8: ~40-65K gas per op — use for flags, small counters
- euint16: ~50-90K gas — use for moderate values
- euint32: ~65-130K gas — use for amounts up to ~4.2B
- euint64: ~120-300K gas — use for large amounts (primary for money)
- euint128: ~140-355K gas — avoid unless absolutely needed
- Division is 125K-1M+ gas and NOT supported on euint64 — NEVER attempt
- Encrypt constants once in constructor, reuse everywhere
- Batch payments: MAX 30 recipients per transaction (gas limit)
- Single transfer: ~1.2M gas. Budget accordingly.

### 9. APPROVAL MANAGEMENT
- Use LAZY approvals — approve a contract only when the user first uses that feature
- Use infinite approval (MAX_UINT256) for FHERC20Vault approvals
- Show clear UI: "First time! Approving encrypted transfers..." with one-click
- Never batch all approvals at onboarding — terrible UX

### 10. PERMIT MANAGEMENT
- Set permit expiry to 7 DAYS (long enough for use, short enough for security)
- Check permit expiry on app load — warn if <1 hour remaining
- Auto-prompt re-sign when expired
- Use DETERMINISTIC sealing key derivation from wallet signature for cross-device support
- Sealing key formula: keccak256(signMessage("Derive FHE sealing key for [AppName]")).slice(0, 32)

### 11. SUPABASE RULES
- Supabase is the NOTIFICATION layer, NOT the source of truth
- Source of truth is ALWAYS the blockchain
- Frontend writes to Supabase AFTER successful on-chain transaction
- If Supabase is down, fall back to querying EventHub on-chain events
- Cache events in localStorage with last-seen block number
- NEVER store encrypted amounts in Supabase — only public context (who, when, type, note)

## Local Documentation Repos (MUST READ, NEVER GUESS)

All docs are cloned locally at `C:\Users\prate\Downloads\fhenix builder\`.

### VERSION CHECK RULE:
Before using ANY doc repo for critical code (contract addresses, SDK methods, API signatures), check if a newer version exists on GitHub. Run `git -C <repo-path> fetch --dry-run` to see if remote has new commits. If yes, alert the user to `git pull`. Local docs may be stale — GitHub is the source of truth for latest versions.

### Complete Local Doc Inventory (6 repos):

| Repo | Local Path | GitHub | Purpose |
|------|-----------|--------|---------|
| **cofhesdk** | `C:\Users\prate\Downloads\fhenix builder\cofhesdk\` | https://github.com/FhenixProtocol/cofhe-sdk | Current SDK (v0.4.0) — encryption, decryption, React hooks, permits |
| **fhenix-developer-docs** | `C:\Users\prate\Downloads\fhenix builder\fhenix-developer-docs\` | https://github.com/fhenixprotocol/fhenix-developer-docs | Official current docs — FHE library, cofhejs, tutorials, deep-dive |
| **cofhe-hardhat-starter** | `C:\Users\prate\Downloads\fhenix builder\cofhe-hardhat-starter\` | https://github.com/FhenixProtocol/cofhe-hardhat-starter | Contract starter — deployment patterns, testing with mocks |
| **cofhejs** | `C:\Users\prate\Downloads\fhenix builder\cofhejs\` | https://github.com/FhenixProtocol/cofhejs | Older JS SDK — reference for encryption/decryption internals |
| **fhenix-docs** | `C:\Users\prate\Downloads\fhenix builder\fhenix-docs\` | https://github.com/FhenixProtocol/fhenix-docs | Old Nitrogen testnet docs — FHE patterns, gas costs, tutorials |
| **awesome-fhenix** | `C:\Users\prate\Downloads\fhenix builder\awesome-fhenix\` | https://github.com/FhenixProtocol/awesome-fhenix | Curated ecosystem — projects, tools, community resources |

---

### cofhesdk/ — THE REAL SDK (Use This)
**Local:** `C:\Users\prate\Downloads\fhenix builder\cofhesdk\`
**GitHub:** https://github.com/FhenixProtocol/cofhe-sdk
The monorepo with all current packages:
- `packages/sdk/` — @cofhe/sdk v0.4.0 (core client, encryption, decryption, permits)
- `packages/react/` — @cofhe/react v0.4.0 (30+ React hooks)
- `packages/abi/` — @cofhe/abi v0.4.0 (ABI utilities for encrypted types)
- `packages/hardhat-plugin/` — @cofhe/hardhat-plugin (testing)
- `packages/mock-contracts/` — @cofhe/mock-contracts (local testing)
- `examples/react/` — Full React example app
- `ARCHITECTURE.md` — 649-line architecture doc

**Key source files to READ before coding:**
- SDK client: `packages/sdk/core/client.ts`
- Encryption builder: `packages/sdk/core/encrypt/encryptInputsBuilder.ts`
- Decryption: `packages/sdk/core/decrypt/decryptForViewBuilder.ts`
- Permits: `packages/sdk/permits/`
- React hooks: `packages/react/src/hooks/` (30+ hooks)
- Chain configs: `packages/sdk/chains/` (Base Sepolia, Arb Sepolia, Sepolia)
- Types: `packages/sdk/types/`

### cofhe-hardhat-starter/ — Contract Starter Template
**Local:** `C:\Users\prate\Downloads\fhenix builder\cofhe-hardhat-starter\`
**GitHub:** https://github.com/FhenixProtocol/cofhe-hardhat-starter
- `contracts/Counter.sol` — Example FHE contract patterns
- `hardhat.config.ts` — Network configuration (Base Sepolia, Arb Sepolia)
- `test/Counter.test.ts` — How to test with mock FHE
- `tasks/` — Deployment and interaction patterns

**Key packages (from package.json):**
- `@fhenixprotocol/cofhe-contracts` v0.0.13 — FHE.sol Solidity library
- `cofhe-hardhat-plugin` v0.3.1 — Hardhat plugin
- `cofhejs` v0.3.1 — JS encryption library
- `@fhenixprotocol/cofhe-mock-contracts` v0.3.1 — Mock contracts for testing

### cofhejs/ — Older SDK (Reference Only)
**Local:** `C:\Users\prate\Downloads\fhenix builder\cofhejs\`
**GitHub:** https://github.com/FhenixProtocol/cofhejs
Useful for understanding encryption/decryption internals, but cofhesdk is the current SDK.

### fhenix-developer-docs/ — Official Fhenix Developer Documentation (CURRENT)
**Local:** `C:\Users\prate\Downloads\fhenix builder\fhenix-developer-docs\`
**GitHub:** https://github.com/fhenixprotocol/fhenix-developer-docs
**Format:** Mintlify MDX (69 doc files)
**Use for:** Current CoFHE documentation, cofhejs guides, FHE library reference, tutorials

**Navigation (from docs.json):**
- **Get Started** — Introduction (what is Fhenix, compatibility, support), Build with AI, Builder Support
- **FHE Library** — Core Concepts (access control, conditions, decryption, encrypted ops, gas benchmarks, inputs, randomness, require, trivial encryption), Confidential Contracts/FHERC20 (overview, core features, permits, wrapper, operators, callbacks, best practices), Reference (FHE.sol, CoFHE errors)
- **cofhejs** — Overview, Mental Model, Installation, Encryption guide, Permits management, Sealing/unsealing, Error handling, End-to-end example, Templates
- **Deep Dive** — CoFHE Components (ACL, CT Registry, FHEOS Server, Plaintext Storage, Result Processor, Slim Listener, Task Manager, Threshold Network, ZK Verifier), Data Flows (encryption, FHE operation, decryption, decrypt from cofhejs), Research
- **Tutorials** — Your first FHE contract, Adding FHE to existing contract, ACL usage examples, Migrating to CoFHE
- **API Reference** — Endpoints (create, get, delete, webhook)

**Key files to READ:**
- FHE.sol reference: `fhe-library/reference/fhe-sol.mdx`
- Access control: `fhe-library/core-concepts/access-control.mdx`
- Encrypted operations: `fhe-library/core-concepts/encrypted-operations.mdx`
- Gas benchmarks: `fhe-library/core-concepts/gas-and-benchmarks.mdx`
- FHERC20 overview: `fhe-library/confidential-contracts/fherc20/overview.mdx`
- cofhejs encryption: `cofhejs/guides/encryption.mdx`
- cofhejs permits: `cofhejs/guides/permits-management.mdx`
- cofhejs sealing: `cofhejs/guides/sealing-unsealing.mdx`
- First FHE contract tutorial: `tutorials/your-first-fhe-contract.mdx`
- CoFHE architecture overview: `deep-dive/cofhe-components/overview.mdx`

### awesome-fhenix/ — Curated Fhenix Ecosystem Resources
**Local:** `C:\Users\prate\Downloads\fhenix builder\awesome-fhenix\`
**GitHub:** https://github.com/FhenixProtocol/awesome-fhenix
**Use for:** Ecosystem projects, example apps, tools, and community resources
**Key file:** `README.md` — Curated list of Fhenix projects, tools, and references
**Data directory:** `data/` — Structured ecosystem data

### fhenix-docs/ — Old Nitrogen Testnet Docs (Reference for FHE Patterns)
**Local:** `C:\Users\prate\Downloads\fhenix builder\fhenix-docs\`
**GitHub:** https://github.com/FhenixProtocol/fhenix-docs
- `docs/devdocs/Solidity API/FHE.md` — Complete FHE operations reference
- `docs/devdocs/Writing Smart Contracts/Types-and-Operators.md` — Type support matrix
- `docs/devdocs/Writing Smart Contracts/Gas-and-Benchmarks.md` — Gas costs
- `docs/devdocs/Encryption and Privacy/Permits-Access-Control.md` — Access control
- `docs/devdocs/Encryption and Privacy/Privacy-Web3.md` — Privacy best practices
- `docs/devdocs/Tutorials/` — Step-by-step tutorials
- `docs/devdocs/Examples and References/Examples-fheDapps.md` — Example dApps
- `docs/devdocs/Writing Smart Contracts/Randomness.md` — Encrypted random generation

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Chain | Base Sepolia (Chain ID: 84532) |
| Smart Contracts | Solidity 0.8.25 + @fhenixprotocol/cofhe-contracts (FHE.sol) |
| Contract Framework | Hardhat + cofhe-hardhat-plugin |
| Testing | Hardhat + @cofhe/mock-contracts |
| SDK | @cofhe/sdk v0.4.0 |
| React Hooks | @cofhe/react v0.4.0 |
| Frontend | Next.js 14+ (App Router) + TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| Wallet Connection | wagmi + viem (cofhe SDK has adapters) |
| State Management | React Query + @cofhe/react hooks (Zustand under the hood) |
| Local Storage | localStorage for contacts, IndexedDB for permits (SDK handles) |
| Deployment | Vercel (frontend) + Hardhat deploy (contracts) |

## CoFHE Infrastructure URLs

| Service | URL |
|---------|-----|
| CoFHE API | https://testnet-cofhe.fhenix.zone |
| ZK Verifier | https://testnet-cofhe-vrf.fhenix.zone |
| Threshold Network | https://testnet-cofhe-tn.fhenix.zone |

## Supported Encrypted Types & Operations

| Type | Bits | Use For |
|------|------|---------|
| euint8 | 8 | Flags, categories, small counters |
| euint16 | 16 | Medium counters |
| euint32 | 32 | Amounts up to ~4.2B (use for most things) |
| euint64 | 64 | Large amounts (primary for money/balances) |
| euint128 | 128 | Very large amounts (avoid if possible — expensive) |
| ebool | 8 (as euint8) | Encrypted booleans |
| eaddress | 160 | Encrypted addresses |

**Operations available on euint8-128:** add, sub, mul, div, rem, eq, ne, gt, gte, lt, lte, min, max, and, or, xor, not, shl, shr, rol, ror, select, decrypt, square

**Operations on ebool:** and, or, xor, not, eq, ne, select, decrypt

**Operations on eaddress:** eq, ne, select, decrypt

## React Hooks Reference (@cofhe/react)

**Must-use hooks for this project:**
- `useCofheConnection()` — wallet connection state
- `useCofheEncrypt()` — encrypt inputs before sending to contracts
- `useCofheReadContract()` — read + auto-decrypt encrypted returns
- `useCofheWriteContract()` — write with auto-encryption of inputs
- `useCofheActivePermit()` — manage active permit
- `useCofheTokenTransfer()` — FHERC-20 transfers
- `useCofheTokenShield()` — shield tokens
- `useCofheTokenUnshield()` — unshield tokens
- `useCofheTokenDecryptedBalance()` — read decrypted balance

**READ the actual hook source files before using them:**
`cofhesdk/packages/react/src/hooks/`

## FHE Access Control Pattern (MUST follow)

```solidity
// After EVERY operation that modifies encrypted state:
result = FHE.add(a, b);
FHE.allowThis(result);      // Contract can use it later
FHE.allowSender(result);    // User can read their own data

// For sharing with specific addresses:
FHE.allow(result, specificAddress);  // That address can access

// For cross-contract calls within same tx:
FHE.allowTransient(result, otherContract);
```

## Feature List (Final — Code Only, Zero External Dependencies)

### Core
- [x] Encrypted Wallet (shield/unshield/balance)
- [ ] P2P Send/Receive (encrypted amounts)
- [ ] Payment Requests (encrypted)
- [ ] QR Code Pay
- [ ] Payment Links
- [ ] Batch Send

### Social
- [ ] Activity Feed (public context, private amounts)
- [ ] Group Splits
- [ ] Group Fund
- [ ] Creator Tips (with encrypted tiers)
- [ ] Donations
- [ ] Gift Money

### Business
- [ ] Invoicing
- [ ] Payroll (batch)
- [ ] Escrow (2-of-2 approval)
- [ ] Multi-Sig (N-of-M)
- [ ] Expense Reports
- [ ] Vendor Management

### Other
- [ ] P2P Exchange (atomic swap)
- [ ] Inheritance (dead man's switch)
- [ ] Privacy Controls (self/sharing/audit permits)
- [ ] Contacts/Address Book
- [ ] Export Statements (CSV/PDF)

## Workflow Rules

1. **Plan before coding** — Use plan mode for any non-trivial feature
2. **Read docs before writing FHE code** — ALWAYS open the source file first
3. **Test with mocks first** — Never deploy untested contracts to testnet
4. **Review after writing** — Launch code-reviewer subagent after every significant code block
5. **Track progress** — Update the feature checklist above as features are completed
6. **Git discipline** — Commit after each completed feature, descriptive messages
7. **No dead code** — Remove unused imports, variables, functions immediately
8. **Handle async FHE** — Every decrypt/unseal needs loading states in UI
