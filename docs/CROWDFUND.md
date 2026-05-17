# Encrypted Crowdfund

Run a fundraising campaign with an encrypted goal and encrypted contributions. After the deadline, the chain computes `raised >= goal` via FHE and publishes only the boolean verdict. On success the creator pulls the pool; on failure each contributor calls `claimRefund(campaignId, contributionIndex)` to pull their own contribution back.

## What stays private

- The fundraising **goal** — encrypted from create through close.
- Each **individual contribution** — encrypted handle stored on the contract.
- The **running raised total** — encrypted via `FHE.add` accumulator.

## What's public

- Campaign **existence** + the **title** + the **deadline**.
- The **count** of contributions.
- The **verdict** — after `closeCampaign` + `publishCloseResult`, the `goalMet` boolean is public.
- The **creator's identity** + the **vault address**.

## On-chain flow

1. `createCampaign(vault, encGoal, durationSeconds, title, descriptionCidHash)` — encGoal encrypted by the creator.
2. `contribute(campaignId, encAmount)` — repeated per contributor. Amount encrypted by the contributor and verified under their address; transferred from their vault balance into the contract's vault balance. Running total `c.encRaised = FHE.add(c.encRaised, locked)`.
3. After deadline: `closeCampaign(campaignId)` — any address can call. Computes `reached = FHE.and(FHE.gte(raised, goal), FHE.gt(goal, 0))` and stores the encrypted `goalCheck`. Routes status to `Closed`.
4. `publishCloseResult(campaignId, plaintext, signature)` — anyone can call once the off-chain Threshold-Network signature is available. Verifies the signature against the encrypted handle, stores the public `goalMet` boolean, status routes to `Released` (success) or `Refunding` (failure).
5. **Success path:** `claimRelease(campaignId)` by the creator pulls the entire encrypted raised total into the creator's vault balance.
6. **Failure path:** each contributor calls `claimRefund(campaignId, contributionIndex)` to pull their own contribution back.

## FHE primitives used

| Primitive | Purpose |
|-----------|---------|
| `FHE.add` | Running raised total (`c.encRaised = FHE.add(c.encRaised, locked)`) |
| `FHE.gte` | Verdict: raised >= goal |
| `FHE.gt` | §1.14 A4: goal must be > 0 (prevents zero-goal grief) |
| `FHE.and` | Compose the two booleans (raised-meets-goal AND goal-is-positive) |
| `FHE.allowTransient` | Move ciphertext between contract and vault during contribute/release |

## §1.14 A4 zero-goal grief prevention

Before §1.14, a malicious creator could set `encGoal = 0`. Then `FHE.gte(raised, 0)` is always true, so any contribution would trigger `goalMet` and `claimRelease` would pull victim funds. The §1.14 fix AND-s `FHE.gt(encGoal, 0)` into the verdict. With encGoal = 0 the goalCheck is forced to false; status routes to `Refunding` and contributors can pull their funds back. Both operands are encrypted — neither leaks the actual goal amount.

Plus the existing §2.2 zero-contributions guard at `closeCampaign` rejects closing a campaign with no contributors at all.

## Deployments

| Chain | Address |
|-------|---------|
| Eth Sepolia | `0x383B58973f7e8DC3E47D1C2f55393E2ac48b24e1` |
| Base Sepolia | `0x0F21705575e2CC83dC410AE2af6973B150a4183C` |

## Frontend integration

- Hook: `packages/app/src/hooks/useCrowdfund.ts` (`createCampaign`, `contribute`, `closeCampaign`, `publishCloseResult`, `claimRelease`, `claimRefund`)
- Create screen: `packages/app/src/blank-ui/screens/CreateCampaign.tsx`
- Public campaign page: `packages/app/src/blank-ui/screens/CrowdfundPage.tsx` — 5-phase state machine: open / needsClose / needsPublish / released / refunding.

## Tests

- Contract: `packages/contracts/test/EncryptedCrowdfund.test.ts` — happy + failure path + §1.14 A4 zero-goal grief prevention + positive-goal regression sanity. Plus the §2.2 zero-contributions guard.
- Screens: `CrowdfundPage.test.tsx` (45 tests including the F1 transient/permanent error split).
