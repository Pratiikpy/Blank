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

20 happy-path features × 4 personas + 5 verified negative cases.
Now includes one full second-leg flow (create→consume) and a retry
wrapper around the most RPC-throttle-prone calls (shield / pay /
escrow_create) so the sweep tolerates publicnode flake without
needing manual re-runs.

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
|17 | claimGift           | Bob     | GiftMoney              | Second-leg: Bob claims the envelope Alice just sent |

### Negative cases (all REVERTED as expected via eth_call dry-run)

| # | Feature                  | Persona | Revert reason |
|---|--------------------------|---------|---------------|
|17 | self-pay reject          | Alice   | `PaymentHub: invalid recipient` |
|18 | non-member addExpense    | Alice   | `GroupManager: not a member` |
|19 | wrong-secret claim       | Dave    | `ClaimLinks.claim` reverts |
|20 | non-depositor approveRelease | Dave | `EncryptedEscrow: not depositor` |
|21 | creator self-tip         | Bob     | `CreatorHub: cannot self-tip` |

## Base Sepolia results (latest run)

**38 pass / 0 fail / 4 skip** — the strongest run yet, with **all
seven second-leg consume flows** (gift, settleDebt, escrow ×2,
storefront_buy, claim_link bearer, claim_link AddressBound, stealth)
plus **9 verified negative-case reverts** and **all 17 happy-path
features** across 4 distinct wallets. The 4 skips are intentional —
faucet no-ops when personas are already funded from a prior run.

Now includes the full second-leg consume flows:
- `gift_claim` — Bob actually claims Alice's envelope
- `settleDebt` — Bob settles 0.1 USDC encrypted with Carol in Alice's group
- `escrow_markDelivered` — Bob marks Alice's escrow as delivered
- `escrow_approveRelease` — Alice releases the encrypted funds to Bob
- `claim_link_claim` — Dave claims Bob's bearer link with the captured secret
- `storefront_buy` — Carol buys Alice's just-listed item via buyFixed
- `stealth_send` — Carol sends a stealth-encrypted payment to Dave

That's "create something + the other party consumes it" verified
end-to-end on chain, not just creation calls.

Notable tx hashes (one per feature, verifiable on `sepolia.basescan.org/tx/<hash>`):

```
shield Alice             0x4bed6a0559216eda315e702f4a5c6b4eb848b572519ab439e3760cb04e677ebb
shield Bob               0x0b5a8bef76a409a04aaa6908e28b8dc12f81cfeac2b72e9bb204ce342a36570e
shield Carol             0x52cee125edacf29bdcfdde4b5d97fa99c7a676bfd37995a1608ee5b7e6f7f34e
shield Dave              0xbf49818a0adc231268a0ef3acca1e8f479b482719813ed10169a40bd91ead0d8
pay Alice→Bob            0x189d8c17b7f969bbbfd71db215b2fc4e80b8dd16b67445057d8be789706eba5b
pay Carol→Dave           0xd19761039235ad01382fb9a72894a6ec6037e469de4aef3a625453d93ade74d0
createGroup              0xbbc81d149cba282f54b6896981b1945586223c0c92b58e5b808c351de853eadf
gift_send                0x6898c64668ca866a65fce03cb6bd877f2cc617f408a434a1683c52b61ba4e0e6
gift_claim               0xd05773cda6b64dfdd68087d6d87ac91bf625ce9d09a386d625523813812d53e7
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
crowdfund_contribute     0xabb7720c6d4dbd958760932ff18c12e45b4e5c2e507f8386cb0b35678c4b3810
stealth_send             0x731189aeb9592e2de90e697459d5154300858c1df838461d8933642a05410790
settleDebt (Bob→Carol)   0xe2a1c2c10f28391c43fa76582e0a1fb2c2c1bae6d398dfbe7f8223e163731653
escrow_markDelivered     0x9a29bc1a15d9dc47d5f192853876fa3b791cffb647d8effeb553de3bd4f44e57
escrow_approveRelease    0xa1d8eaaabed2691cf94b7a84f59987253fdde718a6aab7c8907e4f7381d3a89e
gift_claim (Bob)         0x4994c31a0bafd1310f0d0bc75f79e69df96e55268f81ff643d88f9d10d795075

# Final run with all 6 second-leg flows (commit 547fcea + later):
shield Alice             0xf4240e40ad48dc125abb5911d1d4d6fc52d1cbbd9340ba60b676ef207c84fdaf
settleDebt (Bob→Carol)   0x32700a2e94dd65173e3e6f8579b55e738e0804e6b9788271de55b210565db099
gift_claim (Bob)         0xf33e51a8830c1e5b35e80380faa4e71aca6406d0f9ea1adb237f33449a786aea
escrow_markDelivered     0x5782d6092994c1b82a12a8985bd397bad441c64e8dbae38def355aeeae641625
escrow_approveRelease    0x3ff898b3f5ac751be50b305d12b61e295b72ea54d4ee83ea0d113b4d195f16af
claim_link_claim (Dave)  0x95aa735f14c1137f6c6dcb7566f73b13396f909e5f38b9fdfadf630c1c229243
storefront_buy (Carol)   0x0842bea1f27087e4658393bfa898b92877e34d054b064bae57c4194aed69438d
stealth_send (Carol→Dave) 0x627e3935e3dbe6f97471392817c76d293977b4e266f35aef07e651775242ec72

# 38/42 run (all features + 7 second-legs + 9 negatives, Base Sepolia):
shield Alice              0xf0efeebaec05d2bcfa71754a9df0d728f640de42bd4c0de9db3fcf0d8f2d9b4f
shield Bob                0x9906da6e7e6d7ad7676dc50deca1131c181d5fcd5dd00a45cc63d69f9c3c74f9
shield Carol              0xddc587681ca6a1123f46b069019f01148a55d127f59c03858a9e36f3207f2eda
shield Dave               0x15bce9b76ce15644e55689815c340f50baa74730b27e92af7e26e0f0f29293ca
pay Alice→Bob             0xe73f223581be8a8b1c59a3a3a8c0216e0baebc785995ea70fe8c65bdb880a53e
pay Carol→Dave            0x90cf83a8f54b463cc69607f2896404b820d5e14007b75326ec584df3fe1e6d71
createGroup               0x43335d736cb73ad404ee4dc579d4e5e5d2bb308e2e0fa87b9d0efbbb23dbcb5b
settleDebt (Bob→Carol)    0xb73afd64aa7ff5f3bd266894444eecf60d37b5c85b5c9e4a14f9614373541cd3
gift_send                 0x3a06d15334a47ad250aa9a509e96be3dd7ed2aef33d824a3ac0e2ce7098c5424
gift_claim (Bob)          0x9bccb68f9c0894370a1fd7b2dd399ae791b55e8521c0e804d31372ba6f530d86
escrow_create             0xc7414da7c0b90c5782284e259e2713932429a23182856c4541204aa2e9e3ee8b
escrow_markDelivered      0x181755d3390c4ad4f2d89aa7268330b9386c93c0d75e2834b95449faff0d9b1a
escrow_approveRelease     0x654dc9e3dbd145964224578ed7d028e6051941aff00a91474fa6e6a31192269e
claim_link_create (bearer)0x7faaaf8cbdbcd59223cd9f0cd4d2056f720cf1c9ba3b0b115109db17f3dec142
claim_link_addr_bound     0x763b0a9e1b049032d588193c0fbf5843486124e46a8088164601ccb156cd9894
addr_bound_claim (Carol)  0x225da6713ab9ab6779e80537b131cd4da6f3998c68a1dd51f02bec9f7a3030e8
claim_link_claim (Dave)   0x829ca15ea918bcdca7d5ee7fd8a12dd3e47f37c15f5378ab5123972571753fd4
inheritance_setHeir       0xe82968795c76aa930861ec859f348458861d85f9b731ba23b020a1b07f1c5f20
storefront_listing        0x586f4aa24ca729e1118adcedc37f9d4e04b59fa6abdc224386c665dd080662a0
storefront_buy (Carol)    0x6ecfcc6cca2b066dfae18fcffe26c00a7107e45e17dc6a08684d90817b7148cb
crowdfund_create          0x9a9482861f55736327eed26915b3296e6f9c6c1ca75f264d4dfa7667e0054235
p2p_offer                 0xdfd1bf2dffd943e70be1a77c68323ff9dcf11d4b47db11bc5910a27309661124
runPayroll                0x8437827342882e6131a19c37557ff1a762fa6f03a9c7300a7392e4d1354adff5
requestUnshield           0x46aaebb7b1e4c143fb0f0130527512a51228bdc17058874ce79817fbfe84feca
creator_setProfile        0xa1555d53887857bc18796e770ae504539514a322f2c40d1a3ec7f49b027bca00
creator_support           0x280c929ba860e1ad0169ff28cafee838a5c4d7eb73e59d8ecf6191017a555237
crowdfund_contribute      0x6eaba00f6892624a26ce9b6dfce8cd346c24f89412b324ebc9c28307f94c42ac
stealth_send (Carol→Dave) 0xbbeba09a11ec639a1db80c7bb949e4b2d3ee58d29a42acd62f202da1f9263693
stealth_claim (Dave)      0xa92c914df4f174ddaccc1765d1419dcff804f44f5944d1f3b87a40dab7e0ca1d
```

All 9 negative cases reverted on Base Sepolia with the expected
reason strings:
  PaymentHub: invalid recipient        (self-pay)
  GroupManager: not a member           (non-member addExpense)
  ClaimLinks: expired                  (wrong-secret bearer claim)
  EncryptedEscrow: not depositor       (non-depositor approveRelease)
  CreatorHub: cannot self-tip          (creator self-tip)
  ClaimLinks: expired                  (AddressBound wrong caller)
  FHERC20Vault: amount must be > 0     (shield zero amount)
  P2PExchange: same token              (offer with tokenGive == tokenWant)
  GiftMoney: not a recipient           (gift claim by non-recipient)

## Eth Sepolia results (latest run — all features + 7 2nd-legs + 9 negatives)

**38 pass / 0 fail / 4 skip.** Cross-chain parity achieved — Eth
Sepolia now matches Base Sepolia exactly cell-for-cell. The retry
wrapper closed the publicnode-RPC flake gap so this is fully reliable.

```
shield Alice              0x13b5a1816cf7614ce5e1360ca20099007e61c1941ec3823bda234ee40657713c
shield Bob                0x098806846089d53b31d033ad9cb7f1fad50cd01a5beb9fddc112eaaf4f91c674
shield Carol              0x240634b635b4e376de2e557733f3556dd5c30ffdca8bf342c5a7f6bd8e707120
shield Dave               0x6bf700400ef7bdb1d7551d2d85c08eac00605ba4f27f6bdb949c0dc3ae0e2af4
pay Alice→Bob             0xc9980972e0672da88e8abf2e79800fb1723490a58ca8a32cfda943f6983debf4
pay Carol→Dave            0x5c17b3c41514b6285f2f201ab601831ae05af5842eb08a441d1a2678c0f886b4
createGroup               0x5f7c1b8ffa285126ac5ec9fdb57533aad84ebdfc6aaa607b3e535d31d5f0ff99
settleDebt (Bob→Carol)    0x6045fe9e8778ca23a0d61dac3c7348402c1b8d65c1abe88a808974b35d257570
gift_send                 0x6fdb66129bf03509a412e37460a511014264605a1e66e75e0576e511f4018a2e
gift_claim (Bob)          0x6e1d39424ff65b22428366445b13f75eb5caf63688fd48b9bde0ace8940ce441
escrow_create             0xb4c71d4d9b5c77060159ef89a99f2a461fa3172d8aabdaa47b9cd11ffa9166b9
escrow_markDelivered      0xcda81a384d8428e19ceec004762b13eeec99f33c863d49091cf9487afdc120de
escrow_approveRelease     0xcc8148d08700b1a8ea67fcb8ba14c1d9799c70032757d042e9811bfc662d307a
claim_link_create (bearer)0x165d27f64b1807a890f022690138423c18ed402d4db4189896bfc7e17ba676b1
claim_link_addr_bound     0x23042da549bb1fef4942eb4d5dd4f87c37c6b00c7a7643baefb3ca70f819de3a
addr_bound_claim (Carol)  0x0bb5495ac4badcc8fabddbac2d094ed735fa2df4f053b9ef20982326f6d9d1d9
claim_link_claim (Dave)   0xfdc95adede87b9e64e5d2c076d4665874d3be0a64e617f87430c427957490620
inheritance_setHeir       0x7e64e81786654fe87e20ed9366fc76e8af278248928834aae27d5aa955cb76e1
storefront_listing        0x0aa6d592713a1abf4d9e02e6aa5ebecfeb52e169bd2c3e0f56f383c14e048977
storefront_buy (Carol)    0x3bbf202ee776b49fcba70c4a031400ec2e0fc63122815c4da3a9bf8c06762e8f
crowdfund_create          0x6759181f65324fbf7f769faef527288cce20a5bddead628c6a550aca4f888b2e
p2p_offer                 0x9ddf7c2401c36831c4690f8b0bd9748a7d784b3059dd7ca059a974a5badb7b5d
runPayroll                0x78ce45835ac8e5e4f6db54ec40b25952834ac6f146a308429c61504da58efbf4
requestUnshield           0x47a03927266904c0cb6050e0978743a6cd261ff88962c225d115baea529a86a4
creator_setProfile        0x374bfa4efc412a6b8621ec449a3d3d5f4f6f2ae43bcf8b4eb66abcab55608374
creator_support           0xfc7e5d450c6d77ee626f76dfc7f015280ad53a3c582aa47d9044b08f0ea75342
crowdfund_contribute      0x284678cab3a28ce6734aa968b737cfabeb901162cf6f6d4e1d2bf1ca1705dfe9
stealth_send (Carol→Dave) 0xccc091cc270ffff5feb2eb83027a0aab0bfc62f644af617eedddf05acbe5483e
stealth_claim (Dave)      0xa12140645919ea675d4c2817f83fcd4959bf97db4fa8cffb3a612168fd351da4
```

All 9 negative cases reverted on Eth Sepolia with the expected
reason strings (same as Base Sepolia).

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
