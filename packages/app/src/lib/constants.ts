// ─── Chain Configuration ────────────────────────────────────────────

export const SUPPORTED_CHAIN_ID = 11155111; // Ethereum Sepolia

export const BASE_SEPOLIA = {
  id: 11155111,
  name: "Ethereum Sepolia",
  network: "eth-sepolia",
  rpcUrl: "https://1rpc.io/sepolia",
  explorerUrl: "https://sepolia.etherscan.io",
  coFheUrl: "https://testnet-cofhe.fhenix.zone",
  verifierUrl: "https://testnet-cofhe-vrf.fhenix.zone",
  thresholdNetworkUrl: "https://testnet-cofhe-tn.fhenix.zone",
} as const;

// ─── Contract Addresses (updated after deployment) ──────────────────
// These will be updated after running `deploy-all` task

export const CONTRACTS = {
  TestUSDC: "0x16369CD4B9533795dCdc0D67DB3E4c621ef97D68" as `0x${string}`,
  TokenRegistry: "0xE2333a6c58E21A8Cc45982612a31dB1440D9888A" as `0x${string}`,
  EventHub: "0x06F8fc382144b125E168B5f70Ef51bb6286A20eB" as `0x${string}`,
  FHERC20Vault_USDC: "0x3a587f224CC3e1745565cfca8500e5934485AB51" as `0x${string}`,
  PaymentHub: "0xB628719994C21A5CcAb190019b42750f092Fb5eB" as `0x${string}`,
  GroupManager: "0x944360c5fD0eDCa2052aeC77530600c65171Dd27" as `0x${string}`,
  CreatorHub: "0x62FF5C540f9Fb9cDCb9B095dd50e77b502fFB4A1" as `0x${string}`,
  BusinessHub: "0x3048Df6de18355EB6ce2eF0bB923B55E75FB5717" as `0x${string}`,
  P2PExchange: "0x53392D0766964723649443c8bA36c4517A79A054" as `0x${string}`,
  InheritanceManager: "0x49020e2AB6430C5Ce7600C6e39c66BC549349835" as `0x${string}`,
  PaymentReceipts: "0xE2087A39cEa3C77566DF15936c2750511f808148" as `0x${string}`,
  EncryptedFlags: "0x0f62b8df9772b719fea9B8c978b2b975975342Aa" as `0x${string}`,
  GiftMoney: "0x845A25c4d4d0Acfc9AfDd3016A1D55b986Bad4F9" as `0x${string}`,
  PrivacyRouter: "0xeE7D8987bC625A949a1355E3d5415d0419afd8BC" as `0x${string}`,
  StealthPayments: "0x4064e0EAD50a05F2A5a574ce4c3dd1b54BBA591c" as `0x${string}`,
  MockDEX: "0x9C295E5A130a5776b287dcC77b41d4b55165C8Be" as `0x${string}`,
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
