# EncryptedEscrow: fully-encrypted escrow

Wave 4's #249 ship. The previous escrow (still in `BusinessHub.sol` for back-compat) stored a **plaintext amount** on chain so the indexer could display it. That contradicted Blank's privacy posture, since the amount is the entire point of encryption. `EncryptedEscrow.sol` ships a refactor with the amount encrypted from create through release/refund. No plaintext lookup, no leak via events.

## Roles

| Role | Capability |
|------|------------|
| **Depositor** | Creates the escrow, funds locked. Calls `disputeEscrow` if delivery doesn't happen. After expiry (no dispute, no release): `claimExpiredEscrow` refunds depositor. |
| **Beneficiary** | The intended recipient. Calls `markDelivered` to signal delivery; depositor's `approveRelease` triggers payout. |
| **Arbiter** (optional) | Resolves disputes. If `arbiter == address(0)`, dispute path is blocked (audit §1.2 fix; previously this lost funds permanently). Decides via `arbiterDecide(escrowId, payToBeneficiary)`. |

## On-chain flow

1. **Create:** `createEscrow(beneficiary, vault, encAmount, deadline, description, arbiter)`. Depositor signs an InEuint64 with the encrypted amount. The vault's `transferFromVerified` moves the encrypted amount into the escrow contract. Status: `Active`. Decrypt rights: depositor + this contract. **Arbiter does NOT get decrypt rights yet** (§A12 audit), granted only at dispute time.
2. **Delivery signaled:** Beneficiary calls `markDelivered(escrowId)`. Status stays `Active`; this is an off-chain handshake step.
3. **Happy path:** Depositor calls `approveRelease(escrowId)`. Contract transfers the encrypted amount to the beneficiary via `vault.transferVerified`. Status: `Released`.
4. **Dispute path:** Depositor calls `disputeEscrow(escrowId)`. Only allowed when `arbiter != 0x0` (§1.2 fix). Status: `Disputed`. Arbiter is granted `FHE.allow` on the encrypted amount. Arbiter calls `arbiterDecide(escrowId, payToBeneficiary)`. Funds route accordingly.
5. **Expired path:** After the deadline, anyone can call `claimExpiredEscrow(escrowId)` and the depositor gets the refund. Requires `status == Active` (no dispute open).

## §1.2 audit fix: no-arbiter dispute lock

Before §1.2, `disputeEscrow` would flip status to `Disputed` regardless of arbiter address. With `arbiter == 0x0`, neither `arbiterDecide` (requires `arbiter != 0x0`) nor `claimExpiredEscrow` (requires `status == Active`) could move funds. The escrow would be permanently locked.

The fix: `disputeEscrow` now reverts with `"no arbiter — use claimExpiredEscrow at deadline"` when `arbiter == 0x0`. The depositor's recourse is to wait for the deadline and reclaim via expiry.

## FHE primitives used

| Primitive | Purpose |
|-----------|---------|
| `FHE.asEuint64` | Verify the encrypted input under msg.sender at create / decide |
| `FHE.allow` / `FHE.allowSender` / `FHE.allowTransient` | Decrypt-rights management per role |
| Vault `transferFromVerified` / `transferVerified` | Move the encrypted amount in/out of the contract balance |

## Deployments

| Chain | Address |
|-------|---------|
| Eth Sepolia | `0x4253163CfCd0cf9885333E0a7B7476d61F010feC` |
| Base Sepolia | `0x6414742D2da28eCEf06D79b82F406B6b8ab3e421` |

## Frontend integration

- Hook: `packages/app/src/hooks/useEncryptedEscrow.ts` (`createEscrow`, `markDelivered`, `approveRelease`, `disputeEscrow`, `arbiterDecide`, `claimExpiredEscrow`); full coverage.
- UI integration: the BusinessTools screen currently uses the legacy `useBusinessHub` plaintext escrow for back-compat. The migration to `useEncryptedEscrow` as the default create path is deferred to a focused session. The hook is shipped + tested, but exposing it as the primary create flow in BusinessTools requires reconciling the supabase indexing schema with the encrypted-amount path. Tracked as audit `B1`.

## Tests

- Contract: `packages/contracts/test/EncryptedEscrow.test.ts`: 9 tests covering happy path, dispute → arbiter, expiry refund, edge cases (double-mark-delivered, no-arbiter-dispute-reverts).
