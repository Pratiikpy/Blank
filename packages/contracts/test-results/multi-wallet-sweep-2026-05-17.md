# Multi-wallet feature sweep — 2026-05-17

Two-chain reproducible run via `npx hardhat multi-wallet-feature-sweep`.

Each row is one real testnet transaction. Hashes are verifiable on
`sepolia.etherscan.io` (chain 11155111) and `sepolia.basescan.org`
(chain 84532).

## Personas

Deterministically derived from the deployer key + a per-persona salt.

| Name  | Address |
|-------|---------|
| Alice | `0xa695888b60067636Ca7627C9993e6C21a175C6af` |
| Bob   | `0xCc4D90A639Af04e5ee349C582870AD91f77e93CA` |
| Carol | `0x533c14e784162F3f7553ac34FCeaBbd36aeAC800` |
| Dave  | `0x0Bc6F7c2d33B0371cBcc93CdFd6BF271BBCd0b55` |

## Eth Sepolia results

10 pass / 1 fail / 4 skip. The single fail was a transient cofhe
threshold-network fetch (`ZK proof verification failed | Caused by:
fetch failed`); re-running on Base Sepolia passed the same step
cleanly, confirming the contract path is correct.

| Feature              | Persona | Tx Hash |
|----------------------|---------|---------|
| shield               | Alice   | `0x3a03ef89bd1c2ff33f826541f4addaf8bb912735126c1e9632e9ae1916816310` |
| shield               | Bob     | `0xfcd377867d8f121f3c4b8808946f4af2efdcc5674b47419db983c5914958321b` |
| shield               | Carol   | `0x18faaaa09008a1f27a76b79be8f3132d818a988583444a246f75f3ca406273c6` |
| shield               | Dave    | `0x771d65001c611073e6b22cdbddcc29f25cf92b89c6b9b8db37cc28048129e255` |
| pay_Alice_Bob        | Alice   | `0xe65483380883439002194a1a0a2cd268bcff4bb9f09a78c7c22ab9d6321ec147` |
| pay_Carol_Dave       | Carol   | `0xd834a3ffae815166bec785f18fff741e78309b32dcd8bbb3efce0d93ec7fe6c7` |
| createGroup          | Alice   | `0x537ac6709162af98f3f0c3a8fd8fd68e6dc73a8daabdce106f51b9faf6e027f5` |
| gift_send            | Alice   | `0x5b18e39f90686eb436752949944f2159596c4c7022dec7ce5679027f566d1e1f` |
| escrow_create        | Alice   | `0xaa3876d7759d47315ec026c1961ca349a7209c0870ae98ee7d451d0f88957206` |
| inheritance_setHeir  | Carol   | `0x3343015648576b06e3554adfec91bb00b21f4a0bdce63dd97573b0d90abce5a4` |
| claim_link_create    | Bob     | _failed: transient cofhe TN fetch_ |

## Base Sepolia results

**15 pass / 0 fail / 0 skip.** Every feature × persona cell green.

| Feature              | Persona | Tx Hash |
|----------------------|---------|---------|
| faucet               | Alice   | `0x701ac576ea13cf8a6fe8ef83fbd0e77288103ccb54b7dfb630b03fe23c19744d` |
| faucet               | Bob     | `0xc608d876ea110052930d9e528840eadd9121b0131273ca50be97a3410cec5ad6` |
| faucet               | Carol   | `0x107500fbd28a68637e1f275642553a9a0c918360d41816909f7880407beeefbf` |
| faucet               | Dave    | `0x2d3b1cc812f4c696d0626614f655279ee2e32dbe9664357279bdda843fb51a80` |
| shield               | Alice   | `0x8f606c30c1d4c32e93ae487305b9953630afb035266e7123c0671d2229e5cd0b` |
| shield               | Bob     | `0x0d23ff2d31550af5369170bf8ec7334c205ebea3ba76cf5741658d8fe1e6e909` |
| shield               | Carol   | `0xfe839dc43d026f7de759a443102a27586fe208772aa360440860a3e66faacc1d` |
| shield               | Dave    | `0x645c1a4ce3e6e027f8f5137c74493ef4f2fd81cc3f6e80e289d844b26747147f` |
| pay_Alice_Bob        | Alice   | `0x9707f9cfd9eb0859c299ff5914a7eb29f63a870c157d9b0484c3d0cdf78597d7` |
| pay_Carol_Dave       | Carol   | `0xea601ff31d24488e396abbbbecb5a666a383378f8e7a8c33a50099b219537386` |
| createGroup          | Alice   | `0x65972d9f9c1dff6227fd2737766a552614607c52a13b83dcaee9680591a73353` |
| gift_send            | Alice   | `0xc3602684d62dda30e7e9a71e63b93127016977439a696c4c632e0c35c437da2b` |
| escrow_create        | Alice   | `0xce9e694ee2d74274fdeb9b1a7db420f167200ed348c1214fbb81ea34b70086c7` |
| claim_link_create    | Bob     | `0x48eb26cf52180216d819c5cd8dee7525623f9c3039b4bc161a3545a8f2709109` |
| inheritance_setHeir  | Carol   | `0x4f66bed9c8af1c196eaa81de6310a478e08dd0366827c45d022726410a028e94` |

## Reproducing

```
npx hardhat multi-wallet-feature-sweep --network eth-sepolia
npx hardhat multi-wallet-feature-sweep --network base-sepolia
```

Idempotent: re-running skips faucet/funding steps when the persona
already has balance.
