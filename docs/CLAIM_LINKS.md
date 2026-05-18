# Magic Claim Links

Send an amount via a link. The recipient lands on a public page (`/claim/:chainId/:linkId#mode:secret`), clicks Claim, and receives the funds into their smart account or EOA. No prior relationship with the sender, no on-chain match required at send time.

## Modes

| Mode | Gate | When to use |
|------|------|-------------|
| **Bearer** | Anyone with the link | Sharing in a public-ish channel (DM, email, Slack). The link IS the bearer instrument. |
| **EmailBound** | Email matches the digest | Sending to someone whose email you know but whose wallet you don't. The chain-side check is `FHE.eq` on the email digest; the email itself never reaches the chain. |
| **AddressBound** | `msg.sender == boundAddress` | Sending to a known wallet. Public-key-tied; useful for revoking the link if the recipient's email changes. |

## Domain separation

The hash construction `keccak256(abi.encodePacked(DOMAIN, uint8(mode), secret, [emailHash]))` uses `DOMAIN = keccak256("BLANK_CLAIM_v1")`. Different modes never collide because the encoded `uint8(mode)` byte changes.

## Privacy posture

The amount is encrypted from create through claim. The sender does **not** retain decrypt rights on the locked amount handle (`§2.1` of the project). Rationale: CoFHE has no revoke primitive, so granting at create would let the sender publish a decrypt proof of the claim amount forever after the recipient claims. The sender already knows the plaintext at create (they encrypted it), so dropping the on-chain allowance costs them nothing they can't reconstruct from local state.

## Refunds + expiry

- `MAX_EXPIRY_SECONDS = 365 days` cap (audit §1.5 fix; prior unbounded expiry enabled fund-then-grief).
- `expirySeconds == 0` → default 30 days.
- After expiry, the sender calls `refundLink(linkId)` to pull funds back.

## On-chain interface

```solidity
function createLink(
  address vault,
  InEuint64 encAmount,
  uint8 mode,
  bytes32 secretHash,
  address boundAddress,    // for AddressBound; zero otherwise
  uint256 expirySeconds,
  string note
) external returns (uint256 linkId);

function claimBearer(uint256 linkId, bytes32 secret) external;
function claimEmailBound(uint256 linkId, bytes32 secret, bytes32 emailHash) external;
function claimAddressBound(uint256 linkId, bytes32 secret) external;
function refundLink(uint256 linkId) external;
```

## Deployments

| Chain | Address |
|-------|---------|
| Eth Sepolia (11155111) | `0x9E2189149deec5e78cB2976d8DF64CAec40B12Be` |
| Base Sepolia (84532) | `0x2eD78815299C2B1F2cBd2313CF763B56A0654665` |

## Frontend integration

- Hook: `packages/app/src/hooks/useClaimLinks.ts` (`createLink`, `claim`, `refund`)
- Create screen: `packages/app/src/blank-ui/screens/CreateClaimLink.tsx`
- Public claim page: `packages/app/src/blank-ui/screens/ClaimLinkPage.tsx`
- URL utility: `packages/app/src/lib/claim-links.ts`: domain hash, secret-32-bytes round-trip, URL build/parse.

## Tests

- Contract: `packages/contracts/test/ClaimLinks.test.ts`: 13 tests covering create + 3-mode claim + refund + double-claim/double-refund + expiry cap.
- Lib: `packages/app/src/lib/claim-links.test.ts`: 38 tests pinning DOMAIN derivation, MODE enum alignment, secret-bytes32 round-trip, cryptographic invariants (3-way distinct hashes, deterministic per-secret), buildClaimUrl validation, parseClaimUrl defensive null handling.
- Screens: `ClaimLinkPage.test.tsx` (35 tests), `CreateClaimLink.test.tsx` (37 tests).
