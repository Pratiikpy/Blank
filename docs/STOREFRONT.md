# Storefront: encrypted sealed-bid marketplace

One product per listing. Three sale modes. Sealed-bid auctions are the headline FHE feature: bids stay encrypted end-to-end, the winning bidder is computed on-chain via an FHE tournament, and the verdict publishes via a single signature from the Fhenix Threshold Network.

## Sale modes

| Mode | Buyer action | Privacy property |
|------|--------------|------------------|
| **FixedPrice** | Match the seller's encrypted price exactly. `FHE.eq(buyerOffer, encPrice)`. Mismatch lands zero via `FHE.select`, no revert leak. | Price itself is encrypted. Observers can't see what the listing costs without paying. |
| **Auction** | Sealed bid, escrowed. Highest wins at close. | All bids encrypted. No bidder learns another's bid. Only the winner's address is public; the winning amount is the encrypted handle the seller decrypts privately. |
| **PayWhatYouWant** | Buyer names the amount. Useful for donations / creator tips. | No price comparison, but the contribution amount stays encrypted from sender to seller. |

## Auction tournament

The §1.4 phase-B implementation walks the bid array with `FHE.gt` per bid + `FHE.select` to track the encrypted winner index:

```solidity
for (uint256 i = 0; i < bids.length; i++) {
    ebool isHigher = FHE.gt(bids[i].amount, currentMax);
    winnerIdx = FHE.select(isHigher, FHE.asEuint8(uint8(i)), winnerIdx);
    currentMax = FHE.select(isHigher, bids[i].amount, currentMax);
}
```

The result is an encrypted `winnerIdx`. A separate `revealWinner(listingId, plaintextIdx, signature)` call lands the Threshold-Network-signed plaintext. `claimAuctionWin` requires `winner != 0x0`.

## §1.14 hardening (Wave 4 §1.14 audit-refresh)

| Item | Fix |
|------|-----|
| **A7** Bid-spam DoS | `MAX_BIDS = 200` constant. Without the cap, an attacker could spam thousands of small bids and exceed block gas at `closeAuction`, locking the auction forever. |
| **A8** Below-min bid | `placeBid` gates the locked amount via `FHE.select(verifiedAmount >= l.encPrice, verifiedAmount, FHE.asEuint64(0))`. Bids below the seller-set minimum lock zero. We deliberately don't revert. That would leak "this bidder bid below $X" via the revert event. Silently zeroing preserves bid privacy. |

## Deployments

| Chain | Address |
|-------|---------|
| Eth Sepolia | `0x786C85880e0FCF123D726600D9784ee88B84695b` |
| Base Sepolia | `0xeA8a38f25ECF9Cc8C9240aafb35b561D14Dfd419` |

## Frontend integration

- Hook: `packages/app/src/hooks/useStorefront.ts` (`createListing`, `buyFixed`, `placeBid`, `payPWYW`, `closeAuction`, `revealWinner`, `claimAuctionWin`, `refundLoserBid`, `deactivateListing`)
- Create screen: `packages/app/src/blank-ui/screens/CreateListing.tsx`
- Public buyer page: `packages/app/src/blank-ui/screens/StorefrontPage.tsx` (includes the §1.14 C6 winner-only Claim gating)

## Tests

- Contract: `packages/contracts/test/Storefront.test.ts`: 18 tests including the §1.4 differentiating 5/10/7-bids test (proves winner is highest, not last), the §1.14 A7 MAX_BIDS pin, and the §1.14 A8 low-bid fairness test (Bob bids $5 below $10 min, Charlie bids $20 above, Charlie wins).
- Screens: `StorefrontPage.test.tsx` (51 tests), `CreateListing.test.tsx`.
