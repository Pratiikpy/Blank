// ─── Chain Configuration ────────────────────────────────────────────
//
// Multi-chain support: the app runs against ONE chain per session. The
// active chain is persisted to localStorage. Switching chains writes the
// new id and reloads — avoids a reactive refactor of every consumer of
// CONTRACTS (14+ hooks / screens) while still supporting multiple chains.

export const ETH_SEPOLIA_ID = 11155111;
export const BASE_SEPOLIA_ID = 84532;
export const ARB_SEPOLIA_ID = 421614;

export type SupportedChainId =
  | typeof ETH_SEPOLIA_ID
  | typeof BASE_SEPOLIA_ID
  | typeof ARB_SEPOLIA_ID;

export interface ChainInfo {
  id: SupportedChainId;
  name: string;
  shortName: string;
  network: string;
  rpcUrl: string;
  explorerUrl: string;
  // Fhenix CoFHE infrastructure endpoints (same per Sepolia — all testnet)
  coFheUrl: string;
  verifierUrl: string;
  thresholdNetworkUrl: string;
}

/** Get the block explorer tx URL for a given chain. Falls back to Base Sepolia. */
export function getExplorerTxUrl(txHash: string, chainId?: number): string {
  const chain = chainId && chainId in CHAINS
    ? CHAINS[chainId as SupportedChainId]
    : CHAINS[BASE_SEPOLIA_ID];
  return `${chain.explorerUrl}/tx/${txHash}`;
}

export const CHAINS: Record<SupportedChainId, ChainInfo> = {
  [ETH_SEPOLIA_ID]: {
    id: ETH_SEPOLIA_ID,
    name: "Ethereum Sepolia",
    shortName: "Eth Sepolia",
    network: "eth-sepolia",
    rpcUrl: "https://1rpc.io/sepolia",
    explorerUrl: "https://sepolia.etherscan.io",
    coFheUrl: "https://testnet-cofhe.fhenix.zone",
    verifierUrl: "https://testnet-cofhe-vrf.fhenix.zone",
    thresholdNetworkUrl: "https://testnet-cofhe-tn.fhenix.zone",
  },
  [BASE_SEPOLIA_ID]: {
    id: BASE_SEPOLIA_ID,
    name: "Base Sepolia",
    shortName: "Base Sepolia",
    network: "base-sepolia",
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia-explorer.base.org",
    coFheUrl: "https://testnet-cofhe.fhenix.zone",
    verifierUrl: "https://testnet-cofhe-vrf.fhenix.zone",
    thresholdNetworkUrl: "https://testnet-cofhe-tn.fhenix.zone",
  },
  [ARB_SEPOLIA_ID]: {
    id: ARB_SEPOLIA_ID,
    name: "Arbitrum Sepolia",
    shortName: "Arb Sepolia",
    network: "arb-sepolia",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerUrl: "https://sepolia.arbiscan.io",
    // CoFHE endpoints are shared across all three testnets (same coprocessor).
    coFheUrl: "https://testnet-cofhe.fhenix.zone",
    verifierUrl: "https://testnet-cofhe-vrf.fhenix.zone",
    thresholdNetworkUrl: "https://testnet-cofhe-tn.fhenix.zone",
  },
};

/** Per-chain free testnet ETH faucets surfaced in `FundAccountModal` (Phase 7.6).
 *  Order matters — list the most reliable / fastest first. Updated as faucets
 *  come and go; verify quarterly that each link still works. */
export const FAUCET_LINKS: Record<SupportedChainId, Array<{ label: string; url: string }>> = {
  [ETH_SEPOLIA_ID]: [
    { label: "Google Cloud", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" },
    { label: "Alchemy", url: "https://www.alchemy.com/faucets/ethereum-sepolia" },
    { label: "QuickNode", url: "https://faucet.quicknode.com/ethereum/sepolia" },
    { label: "PoW (no signup)", url: "https://sepolia-faucet.pk910.de/" },
  ],
  [BASE_SEPOLIA_ID]: [
    { label: "Coinbase Portal", url: "https://portal.cdp.coinbase.com/products/faucet" },
    { label: "QuickNode", url: "https://faucet.quicknode.com/base/sepolia" },
    { label: "Alchemy", url: "https://www.alchemy.com/faucets/base-sepolia" },
  ],
  [ARB_SEPOLIA_ID]: [
    { label: "Alchemy", url: "https://www.alchemy.com/faucets/arbitrum-sepolia" },
    { label: "QuickNode", url: "https://faucet.quicknode.com/arbitrum/sepolia" },
    { label: "Chainlink", url: "https://faucets.chain.link/arbitrum-sepolia" },
  ],
};

// Canonical storage key — must match `buildStorageKey("active_chain_id")`
// in storage.ts which is what ChainProvider writes to. Pre-fix used the
// underscore-separator legacy shape "blank_active_chain_id" which never
// collided with the canonical "blank:active_chain_id" → module-level
// SUPPORTED_CHAIN_ID always defaulted to Eth Sepolia regardless of UI
// selection. Anything that imports SUPPORTED_CHAIN_ID directly (instead
// of useChain()) got the wrong chain after the user switched.
const ACTIVE_CHAIN_KEY = "blank:active_chain_id";
const LEGACY_ACTIVE_CHAIN_KEY = "blank_active_chain_id";

function readActiveChainId(): SupportedChainId {
  if (typeof localStorage === "undefined") return ETH_SEPOLIA_ID;
  // Read canonical first, fall back to the legacy key so users with a
  // pre-fix preference aren't reset on upgrade. We don't write back to
  // the legacy key here — ChainProvider/setActiveChainId writes to the
  // canonical one going forward, which will eventually shadow the legacy.
  const stored =
    localStorage.getItem(ACTIVE_CHAIN_KEY) ??
    localStorage.getItem(LEGACY_ACTIVE_CHAIN_KEY);
  if (!stored) return ETH_SEPOLIA_ID;
  const parsed = parseInt(stored, 10) as SupportedChainId;
  return parsed in CHAINS ? parsed : ETH_SEPOLIA_ID;
}

/** Active chain id — read once at module load. Use setActiveChainId() to switch. */
export const SUPPORTED_CHAIN_ID: SupportedChainId = readActiveChainId();
export const ACTIVE_CHAIN: ChainInfo = CHAINS[SUPPORTED_CHAIN_ID];

/** Persist a new active chain and reload so all consumers pick up fresh addresses. */
export function setActiveChainId(id: SupportedChainId) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(ACTIVE_CHAIN_KEY, String(id));
  // Reload — simpler than making every CONTRACTS consumer reactive
  if (typeof window !== "undefined") window.location.reload();
}

// Back-compat alias — earlier code referenced BASE_SEPOLIA expecting Eth Sepolia data.
export const BASE_SEPOLIA = ACTIVE_CHAIN;

// ─── Contract Addresses ─────────────────────────────────────────────
// One entry per supported chain. The `CONTRACTS` export is resolved for
// the currently active chain at module load — consumers just do
// `CONTRACTS.FHERC20Vault_USDC` as before.

export type ContractMap = {
  TestUSDC: `0x${string}`;
  TokenRegistry: `0x${string}`;
  EventHub: `0x${string}`;
  FHERC20Vault_USDC: `0x${string}`;
  /** Optional 2nd token + vault. Present on chains where
   *  P2PExchange can trade between two distinct tokens (the contract reverts
   *  with "same token" otherwise). Other chains can leave undefined. */
  TestUSDT?: `0x${string}`;
  FHERC20Vault_USDT?: `0x${string}`;
  PaymentHub: `0x${string}`;
  GroupManager: `0x${string}`;
  CreatorHub: `0x${string}`;
  BusinessHub: `0x${string}`;
  P2PExchange: `0x${string}`;
  InheritanceManager: `0x${string}`;
  PaymentReceipts: `0x${string}`;
  EncryptedFlags: `0x${string}`;
  GiftMoney: `0x${string}`;
  PrivacyRouter: `0x${string}`;
  StealthPayments: `0x${string}`;
  MockDEX: `0x${string}`;
  // ERC-4337 — same EntryPoint address on every chain, but factory and
  // paymaster are deployed per-chain so they get unique addresses.
  EntryPoint: `0x${string}`;
  BlankAccountFactory: `0x${string}`;
  BlankPaymaster: `0x${string}`;
  /** Phase 6.2 — durable backup for burner-wallet metadata. address(0)
   *  on chains where the registry hasn't been deployed yet (frontend
   *  gracefully no-ops the "Back up to chain" button in that case). */
  BurnerRegistry: `0x${string}`;
  /** Phase 4.1 — canonical BlankAccount implementation address with
   *  validator-dispatch support. The factory's `accountImplementation`
   *  is immutable and points at the OLD impl, so each user proxy must
   *  self-upgrade via UUPS to gain the new logic. The frontend reads
   *  the proxy's EIP-1967 _IMPLEMENTATION_SLOT and prompts an upgrade
   *  when it doesn't match this address. address(0) means upgrades are
   *  unavailable on this chain (impl not deployed yet). */
  BlankAccount_Impl_v041: `0x${string}`;
  /** §1.13 — BlankAccount gas-wallet upgrade. Adds receive() auto-deposit
   *  + topUpGas + withdrawGasDepositTo. Existing user proxies still
   *  point at the older impl until they self-upgrade via UUPS (the
   *  GasWalletPanel shows an upgrade prompt when the proxy's
   *  EIP-1967 _IMPLEMENTATION_SLOT doesn't match this address). Set
   *  to address(0) until the `deploy-upgrade-blankaccount-gas-wallet`
   *  hardhat task runs; the prompt is dormant while this is zero. */
  BlankAccount_Impl_gasWallet: `0x${string}`;
  /** Phase 4.1 — SessionKeyValidator address. The user authorizes this
   *  via `BlankAccount.enableValidator(SessionKeyValidator)` and then
   *  uses `setScope` / `revokeScope` to manage server-held session
   *  keys. address(0) means scheduled sends aren't available on this
   *  chain yet. */
  SessionKeyValidator: `0x${string}`;
  /** Phase 9 — ERC-5564 stealth-payment Announcer. The canonical EIP
   *  singleton at `0x55649E…45564` is deployed on every chain via the
   *  Arachnid CREATE2 deployer with the canonical salt; recipients that
   *  hardcode this address will discover our announcements without
   *  per-chain config. */
  ERC5564Announcer: `0x${string}`;
  /** Phase 9 — ERC-6538 stealth meta-address registry. The canonical
   *  Umbra/Fluidkey singleton at `0x6538…6538` is deployed on every
   *  major chain (mainnet, sepolia, base, base-sepolia, etc.). */
  ERC6538Registry: `0x${string}`;
  /** Wave 4 — magic claim links. Encrypted send-by-link with three modes
   *  (bearer / email-bound / address-bound). address(0) until the deploy
   *  task runs and writes the address back into deployments/<chain>.json. */
  ClaimLinks: `0x${string}`;
  /** Wave 4 — storefront. One-product page with three sale modes
   *  (FixedPrice / Auction / PayWhatYouWant). address(0) until deploy. */
  Storefront: `0x${string}`;
  /** Wave 4 — encrypted crowdfunding. Encrypted goal + contributions.
   *  Refund-on-failure semantics. address(0) until deploy. */
  EncryptedCrowdfund: `0x${string}`;
  /** Wave 4 — fully-encrypted escrow (Wave 4 #249). Successor to BusinessHub
   *  escrow which stored amounts in plaintext. New contract holds funds in
   *  the encrypted vault balance — amount never observable on-chain. */
  EncryptedEscrow: `0x${string}`;
  /** Wave 5 Block 1 — encrypted P2P offramp. Maker posts encrypted USDC
   *  against plaintext fiat price + rail. Taker locks, pays off-chain via
   *  UPI/Wise/Venmo/PayPal, submits Reclaim proof, USDC releases after
   *  challenge window. address(0) until `pnpm hardhat deploy-p2p-offramp`
   *  runs and writes the addresses back. Frontend treats address(0) as
   *  "feature not yet deployed on this chain" and shows a banner. */
  P2POfframp: `0x${string}`;
  /** Wave 5 Block 1 — Reclaim Protocol adapter wrapping the verifier with
   *  provider allowlist + replay map. address(0) until deploy. */
  ReclaimAdapter: `0x${string}`;
  /** Wave 5 Block 1 — operator-signed fallback verifier for when Reclaim's
   *  sandbox UPI templates are unavailable. address(0) until deploy, OR
   *  initialized with operator=address(0) to ship with mock disabled. */
  MockReclaimVerifier: `0x${string}`;
  /** Wave 5 Block 2 — per-chain @handle registry. address(0) until
   *  `pnpm hardhat deploy-blank-handles --network <chain>` runs and
   *  writes the address back. Frontend treats address(0) as
   *  "handles not yet live on this chain" with an honest banner. */
  BlankHandles: `0x${string}`;
  /** Wave 5 Block 3 — guardian-based social recovery state machine.
   *  Holds per-account guardian sets + active recovery requests.
   *  address(0) until `pnpm hardhat deploy-guardian-module --network
   *  <chain>` runs. */
  GuardianModule: `0x${string}`;
  /** Wave 5 Block 10 — encrypted balance threshold proof. Prove your
   *  balance is at or above a public threshold without revealing the
   *  underlying value. */
  ProofOfBalance: `0x${string}`;
};

export const CONTRACTS_BY_CHAIN: Record<SupportedChainId, ContractMap> = {
  [ETH_SEPOLIA_ID]: {
    TestUSDC: "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68",
    TokenRegistry: "0xE2333a6c58E21A8Cc45982612a31dB1440D9888A",
    EventHub: "0x06F8fc382144b125E168B5f70Ef51bb6286A20eB",
    FHERC20Vault_USDC: "0x3a587f224CC3e1745565cfca8500e5934485AB51",
    TestUSDT: "0xc68C56a8Ad23E515eD56F2B98FC93341D98cE78b",
    FHERC20Vault_USDT: "0xd679978e0334f0e8D4799d2E51755fEE8EE77668",
    PaymentHub: "0xB628719994C21A5CcAb190019b42750f092Fb5eB",
    GroupManager: "0x944360c5fD0eDCa2052aeC77530600c65171Dd27",
    CreatorHub: "0x62FF5C540f9Fb9cDCb9B095dd50e77b502fFB4A1",
    BusinessHub: "0x3048Df6de18355EB6ce2eF0bB923B55E75FB5717",
    P2PExchange: "0x53392D0766964723649443c8bA36c4517A79A054",
    InheritanceManager: "0x49020e2AB6430C5Ce7600C6e39c66BC549349835",
    PaymentReceipts: "0xE2087A39cEa3C77566DF15936c2750511f808148",
    EncryptedFlags: "0x0f62b8df9772b719fea9B8c978b2b975975342Aa",
    GiftMoney: "0x845A25c4d4d0Acfc9AfDd3016A1D55b986Bad4F9",
    PrivacyRouter: "0xeE7D8987bC625A949a1355E3d5415d0419afd8BC",
    StealthPayments: "0x4064e0EAD50a05F2A5a574ce4c3dd1b54BBA591c",
    MockDEX: "0x9C295E5A130a5776b287dcC77b41d4b55165C8Be",
    EntryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
    BlankAccountFactory: "0x9be54Ef62271C028350e70C5A4305314Ba7CAFcD",
    BlankPaymaster: "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E",
    // Address(0) until operator runs `pnpm hardhat deploy-burner-registry
    // --network eth-sepolia`, which will write the deployed address to
    // packages/contracts/deployments/eth-sepolia.json. Update here after.
    BurnerRegistry: "0x0000000000000000000000000000000000000000",
    // Address(0) until operator runs `pnpm hardhat deploy-upgrade-blankaccount-validator
    // --network eth-sepolia`. Frontend treats address(0) as "upgrade
    // unavailable" so the UpgradeBanner gracefully hides.
    BlankAccount_Impl_v041: "0x0000000000000000000000000000000000000000",
    // §1.13 deployed 2026-05-17. Triggers the GasWalletPanel self-
    // upgrade prompt for any existing proxy still pointing at the
    // pre-gas-wallet impl. Once a user upgrades, their receive()
    // auto-deposits ETH from any source (CEX, hardware, EOA).
    BlankAccount_Impl_gasWallet: "0x1A4C16230D8D113A146914Ce00Da7AD20B007743",
    // Address(0) until operator runs `pnpm hardhat deploy-session-key-validator
    // --network eth-sepolia`. ScheduledSends gracefully hides when unset.
    SessionKeyValidator: "0x0000000000000000000000000000000000000000",
    // Canonical EIP-5564 singleton. Same on every chain.
    ERC5564Announcer: "0x55649E01B5Df198D18D95b5cc5051630cfD45564",
    // Canonical Umbra/Fluidkey ERC-6538 singleton. Same on every chain.
    ERC6538Registry: "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538",
    // Wave 4 — magic claim links (Eth Sepolia).
    ClaimLinks: "0x9E2189149deec5e78cB2976d8DF64CAec40B12Be",
    // Wave 4 — storefront (Eth Sepolia).
    Storefront: "0x786C85880e0FCF123D726600D9784ee88B84695b",
    // Wave 4 — encrypted crowdfunding (Eth Sepolia).
    EncryptedCrowdfund: "0x383B58973f7e8DC3E47D1C2f55393E2ac48b24e1",
    // Wave 4 — encrypted escrow (Eth Sepolia).
    EncryptedEscrow: "0x4253163CfCd0cf9885333E0a7B7476d61F010feC",
    // Wave 5 Block 1 — encrypted P2P offramp (Eth Sepolia, mock-mode
    // ships testnet; live Reclaim provider IDs are Wave 5.5 work).
    // Arbiter currently set to deployer for v1 demo; rotate to a
    // multisig once the dispute path is exercised.
    P2POfframp: "0x5981C437032Da38844AE9a3aa382F993b1B8444a",
    ReclaimAdapter: "0xf866EA7630eE91cCcd0Df638679865BCD909cce6",
    MockReclaimVerifier: "0xdfc2606B1Ba148CC35b93849ac888BD7DfFD28a8",
    // Wave 5 Block 2 — per-chain @handle registry.
    BlankHandles: "0xb6F5d0a407B459D7Ab64Ae13dee0f6b371e8eA06",
    // Wave 5 Block 3 — guardian recovery state machine. 10-minute
    // challenge window on testnet (mainnet would use 24h).
    GuardianModule: "0xdBE8252D1e089759b56E742843303f0b18700c3E",
    // Wave 5 Block 10 — encrypted balance threshold proof.
    ProofOfBalance: "0xff0Fa776116a17b6fbD62E48CA14F48b31E31856",
  },
  [BASE_SEPOLIA_ID]: {
    // Base Sepolia: full v0.1.3 stack. FHERC20Vault + BusinessHub +
    // P2PExchange + PrivacyRouter + StealthPayments all run the v0.1.3
    // `allowPublic` + `publishDecryptResult` decrypt flow. Feature-parity
    // with Eth Sepolia.
    TestUSDC: "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a",
    TokenRegistry: "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E",
    EventHub: "0xD764e11e4D1e9E308B5E002E7092C43D1E84a590",
    FHERC20Vault_USDC: "0x789f0bC466E172eD737493e9796a6d0a3aB0ff23",
    // 2nd token + vault deployed for P2P swap testing (tokenGive ≠ tokenWant).
    TestUSDT: "0x2870D040D7964aDdbbD592D96573d0f26adf0066",
    FHERC20Vault_USDT: "0x7Af02f6e1759a7b6219fCc69a8dd430ACb453861",
    PaymentHub: "0xF420102Dea1acf437bfc49ded5F4E2f5ed32e831",
    GroupManager: "0x1749E0E08f86211D8239F40BdEcb9497704f9D3d",
    CreatorHub: "0x5dc36868c89F38F56856DDD55096E3F115cC12ea",
    BusinessHub: "0xEfD67E33f12a7b3A221d25f965f70d1BE6721EFD",
    P2PExchange: "0xDa606096d5C2bdE73ccB418771e12630030Ff116",
    InheritanceManager: "0x289714c46F3c47B2E610191d924dC9bDf22973d5",
    PaymentReceipts: "0x23f0530e107cCF940093c238bbc97EbdAD6fAD7c",
    EncryptedFlags: "0x75FF37Bda28EC6A0D39db7E8Ea5CC6527febDA75",
    GiftMoney: "0x37374487A6575780A6DE3C83440441C7aB03cDDf",
    PrivacyRouter: "0x910ea282e9e3434A4fF7388A614382C235c237Af",
    StealthPayments: "0x76aDF6D800D34B9Ee42AeAEC87dC7C8824132F1C",
    MockDEX: "0x067cAF8F9196d03523c4cDF4D603916Bc94b532E",
    EntryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
    BlankAccountFactory: "0xd19Bfd90907c943Eee129a2066BCbC350F4a16fb",
    BlankPaymaster: "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de",
    // See note on Sepolia entry above. Same TODO.
    BurnerRegistry: "0x0000000000000000000000000000000000000000",
    BlankAccount_Impl_v041: "0x0000000000000000000000000000000000000000",
    // §1.13 deployed 2026-05-17. Same shape as Eth Sepolia.
    BlankAccount_Impl_gasWallet: "0x02FDeFB3331c4907501260DF8a4584Bd6D920ADd",
    SessionKeyValidator: "0x0000000000000000000000000000000000000000",
    // Canonical EIP-5564 singleton. Same on every chain.
    ERC5564Announcer: "0x55649E01B5Df198D18D95b5cc5051630cfD45564",
    // Canonical Umbra/Fluidkey ERC-6538 singleton. Same on every chain.
    ERC6538Registry: "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538",
    // Wave 4 — magic claim links (Base Sepolia).
    ClaimLinks: "0x2eD78815299C2B1F2cBd2313CF763B56A0654665",
    // Wave 4 — storefront (Base Sepolia).
    Storefront: "0xeA8a38f25ECF9Cc8C9240aafb35b561D14Dfd419",
    // Wave 4 — encrypted crowdfunding (Base Sepolia).
    EncryptedCrowdfund: "0x0F21705575e2CC83dC410AE2af6973B150a4183C",
    // Wave 4 — encrypted escrow (Base Sepolia).
    EncryptedEscrow: "0x6414742D2da28eCEf06D79b82F406B6b8ab3e421",
    // Wave 5 Block 1 — P2P offramp. Same operator-pending state as
    // Eth Sepolia. Run deploy-p2p-offramp with --network base-sepolia.
    // Wave 5 Block 1 — encrypted P2P offramp (Base Sepolia).
    P2POfframp: "0xd717E7AFE5eB627c9913bc682003d6E83b9032f9",
    ReclaimAdapter: "0x2F7B59A920B76d5fD0e3c010b6a7D5E14eF83486",
    MockReclaimVerifier: "0xB36441E8c4155709E350f7c66B16c2B8174c0e75",
    // Wave 5 Block 2 — per-chain @handle registry.
    BlankHandles: "0x346077e5DA2a552f0353f3430F8baE6D7049DEF9",
    // Wave 5 Block 3 — guardian recovery state machine.
    GuardianModule: "0x4fa2152A940651404F2722c0192624d0662e5B46",
    // Wave 5 Block 10 — encrypted balance threshold proof.
    ProofOfBalance: "0x25e7383Bd5602a07928629e9Ec6eaec9535536Ff",
  },
  [ARB_SEPOLIA_ID]: {
    // Arbitrum Sepolia (421614). Full v0.1.3 stack, deployed fresh from the
    // current contract sources (deployments/arb-sepolia.json). CoFHE runs on
    // the shared coprocessor (TaskManager 0xeA30...848D9 is live on 421614).
    // The three canonical singletons (EntryPoint, ERC5564, ERC6538) are
    // identical on every chain and wired verbatim.
    TestUSDC: "0x9558E2D3157c986591F325a6e76cA2fdFDB0b7AD",
    TokenRegistry: "0x30329fAf6D44955D9Cd8074011D64174fF12F0D8",
    EventHub: "0xBA620E742F1AbBCcEf8a2b1A50108d7Dc3f0c128",
    FHERC20Vault_USDC: "0x22c543F1303Ba25A52694C89D8d09D26FBb7569E",
    TestUSDT: "0x5dD868D61EA452a0105FcCe8A9feb2Fe7682eE04",
    FHERC20Vault_USDT: "0x86b396c83CdDc8b2529e4c176b9d73ca9Cf8f295",
    PaymentHub: "0x899f22B60A856Ec6FCb7C888c43f1A9891E9d6C5",
    GroupManager: "0xA09180531Be353D136e35cD5c1667D6c014f5bb1",
    CreatorHub: "0xdB6F2625e866c0D4F885C6425Ba76Ae2b544B73A",
    BusinessHub: "0x79A544EfA82fc1567FfF008ACb8BD90FE6f853BF",
    P2PExchange: "0x6Acfb8bA3E73511dc4e7DE63d5514D3bf9b6696E",
    InheritanceManager: "0x961F292c48631726e86b8715C57b25Be57F0e560",
    PaymentReceipts: "0x976b79128D1d4269942EA4500e89A18D8918DDB5",
    EncryptedFlags: "0xB50843277e7530fba931E73592C11D0b33b049c2",
    GiftMoney: "0x944360c5fD0eDCa2052aeC77530600c65171Dd27",
    PrivacyRouter: "0x3048Df6de18355EB6ce2eF0bB923B55E75FB5717",
    StealthPayments: "0x62FF5C540f9Fb9cDCb9B095dd50e77b502fFB4A1",
    MockDEX: "0x4C3f37e645c9fbBCD8C082D3EB54ceD50bcC1C17",
    // Canonical EntryPoint v0.8 — same address on every chain.
    EntryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
    BlankAccountFactory: "0x13cD6eBd92c0A944599558521b3C10f2bA6ceE5D",
    BlankPaymaster: "0x9C295E5A130a5776b287dcC77b41d4b55165C8Be",
    BurnerRegistry: "0x27B98576E7d1874915E5C698FB7Ce733c1E3534f",
    // Dormant validator-dispatch upgrade path; address(0) on every chain.
    BlankAccount_Impl_v041: "0x0000000000000000000000000000000000000000",
    // Fresh Arb factory deploys the current (gas-wallet + validator) impl, so
    // the GasWalletPanel upgrade prompt matches and stays dormant.
    BlankAccount_Impl_gasWallet: "0x95119073430E55F1993bfc1Bf980d0f91Db92058",
    SessionKeyValidator: "0x75FF37Bda28EC6A0D39db7E8Ea5CC6527febDA75",
    // Canonical EIP-5564 singleton. Same on every chain.
    ERC5564Announcer: "0x55649E01B5Df198D18D95b5cc5051630cfD45564",
    // Canonical Umbra/Fluidkey ERC-6538 singleton. Same on every chain.
    ERC6538Registry: "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538",
    ClaimLinks: "0xdf69Ba30369C0881fF5741Ffbf26138c1413c015",
    Storefront: "0x6548466E91547af9F6698a7AF236f9ef8548d9c4",
    EncryptedCrowdfund: "0x4Face583A92f27b36f5098561CB731Aa1DbEe359",
    EncryptedEscrow: "0xfDd77d3b6489600466Da74f012bC7A7A342fdb6d",
    P2POfframp: "0x653e71e5F02a0fEAAFfCab5391DF0AE99b89961f",
    ReclaimAdapter: "0x83C76cda5ABEe1510a244d1334802446014b0Fc1",
    MockReclaimVerifier: "0xe609e5b9528F3d6587e71A820DCc090AB57B1542",
    BlankHandles: "0x4f729F66701e4ec7EC787dD1Adae7Fd6b5D1a961",
    GuardianModule: "0x4e9d93739b6F3543017C46d844F2021B6f5dC37A",
    ProofOfBalance: "0x23f0530e107cCF940093c238bbc97EbdAD6fAD7c",
  },
};

export const CONTRACTS: ContractMap = CONTRACTS_BY_CHAIN[SUPPORTED_CHAIN_ID];

// ─── AI Agent attestation address ───────────────────────────────────
//
// Public address of the wallet that signs every AgentPaymentSubmission
// event. Any observer can recover this address from the on-chain ECDSA
// signature in the event — publishing it here lets users + judges audit
// which agent the platform uses without having to recover the address
// themselves.
//
// To set: fill in the address derived from your AGENT_PRIVATE_KEY env var.
// Same key, same address on every chain (we use the same agent wallet
// across Eth Sepolia + Base Sepolia for now). Until set, the landing
// shows "not yet published" and the AgentPayments screen still works
// (the address is recoverable from each tx's signature).
export const AGENT_ATTESTATION_ADDRESS = (
  import.meta.env.VITE_AGENT_ATTESTATION_ADDRESS ?? ""
) as string;

// ─── App Configuration ──────────────────────────────────────────────

export const TOKEN_DECIMALS = 6; // TestUSDC.decimals() — used by all hooks
export const APP_NAME = "Blank";
export const APP_DESCRIPTION = "Your salary is your business. Not the blockchain's.";

// Bullet characters (•) instead of full-block (█). Reads as a design choice,
// not a loading-shimmer artifact. Matches the typographic dots in Dashboard.
export const ENCRYPTED_PLACEHOLDER = "\u2022\u2022\u2022\u2022.\u2022\u2022"; // ••••.••
export const REVEAL_TIMEOUT_MS = 10_000; // Auto-hide revealed amounts after 10s
export const PERMIT_EXPIRY_DAYS = 7;
export const MAX_BATCH_RECIPIENTS = 30;
export const POLL_INTERVAL_MS = 2_000; // Poll for decryption results every 2s
export const POLL_TIMEOUT_MS = 60_000; // Give up polling after 60s

// ─── FHE Constants ─────────────────────────────────────────────────

/** Maximum uint64 value (2^64 - 1), used for infinite FHE vault approvals */
export const MAX_UINT64 = BigInt("18446744073709551615");

/**
 * The ABI-level shape of an encrypted FHE input (InEuint64, InEbool, etc.).
 * cofhe SDK's `encryptInputsAsync` returns objects matching this shape at
 * runtime, but the SDK's TypeScript types don't align with wagmi's strict
 * ABI inference. This type is used for `as unknown as EncryptedInput` casts
 * to bridge the two type systems without resorting to `as any`.
 */
export type EncryptedInput = {
  ctHash: bigint;
  securityZone: number;
  utype: number;
  signature: `0x${string}`;
};

// ─── Supabase ───────────────────────────────────────────────────────

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
