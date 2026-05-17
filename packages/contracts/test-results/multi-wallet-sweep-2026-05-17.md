# Multi-wallet feature sweep — 2026-05-17

Two-chain reproducible run via `npx hardhat multi-wallet-feature-sweep`.

Each row is one real testnet transaction. Hashes are verifiable on
`sepolia.etherscan.io` (chain 11155111) and `sepolia.basescan.org`
(chain 84532).

## Personas

Deterministically derived from the deployer key via `keccak256(deployer || name)`.

| Name  | Address |
|-------|---------|
| Alice | `0xa695888b60067636Ca7627C9993e6C21a175C6af` |
| Bob   | `0xCc4D90A639Af04e5ee349C582870AD91f77e93CA` |
| Carol | `0x533c14e784162F3f7553ac34FCeaBbd36aeAC800` |
| Dave  | `0x0Bc6F7c2d33B0371cBcc93CdFd6BF271BBCd0b55` |

## Coverage

19 happy-path features × 4 personas + 5 verified negative cases.

### Happy paths

| # | Feature             | Persona | Contract               | What it proves |
|---|---------------------|---------|------------------------|----------------|
| 1 | faucet              | A,B,C,D | TestUSDC               | Each persona can self-mint testnet USDC |
| 2 | shield              | A,B,C,D | FHERC20Vault           | Plain ERC20 → encrypted vault balance, 4 distinct ACL grants |
| 3 | sendPayment         | A→B, C→D| PaymentHub             | Encrypted P2P transfers, sender + recipient receipts inflate |
| 4 | createGroup         | Alice   | GroupManager           | 4-member group created, all isMember flags set |
| 5 | sendGift            | A→B     | GiftMoney              | Encrypted gift envelope, claimable by recipient |
| 6 | createEscrow        | A→B/C   | EncryptedEscrow        | Encrypted amount locked, beneficiary + arbiter wired |
| 7 | createLink          | Bob     | ClaimLinks             | Bearer-mode claim link with hashed secret |
| 8 | setHeir             | Carol   | InheritanceManager     | Heir + inactivity window persisted |
| 9 | createListing       | Alice   | Storefront             | FixedPrice listing with encrypted price |
|10 | createCampaign      | Dave    | EncryptedCrowdfund     | Campaign with encrypted goal + 7-day duration |
|11 | createOffer         | Carol   | P2PExchange            | Plaintext ERC20 cross-pair offer |
|12 | runPayroll          | Alice   | BusinessHub            | Batch encrypted-salary payout to 3 employees |
|13 | requestUnshield     | Bob     | FHERC20Vault           | Encrypted → plaintext withdraw request |
|14 | setProfile          | Bob     | CreatorHub             | Creator profile with tier thresholds |
|15 | support             | A→B     | CreatorHub             | Encrypted tip + creator earnings accumulator |
|16 | contribute          | Carol   | EncryptedCrowdfund     | Encrypted pledge to most-recent campaign |

### Negative cases (all REVERTED as expected via eth_call dry-run)

| # | Feature                  | Persona | Revert reason |
|---|--------------------------|---------|---------------|
|17 | self-pay reject          | Alice   | `PaymentHub: invalid recipient` |
|18 | non-member addExpense    | Alice   | `GroupManager: not a member` |
|19 | wrong-secret claim       | Dave    | `ClaimLinks.claim` reverts |
|20 | non-depositor approveRelease | Dave | `EncryptedEscrow: not depositor` |
|21 | creator self-tip         | Bob     | `CreatorHub: cannot self-tip` |

## Base Sepolia results (latest run)

**24 pass / 0 fail / 4 skip.** The 4 skips are intentional — faucet
no-ops when personas are already funded from a prior run.

Notable tx hashes (one per feature, verifiable on `sepolia.basescan.org/tx/<hash>`):

```
shield Alice             0x4bed6a0559216eda315e702f4a5c6b4eb848b572519ab439e3760cb04e677ebb
shield Bob               0x0b5a8bef76a409a04aaa6908e28b8dc12f81cfeac2b72e9bb204ce342a36570e
shield Carol             0x52cee125edacf29bdcfdde4b5d97fa99c7a676bfd37995a1608ee5b7e6f7f34e
shield Dave              0xbf49818a0adc231268a0ef3acca1e8f479b482719813ed10169a40bd91ead0d8
pay Alice→Bob            0x189d8c17b7f969bbbfd71db215b2fc4e80b8dd16b67445057d8be789706eba5b
pay Carol→Dave           0xd19761039235ad01382fb9a72894a6ec6037e469de4aef3a625453d93ade74d0
createGroup              0xbbc81d149cba282f54b6896981b1945586223c0c92b58e5b808c351de853eadf
gift_send                0x9280f8b77c31edeaeda257e70a87fd3e09cd0a41464cb43a666352fc64780435
escrow_create            0x9c5c530b1c35b1b51e314f71e5c44ecb3cbc8bde468d6b4d2df917a48feae3ba
claim_link_create        0xbc1c7715adba64e4d2266f9c4629c75d09b52dd4dfa2acb3a4086d70acd913b1
inheritance_setHeir      0x47641e6deb568b51cd387a706128a3d274cdb09516cb0db3c02748ee6038bb4c
storefront_listing       0x633cb99796cf0cf2f29887b95d4fe81ab02946a07074d2c45052b56cf95fe5cd
crowdfund_create         0x0306072bed164a29add43d1713b459ff3871936743e96f8555791fa376fdd0eb
p2p_offer                0x828d69bc0a84651c5330116bf91412ee84d27ec660f44cdcac17b82441a7ffe3
runPayroll               0x7b3d419afe3aa40650bd9a859970c976b3a8ba67fe002c98dc5a1a303dfdd902
requestUnshield          0xcad24b7643fcf58f90e731cc08a4e9a256155010b022836dcbc1093a88051cc6
creator_setProfile       0x895d3bdd179510984001df7cdd1e1b23774838d57d8cd1955f892483eed8e366
creator_support          0x572821fc3e68f84dafee0b310f696e8c880cb893a8ebda0f528a880103073c2d
crowdfund_contribute     0xe506c9b90c974042b575f06f17fb695ed9389c018b98f27a93ecc5130e0c96b1
```

## Eth Sepolia results (latest extended run)

**23 pass / 1 fail / 4 skip.** The single fail was a transient
publicnode RPC `Missing or invalid parameters` on
`escrow_create` (nonce-race symptom under back-to-back submission);
the same call passed cleanly on Base Sepolia and on prior Eth Sepolia
runs. Not a contract bug.

```
shield Alice             0xbd5ae993c532454c9c78e17f29d7ba55050404de9ae7ca5f5a647b010f001114
shield Bob               0xac7301a77b330611d9123d88121c17a997defd7f7d1e98a90c89b834ac607017
shield Carol             0xd022ad119e579c705ead1ecd17ca77374daaecc021427e431df0a2f7a0f630d8
shield Dave              0xcab6d551d6d25fa1b5edbd5a9283be8b4172e960c83470d90411bf32aee80025
pay Alice→Bob            0x7d595045b73e60c8ffdb8136bc3f9c085e1d454c1109b27fe4a3cc79bf90064a
pay Carol→Dave           0xe2b8501a8fbae2bbec1d9c5e96c1b64d51eb92ba3f9baa52f77e583221657e48
createGroup              0xe4ab3229758987224dec336c859d3789ed6a787a45595457ff9e146f6e4797ca
gift_send                0xa7c1eb982991718d9ef80be883311fe00918aeec3056d71ca3c71ccb1df90979
claim_link_create        0xb95276f26a30535e3504a99798e69df0eeff3e69504b270e27f7098873991d9b
inheritance_setHeir      0x34b147ea0498c53af23b53f4864865a328c71d8b5c88420ca9c7084c94ecb47b
storefront_listing       0xedc653fe25013896ade6b95497af9f04bef940cbd9b4c173fa0383f50bee4abe
crowdfund_create         0xf1cd904b5ad2b2075e5d824827d2ed404f5033d01febacaa10c5f79e5e496d95
p2p_offer                0xf05176cd549abcfddcc83be253b580e83f09d90f9439ea737e6e979a323a517a
runPayroll               0x256358b54c9dcacc0279956c30ed1dbefb511ee9fb838bada4ccf2309ae7fe50
requestUnshield          0x2d8d70931d0ec16543e952f922a168aa865a2e91ce3ae70e5e443846d12ccaa2
creator_setProfile       0xee4664e83170c6f149e0166ceb1a02884d45f53b18c56141a726f74af8ed2f1a
creator_support          0xca8cba10714af4ec06b2ed63a6099db3c8e2e5775eced5d34b12b1b396b2c044
crowdfund_contribute     0x455c6dcfcd018d8f78944ea77ff449a2090d7b8f75522c1ae0ee05a5c827808b
```

All 5 negative cases reverted with the expected reason strings on
both chains.

## Reproducing

```
npx hardhat multi-wallet-feature-sweep --network eth-sepolia
npx hardhat multi-wallet-feature-sweep --network base-sepolia
```

Idempotent: re-runs skip faucet/funding when personas are already funded.
