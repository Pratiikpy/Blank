# CoFHE 0.5.1 to 0.7.1 migration — proof record

Run 2026-08-26. Branch `cofhe-0.7-migration`. Every line below is a measured
result, with the transaction or command that produced it.

---

## Why this happened

Fhenix upgraded the on-chain CoFHE `TaskManager` in place. The single-input
verification path our contracts used (`ITaskManager.verifyInput`) is gone from
the deployed implementation on all three chains, and the off-chain ZK verifier
rejects `0.5.1`-format proofs outright.

Measured before the migration, from the deployer:

| Chain | `@cofhe/sdk` 0.5.1 `encryptInputs().execute()` |
| --- | --- |
| Arbitrum Sepolia | FAILED `ZK_VERIFY_FAILED` |
| Ethereum Sepolia | FAILED `ZK_VERIFY_FAILED` |
| Base Sepolia | FAILED `ZK_VERIFY_FAILED` |

The CoFHE services were up and answering the whole time. They were refusing the
old proof format. Every flow where the user encrypts client-side was down:
send, request, invoice, escrow, group split, gift, claim link, storefront,
crowdfund, exchange, offramp, tip, proof, unshield. Shielding still worked,
because `shield(uint256)` takes a plaintext amount and encrypts inside the
contract, never touching the input-verification path.

This was an outage, not a planned upgrade.

---

## What changed

### Dependencies

| Package | From | To |
| --- | --- | --- |
| `@cofhe/sdk`, `@cofhe/react`, `@cofhe/abi` | 0.5.1 | 0.7.1 |
| `@cofhe/hardhat-plugin`, `@cofhe/mock-contracts` | 0.5.1 | 0.7.1 |
| `@fhenixprotocol/cofhe-contracts` | 0.1.3 | 0.2.0 |
| `@tanstack/react-query` | ^5.90.0 | ^5.90.20 (peer of `@cofhe/react` 0.7.1) |

`fhenix-confidential-contracts` is not used. solc stays at 0.8.25.

### Contracts

- **35** functions moved from `InEuintXX` to `externalEuintXX` + `bytes proof`.
- **7** needed a design decision rather than a rename: four array batches
  (`runPayroll`, `createEnvelope`, `finalizeClaim`, `batchSend`) and three
  multi-parameter functions (`addExpense`, `fillOffer`, `createOffer`).
  Named parameters were kept rather than collapsing them into array indices,
  so call sites stay readable. Each function's natspec states the batch order
  the client must encrypt in.
- **49** cross-contract handoffs moved from `FHE.allowTransient` + a bare
  `euint64` to `FHE.shareEuint64` / `FHE.receiveEuint64Param` /
  `receiveEuint64FromCall`. **50** now-redundant `allowTransient` grants deleted.

### Security consequence

`FHERC20Vault.transferVerified` and `transferFromVerified` previously accepted a
bare `euint64` from **any** caller, with no `FHE.isAllowed` guard anywhere in the
codebase (measured: zero occurrences). The vault holds `FHE.allowThis` on every
user balance, FHE operations check the *contract's* permission rather than the
caller's, and the handles are public:

```
balanceOf(victim) returns the raw ciphertext handle
  deployer  0x7ec8937da4962579743b374e4a4894cc13e7678876fa51872e2be3b0a40c0500
  Alice AA  0xbeefd75c99b244dc8bacf7b59546fe4fc5ea68473fb03f5eb3d85b400a6b0500
```

That is the decryption-oracle shape the 0.7 documentation describes. It was
never exploited here, so it is reported as a **confirmed precondition, not a
demonstrated exploit**. The migration closes it: `receiveEuint64Param` requires
that the caller actually shared the handle, so a ciphertext the vault merely
holds permission on can no longer be passed in.

Bare `euint` parameters on external functions: **6 before, 0 after.**

### Frontend

- The config key `react: { autogeneratePermits: true }` became
  `autogenerateACPs`. In 0.7 an unknown key **throws** at client construction,
  and the shim loads the SDK inside a `try`/`catch` that swallows the error, so
  the app would have degraded silently to "encryption unavailable" with nothing
  in the logs. This alone would have kept the app broken after every other fix.
- Permits renamed to ACPs in `lib/cofhe-shim.ts`: `client.permits.getActivePermit()`
  to `client.acp.getActiveACP()`, `getOrCreateSelfPermit` to `getOrCreateSelfACP`,
  `.withoutPermit()` to `.withoutACP()`. Names read from the `@cofhe/sdk` 0.7.1
  source, not guessed.
- `encryptInputsAsync` gained a **required** `consumingContract` parameter, which
  made the compiler enumerate all 31 call sites instead of leaving them to be
  found by hand.
- **36 ABI entries regenerated from the compiled artifacts** rather than
  hand-edited, so the frontend cannot drift from the deployed bytecode.
- The dead `USE_ATOMIC_ENCRYPT_WRITE` branch was removed. It was behind a
  constant-false flag, passed a plaintext amount to `sendPayment`, and depended
  on an SDK helper that no longer exists.

---

## The mistake that kept recurring

Naming the wrong consuming contract. The 0.7 verifier binds the consuming
contract into the signed digest, so getting it wrong **compiles, type-checks,
passes mocked tests, and reverts on chain**.

It was caught three separate times, never by a compiler:

1. **15 test call sites** pointed at the vault when BusinessHub, PaymentHub,
   GiftMoney or GroupManager is what runs `FHE.asEuint*`. Found by running the
   contract tests.
2. **4 frontend call sites** pointed at `TestUSDC` (an ERC-20 that never
   verifies anything) or at the vault for `sendPayment`. Found by auditing every
   site against the contract that actually consumes the handle.
3. **1 sweep-harness site** pointed at the vault for `ClaimLinks.createLink`.

Two permanent guards now exist:

- `encryptInputsAsync` requires the consuming contract, so it can never be
  omitted.
- `src/lib/abis.test.ts` asserts that every `external*` handle run in every ABI
  is immediately followed by a `bytes` proof, and that no ABI still references a
  deleted `InEuintXX` struct. That test immediately caught an `InEuint8` in
  `EncryptedFlags` that a hand scan for `InEuint64` had missed.

---

## Verification

### Offline

```
contracts   hardhat compile                    OK
contracts   check-storage-layout --check       OK — 25/25 match snapshots
contracts   hardhat test                       600 passing / 0 failing
app         tsc --noEmit                       0 errors
app         vitest run                         5981 passing / 0 failing (266 files)
app         vite build                         OK
tooling     write-arg validator                161 call sites vs compiled ABIs, 0 mismatches
```

The contract test total is unchanged at 600, so no test was deleted or skipped
to reach green.

### On chain

Storage layout is unchanged, so every proxy was **upgraded in place**. All
proxy addresses and all state survive; the registered dApp contract addresses
did not move. 19 proxies per chain, callees (`FHERC20Vault_USDC`,
`FHERC20Vault_USDT`, `PaymentReceipts`) upgraded before the hubs that hand
values to them. A probe view was read before and after each upgrade and had to
match, or the task aborts.

| Chain | Proxies upgraded | Live encrypted-input proof | Gas |
| --- | --- | --- | --- |
| Arbitrum Sepolia | 19/19 | [`0x2460b454…`](https://sepolia.arbiscan.io/tx/0x2460b4549a5d6e0b6c3783df5d85f9886d033a43816d1b04bd1a0647d3dc6c4f) | 423,166 |
| Ethereum Sepolia | 19/19 | [`0x1d645382…`](https://sepolia.etherscan.io/tx/0x1d645382161597617664b315585e661e57b4e86728f2a632472f60f91d27746b) | 470,611 |
| Base Sepolia | 19/19 | [`0x7f4ed4f2…`](https://sepolia.basescan.org/tx/0x7f4ed4f23c9de610e8d52effcdb71df395af6bdeeeacc2574d73fa07a1be350d) | 470,765 |

Each proof is `hardhat verify-cofhe-0-7`, which shields, encrypts client-side
with the consuming contract bound, and spends the result through
`requestUnshield(externalEuint64, bytes)`. It exits non-zero on any revert.
That is the exact path that returned `ZK_VERIFY_FAILED` before the migration.

Re-runnable per chain:

```bash
npx hardhat verify-cofhe-0-7 --network arb-sepolia
```

---

### Multi-wallet feature sweep

Four personas (Alice, Bob, Carol, Dave), each signing as itself, driving every
hub with real transactions. Every hash was re-fetched from the chain
afterwards rather than trusting the harness output.

| Chain | Result | Hashes re-checked on chain |
| --- | --- | --- |
| Arbitrum Sepolia | **42 pass · 0 fail · 4 skip** | 35 success, 0 reverted, 0 missing |
| Base Sepolia | **42 pass · 0 fail · 4 skip** | 35 success, 0 reverted, 0 missing |
| Ethereum Sepolia | incomplete — out of gas, see below | n/a |

The 4 skips are the faucet step; the personas were already funded.

Covered: shield x4, pay x2, group create + settle, gift send + claim, escrow
create / mark-delivered / approve-release, claim links (bearer, address-bound,
email-bound, all three claimed), inheritance setHeir, storefront list + buy,
crowdfund create + contribute, P2P offer, payroll, unshield, creator profile +
tip, stealth send + claim. Plus 12 negative cases, each rejected by the
contract's own revert reason rather than a client-side error: self-pay, wrong
secret, wrong bound address, unauthorised release, non-member expense, gift
replay, wrong recipient, self-tip, zero shield, same-token swap, empty payroll
batch.

Two harness bugs were found and fixed by running it, not by reading it:

1. **A false pass.** `neg_non_member_expense` was reported as passing while
   actually throwing `ABI encoding params/values length mismatch` — a bug in
   the harness itself. The sweep counts any throw as the expected revert, so a
   broken security test looked like a working one. Cause: two separate ABI
   conversions each inserted a `proof` parameter into `addExpense`, giving it
   two. After the fix it reverts with `GroupManager: not a member`.
2. **A gas floor tuned for L2s.** Persona top-up was hardcoded at 0.002 ETH.
   Every FHE call is submitted with a 5-10M gas limit that a wallet must cover
   up front even though it spends far less, which on Ethereum Sepolia at ~1
   gwei is 0.005-0.010 ETH per submission. The top-up now derives from live
   gas price and the largest limit in the sweep, so it sizes itself per chain.

## What is NOT verified
- No browser flow has been driven since the migration. The frontend builds, its
  unit tests pass, and its encrypted arguments were validated against the
  compiled ABIs, but a real user journey through the UI is a separate proof.
- Decryption and encrypted-balance reads after users re-sign an ACP. Stored
  permits are dropped by 0.7 (they were signed under retired EIP-712 types), so
  every user signs once more on first use.
- **The Ethereum Sepolia feature sweep never completed.** The contracts there
  are upgraded and the encrypted-input path is proven on chain, but the
  46-check sweep has not run to completion. The first attempt failed on the
  hardcoded gas floor; the second reached feature 14 of 16 and was stopped.
  Finishing it needs roughly 0.2 ETH on Sepolia for the deployer plus four
  personas. Arbitrum and Base carry the full feature proof today.
