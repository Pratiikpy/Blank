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
  TestUSDC: "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a" as `0x${string}`,
  TokenRegistry: "0x68890C23C94e25706F064f8C1d07e04462B9Ec2E" as `0x${string}`,
  EventHub: "0xD764e11e4D1e9E308B5E002E7092C43D1E84a590" as `0x${string}`,
  FHERC20Vault_USDC: "0x789f0bC466E172eD737493e9796a6d0a3aB0ff23" as `0x${string}`,
  PaymentHub: "0xF420102Dea1acf437bfc49ded5F4E2f5ed32e831" as `0x${string}`,
  GroupManager: "0x1749E0E08f86211D8239F40BdEcb9497704f9D3d" as `0x${string}`,
  CreatorHub: "0x5dc36868c89F38F56856DDD55096E3F115cC12ea" as `0x${string}`,
  BusinessHub: "0xEfD67E33f12a7b3A221d25f965f70d1BE6721EFD" as `0x${string}`,
  P2PExchange: "0xDa606096d5C2bdE73ccB418771e12630030Ff116" as `0x${string}`,
  InheritanceManager: "0x289714c46F3c47B2E610191d924dC9bDf22973d5" as `0x${string}`,
  PaymentReceipts: "0x23f0530e107cCF940093c238bbc97EbdAD6fAD7c" as `0x${string}`,
  EncryptedFlags: "0x75FF37Bda28EC6A0D39db7E8Ea5CC6527febDA75" as `0x${string}`,
  GiftMoney: "0x8cf23ab40D38504706dc54664c72a378215c5b8c" as `0x${string}`,
  PrivacyRouter: "0x30E7041580587F28E84D9166710275814d44Cc7B" as `0x${string}`,
  StealthPayments: "0x98Dfb7cb7e1bb6795222F21Fe960C81079601C97" as `0x${string}`,
  MockDEX: "0xb202fEED447452C0934236119012A6508DaB4821" as `0x${string}`,
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
