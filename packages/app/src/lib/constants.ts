// ─── Chain Configuration ────────────────────────────────────────────
//
// Multi-chain support: the app runs against ONE chain per session. The
// active chain is persisted to localStorage. Switching chains writes the
// new id and reloads — avoids a reactive refactor of every consumer of
// CONTRACTS (14+ hooks / screens) while still supporting multiple chains.

export const ETH_SEPOLIA_ID = 11155111;
export const BASE_SEPOLIA_ID = 84532;

export type SupportedChainId = typeof ETH_SEPOLIA_ID | typeof BASE_SEPOLIA_ID;

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
};

const ACTIVE_CHAIN_KEY = "blank_active_chain_id";

function readActiveChainId(): SupportedChainId {
  if (typeof localStorage === "undefined") return ETH_SEPOLIA_ID;
  const stored = localStorage.getItem(ACTIVE_CHAIN_KEY);
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
};

export const CONTRACTS_BY_CHAIN: Record<SupportedChainId, ContractMap> = {
  [ETH_SEPOLIA_ID]: {
    TestUSDC: "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68",
    TokenRegistry: "0xE2333a6c58E21A8Cc45982612a31dB1440D9888A",
    EventHub: "0x06F8fc382144b125E168B5f70Ef51bb6286A20eB",
    FHERC20Vault_USDC: "0x3a587f224CC3e1745565cfca8500e5934485AB51",
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
  },
};

export const CONTRACTS: ContractMap = CONTRACTS_BY_CHAIN[SUPPORTED_CHAIN_ID];

// ─── App Configuration ──────────────────────────────────────────────

export const TOKEN_DECIMALS = 6; // TestUSDC.decimals() — used by all hooks
export const APP_NAME = "Blank";
export const APP_DESCRIPTION = "Your salary is your business. Not the blockchain's.";

export const ENCRYPTED_PLACEHOLDER = "\u2588\u2588\u2588\u2588.\u2588\u2588"; // ████.██
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
