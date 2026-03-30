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
  TestUSDC: "0xcd42991C767C9CCbabBc3c7Ef0d48B34B2698e4A" as `0x${string}`,
  TokenRegistry: "0x101303feBb5164D1E547986C0616B6294A673E83" as `0x${string}`,
  EventHub: "0xc3FB0CA99FC4774bF82E968E1a4F9217f5E4EF09" as `0x${string}`,
  FHERC20Vault_USDC: "0x08F62F07686242D95E4CDfA23eCa6a8F820744f1" as `0x${string}`,
  PaymentHub: "0xE2087A39cEa3C77566DF15936c2750511f808148" as `0x${string}`,
  GroupManager: "0x9C295E5A130a5776b287dcC77b41d4b55165C8Be" as `0x${string}`,
  CreatorHub: "0x845A25c4d4d0Acfc9AfDd3016A1D55b986Bad4F9" as `0x${string}`,
  BusinessHub: "0x4064e0EAD50a05F2A5a574ce4c3dd1b54BBA591c" as `0x${string}`,
  P2PExchange: "0xeE7D8987bC625A949a1355E3d5415d0419afd8BC" as `0x${string}`,
  InheritanceManager: "0x6695937AEa5388EB66C919FCe5976Fb739E1ebEa" as `0x${string}`,
  PaymentReceipts: "0x24ae70Ec10932070C582C1a34A1bb54773B02823" as `0x${string}`,
  EncryptedFlags: "0x34a6B92b0FB16c68a281c7c1565F1e99A5741a43" as `0x${string}`,
  GiftMoney: "0xD73168B5c9D22EC9dc741d9c0C24e5Fa2bc04B55" as `0x${string}`,
  PrivacyRouter: "0xd7273777D160e87BE1A59C1844792CaFE538016a" as `0x${string}`,
  StealthPayments: "0x5E2acDfa64B2438eB0bf8E0bEF627F29F1461758" as `0x${string}`,
  MockDEX: "0x206E0782b6c928486837A94c296c7e41a3Eb8FbD" as `0x${string}`,
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
