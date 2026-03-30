// ─── Chain Configuration ────────────────────────────────────────────

export const SUPPORTED_CHAIN_ID = 84532; // Base Sepolia

export const BASE_SEPOLIA = {
  id: 84532,
  name: "Base Sepolia",
  network: "base-sepolia",
  rpcUrl: "https://sepolia.base.org",
  explorerUrl: "https://sepolia.basescan.org",
  coFheUrl: "https://testnet-cofhe.fhenix.zone",
  verifierUrl: "https://testnet-cofhe-vrf.fhenix.zone",
  thresholdNetworkUrl: "https://testnet-cofhe-tn.fhenix.zone",
} as const;

// ─── Contract Addresses (updated after deployment) ──────────────────
// These will be updated after running `deploy-all` task

export const CONTRACTS = {
  TestUSDC: "0x36f6Ec6A77AbCE769063751ABddD30263a62c4f1" as `0x${string}`,
  TokenRegistry: "0x80D2FC38657F2B27C4bEA6D73d5D9Ab17362bb68" as `0x${string}`,
  EventHub: "0x19A29d280983dF7Fcb7b957f33559927456D52b8" as `0x${string}`,
  FHERC20Vault_USDC: "0x62a8559AfE6147cCA57D1bd8CC4F0Fc72D97BA38" as `0x${string}`,
  PaymentHub: "0x9000eB2d1F207261B5fDf7Aba8CFA2a23D40c85A" as `0x${string}`,
  GroupManager: "0x91136d7c3029D9F7E768dc4Beaed584Fa57d53c4" as `0x${string}`, // V2: proxy unchanged (upgraded in place — storage-safe)
  CreatorHub: "0x9649b402FE50E8255eF7b9B46C244086715c86f0" as `0x${string}`,
  BusinessHub: "0x4137dD45097559b0d9d081896060b46c276566e3" as `0x${string}`, // V2: proxy unchanged (ABI-only update, upgraded in place)
  P2PExchange: "0xe439c7f19B7E3CAB4e0b78ecda484534EE9dC88C" as `0x${string}`,
  InheritanceManager: "0xEc4EE51DD5C09Cd2896b7Dd8569F9217B843843c" as `0x${string}`, // V2: fresh proxy deployed (struct changed)
  PaymentReceipts: "0xC458E7D3A16B48ccF3180cc20b1c127283C26215" as `0x${string}`,
  EncryptedFlags: "0x308862f79cCd0f625F2EBc1998E7B14a1D9d85C9" as `0x${string}`,
  // --- Wave 2 Contracts (deployed via deploy-new-features) ---
  GiftMoney: "0xE924Bd7e61b81ee3A43D488502ff4Ff3c09E471F" as `0x${string}`, // V2: fresh proxy deployed (struct changed)
  PrivacyRouter: "0xE2333a6c58E21A8Cc45982612a31dB1440D9888A" as `0x${string}`,
  StealthPayments: "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68" as `0x${string}`,
  MockDEX: "0x2d45d8B82a1fB7b2F60D3359F8dF36bCDb7B3f2c" as `0x${string}`,
} as const;

// ─── App Configuration ──────────────────────────────────────────────

export const TOKEN_DECIMALS = 6; // TestUSDC.decimals() — used by all hooks
export const APP_NAME = "Blank";
export const APP_DESCRIPTION = "Social payments. Private amounts.";

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
