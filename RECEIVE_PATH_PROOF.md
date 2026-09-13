# The receiving half: proof record

Run 2026-09-05. Branch `cofhe-0.7-migration`. Base Sepolia (84532).

Everything proven before this was the **sending** half through a browser, plus
the receiving half at contract level in the hardhat sweep. Nobody had driven a
second person through the UI to actually collect the money. Doing that found
three defects that 6,026 unit tests, a clean typecheck and 84 on-chain checks
all missed, because none of them ever pressed the button as the recipient.

The test is two isolated browser contexts (separate storage, therefore separate
passkey wallets), Supabase deliberately not running, and the chain as the only
judge.

---

## What broke

### 1. Claim was a silent no-op for every new recipient

`useGiftMoney.claimGift` opened with:

```ts
if (!address || !connected) return;
```

`connected` comes from `useCofheConnection`. For a passkey-only user it is true
only once `SmartAccountCofheBinder` has bound the CoFHE client, and the binder
refuses to bind an account with no on-chain code, because ERC-1271 needs code to
verify a signature. A brand new recipient's smart account is counterfactual
until their first UserOp. So `connected` was false, and pressing **Claim**
returned immediately: no spinner, no toast, no transaction, no log line.

Measured: envelope `#49` on Base Sepolia, Bob's Claim button enabled and
clicked, `opened(49, bob)` still `false` after 240 seconds.

`claimGift(uint256)` carries no encrypted argument. It never needed the CoFHE
client at all, and the claim is itself the UserOp that deploys the account.

The same gate sat on nine call sites across four hooks. Four of them take no
encrypted argument and the gate was simply wrong:

| Hook | Call | Encrypted argument | Now |
| --- | --- | --- | --- |
| `useGiftMoney` | `claimGift` | no | gate removed |
| `useGiftMoney` | `deactivateEnvelope` | no | gate removed |
| `useGiftMoney` | `setExpiry` | no | gate removed |
| `useGroupSplit` | `createGroup` | no | gate removed |
| `useGiftMoney` | `createGift` | yes | refuses, and says why |
| `useGroupSplit` | `settleDebt` | yes | refuses, and says why |
| `useRequestPayment` | `createRequest` | yes | refuses, and says why |
| `useRequestPayment` | `fulfillRequest` | yes | refuses, and says why |
| `useTipCreator` | `tip` | yes | refuses, and says why |

The five that genuinely cannot proceed now show `ENCRYPTION_NOT_READY` instead
of doing nothing.

### 2. Receiving money depended on the indexer

The received-gift list was built from `useActivityFeed`, which is Supabase. With
the indexer behind or unreachable a recipient saw "No gifts received yet" over a
funded, claimable envelope. The per-row manual claim input only renders inside a
row, so an empty feed meant an empty screen with no way in either.

`GiftMoney.getReceivedEnvelopes(address)` has been on the contract the whole
time and was never called by the app. Nor were:

| Contract | View that was never called |
| --- | --- |
| `GiftMoney` | `getReceivedEnvelopes`, `getSentEnvelopes` |
| `BusinessHub` | `getClientInvoices`, `getVendorInvoices`, `getUserEscrows` |
| `GroupManager` | `getUserGroups` |
| `PaymentHub` | `getIncomingRequests` |

Every one of them backs an action a second party has to take: claim a gift, pay
an invoice, mark an escrow delivered, settle a group share, fulfil a request.
Four new hooks read them and merge the results into the existing lists, so the
indexer is now an enrichment layer rather than a dependency. Supabase rows still
win where both sources have the record, since they carry fields the chain does
not (client email, PDF CID, reminder state, group admin).

Checked and **not** affected:

- `/claim/:chainId/:linkId` already reads `ClaimLinks.getLink` from the chain.
- The stealth *claim-code* inbox (the one actually reachable from `/app/stealth`) already reads via a share link, not the indexer. See §5 below for what that one needed.
- Inheritance already lets an heir type the owner's address; the claim card
  reads `getPlan(owner)` directly. The "Plans naming you" list is a
  convenience, not the only route.

### 3. The gas sponsor blocked three whole features

Publishing a stealth meta-address failed on every chain. The screen said "The
transaction was rejected on-chain with no reason returned. Try again in a
moment." It would never have succeeded on a retry.

`BlankPaymaster._validatePaymasterUserOp` requires `approvedTargets[target]`.
A missing target reverts inside validation, so `handleOps` reverts, the relayer
returns 502, and the reason string is thrown away on the way out. Auditing the
allowlist against every contract the UI actually calls found **12 unapproved
targets across the three chains**:

| Target | Chains missing | What it broke |
| --- | --- | --- |
| `ERC6538Registry` | all three | nobody could publish a stealth meta-address, so nobody could receive a stealth payment |
| `ERC5564Announcer` | all three | the announcement side of the same feature |
| `ProofOfBalance` | all three | proof of balance, for every passkey user |
| `ClaimLinks` | Arbitrum | send by link |
| `Storefront` | Arbitrum | storefront purchases |
| `EncryptedCrowdfund` | Arbitrum | crowdfund contributions |

`wire-paymaster-targets` already existed as an ops task; its list simply never
grew to include these, and it had not been run on Arbitrum since those three
deployed. The list now includes them and the task ran on all three chains:
approved counts went 16 to 19 (Ethereum), 18 to 21 (Base), 15 to 21 (Arbitrum),
and a re-audit reports **0 unapproved targets**.

Two things made this cost far more than it should have, both now fixed:

- **The relayer discarded the reason.** `handleOps` reverts carry
  `FailedOp(uint256,string)` or `FailedOpWithRevert(...)`, which is where
  "AA33 reverted" and the paymaster's own require string live. `/api/relay`
  reported only ethers' "transaction execution reverted ... reason=null". It
  now decodes both and returns the reason with `permanent: true`.
- **The copy told users to retry.** A validation rejection is permanent.
  Unapproved-target, not-whitelisted and AA33 now each say what happened and
  that a retry will not help.

### 4. A dead indexer starved the payment itself

With the Supabase host down, five minutes of one gift flow logged **446 and 417
console errors** across the two tabs, ending in `ERR_NO_BUFFER_SPACE` and
`ERR_NETWORK_CHANGED`. Roughly a dozen callers poll that client on independent
30 second timers and every one kept dialling a refused socket. That is not only
noise: exhausting the browser's socket pool competes with the RPC and relayer
calls the payment depends on.

The client now carries a breaker. Three consecutive **network** failures (an
HTTP error never counts) stop dialling for a minute, and realtime backs off to
30 seconds instead of retrying at 10 forever.

Re-measured on the same flow with the same host still down:

| | before | after (two runs) |
| --- | --- | --- |
| sender tab | 446 errors | 82, 101 |
| recipient tab | 417 errors | 80, 103 |
| `ERR_NO_BUFFER_SPACE` | yes | none |

The second pair is higher because that run was longer: it switched viewports
to capture the list on desktop and mobile.

What is left is honest: the host really is unreachable, and the app already
shows "Live updates paused" while it is. The count does not fall to three per
minute because several pollers fire at once and all clear the breaker check
before the first of them fails. Tightening that further would need an in-flight
guard; the socket exhaustion that could starve a payment is gone either way.

---

## Verification

### On chain, driven as two people

```
[bob]   smart account 0x3FEe72CF8c290ad3240bCC50E59010B71d78E64f
[alice] smart account 0x26024A0d05DF4936568F28A7023FA5fD0C9cF278
[chain] envelope #49 sender=0x26024A0d05DF4936568F28A7023FA5fD0C9cF278 active=true
[bob]   envelope visible in Received tab without the indexer: true
[chain] opened(#49, bob)   false -> false      FAIL   (before the fix)
[chain] opened(#50, bob)   false -> true       PASS   (after the fix)
[chain] opened(#51, bob)   false -> true       PASS   (re-run with the breaker)
[chain] opened(#52, bob)   false -> true       PASS   (visual capture run)
```

Bob had never transacted. The claim deployed his account and collected the
gift, with no indexer running at any point.

All four second-party actions, each driven the same way. Every "saw it" is
with Supabase down, so the second person found the thing by reading a contract:

| Flow | What the chain said |
| --- | --- |
| gift claim | `opened(#52, bob)` false to true |
| invoice pay | `#42` status `pending` to `payment_pending` |
| group settle | `#47` name "Flatmates", `bobIsMember=true`, settle submitted |
| request pay | `#36` status `pending` to `fulfilled` |
| claim link | `#50` bearer, `claimed` false to true, `claimer` is Bob |

The claim link is the one a stranger receives: a public URL, opened by a wallet
that had never transacted, with no account of any kind on the sender's side.

`payment_pending` is the state `payInvoice` leaves an invoice in: the client's
funds are held and the vendor finalises. That is the whole of the client's half.

Re-runnable against a local dev server:

```bash
node packages/app/.receive.mjs        # gift: send and claim
node packages/app/.invoice-pay.mjs    # invoice: bill and pay
node packages/app/.group-request.mjs  # group settle + request pay
node packages/app/.claim-link.mjs     # bearer link: create and claim
```

One driver bug, found by running it: the request note field is a `textarea`,
and the script looked for an `input`. Fixed in the script, not the product.

### On screen

The recipient's Received tab, captured mid-run on both viewports with the
indexer still down (`packages/app/.ui-shots/rx-bob-gifts-list-desktop.png`
and `-mobile.png`):

```
Received Gifts                                    1 Gift
From 0xbb0d...5e11
Thank You: Coffee on me #52 · 05/09/2026    ••••••  received  [ Claim ]
```

Reading those shots turned up one thing the tests did not: the badge said
"1 Gifts". Fixed, with a pin. At 375px the row stacks, the Claim button stays
reachable, and nothing collides with the bottom nav.

The client's invoice list (`inv-bob-client-list.png`) turned up two more, both
invisible until clients could see invoices at all:

- Every row printed the **client** address, so a client read their own address
  where the biller's name belongs. Rows now say "From <vendor>" or
  "To <client>" depending on which side you are.
- A chain-sourced invoice has no creation date, and the row printed
  "No date · Due in 30 days". The unknown half is now omitted.

And the group card (`gr-bob-group-list.png`) turned up a third: its avatar
stack held exactly one chip, built from two hex characters of the viewer's own
address, so a group of four rendered as a lone red circle reading "57". The
member list is right there in `getGroup`, so the card now shows a chip per
member and a count.

### Every chain the app ships on

The new hooks are chain-agnostic, so the thing that separates "proven on Base"
from "works everywhere" is whether the views answer. All 18 calls (six views
across three chains) responded, at the addresses `src/lib/constants.ts` gives:

```
Eth Sepolia    getReceivedEnvelopes getClientInvoices getVendorInvoices
Base Sepolia   getUserEscrows getUserGroups getIncomingRequests
Arb Sepolia    6/6 ok on each, failures: 0
```

Re-runnable: `node packages/app/.views-probe.mjs`.

### Offline

```
app   tsc --noEmit                     0 errors
app   vitest run                       270 files, 6050 passing
app   check-imports                    boundary check passed
app   check-voice                      clean, 142 files
```

New tests, all pinning behaviour that was broken in a real journey rather than
restating the implementation:

| File | Tests | Pins |
| --- | --- | --- |
| `useReceivedEnvelopes.test.ts` | 11 | note prefix, AA+EOA union, dead RPC warns |
| `useOnChainBusinessRecords.test.ts` | 13 | both status enums positionally, due-date 0, no epoch dates |
| `useOnChainGroups.test.ts` | 8 | archived dropped, never claims admin |
| `useOnChainRequests.test.ts` | 6 | only pending is actionable, payer/requester not swapped |
| `supabase.test.ts` | +4 | breaker trips on network only, resets on success, realtime backoff |
| `Gifts.test.tsx` | +4 | empty feed plus chain row still renders Claim |
| `BusinessTools.test.tsx` | +4 | failed fetch no longer hides a payable invoice |
| `Groups.test.tsx`, `Requests.test.tsx` | +4 | chain row appears, indexer row wins |
| `useGiftMoney` and three siblings | rewritten | plaintext calls proceed unconnected; encrypted ones say why |

Four existing tests asserted the old silent-return behaviour. They were
rewritten rather than deleted, and each now states what the user sees.

---

### 5. Stealth claim had the same gate bug as gift claim, plus a silent catch

Blank ships two unrelated privacy features under the "Stealth" name:
`StealthPayments.sol` (claim-code based, plain recipient address, the
`/app/stealth` screen a user actually reaches) and a separate ERC-5564/6538
meta-address + announcement scanner at `/app/stealth/setup` and
`/app/stealth/inbox`. My first pass tested the wrong one, watching for
`Announcement` events a claim-code send never emits.

Once corrected, the real flow hit the identical bug class fixed earlier for
gift claim: `claimStealth(transferId, claimCode)` gated on `!connected`.
`claimCode` is a plain bytes32 secret verified by hash comparison, never
FHE-encrypted, so the call never needed the CoFHE client. Every first-time
recipient's smart account is undeployed and never binds it, so Claim was a
silent no-op there too.

A second bug compounded it: `handleClaimFromInbox`'s catch block swallowed
any error with zero toast, so a plain RPC 429 (16 of them, measured) made the
row quietly revert to "new" with nothing distinguishing it from the click not
registering at all.

Both fixed: the gate removed from `claimStealth`, and the catch now shows
`err.message`. Re-run PASS: transfer `#35`, inbox status `new` -> `claimed`.

## What is NOT verified

- Only Base Sepolia was driven through the browser for the receive path.
  Every view the new hooks call answers on all three chains (above), and the
  frontend is the same build, but no second-person browser journey has been run
  on Arbitrum or Ethereum Sepolia.
- The group settle was confirmed by the modal closing after the transaction
  went out, not by a status field: `settleDebt` moves encrypted balances and
  leaves no plaintext flag to read. The other three were judged on a chain
  value that changed.
- The Ethereum Sepolia feature sweep is still incomplete for the reason
  recorded in `COFHE_0_7_MIGRATION_PROOF.md`: it needs roughly 0.2 ETH and the
  deployer holds 0.025.
- The ERC-5564/6538 stealth-address feature (Settings -> Stealth Meta-Address,
  `/app/stealth/setup` + `/app/stealth/inbox`) is real and reachable, not
  orphaned: `SendConfirm.tsx` auto-routes a normal send through it whenever
  the recipient has a published meta-address. Publishing was confirmed
  working after the paymaster fix (§3). The send-auto-route -> announce ->
  scan -> sweep loop was not driven end-to-end as two people; only the
  claim-code stealth feature (§5) was.
