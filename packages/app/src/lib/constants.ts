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
  TestUSDC: "0x9558E2D3157c986591F325a6e76cA2fdFDB0b7AD" as `0x${string}`,
  TokenRegistry: "0x30329fAf6D44955D9Cd8074011D64174fF12F0D8" as `0x${string}`,
  EventHub: "0xBA620E742F1AbBCcEf8a2b1A50108d7Dc3f0c128" as `0x${string}`,
  FHERC20Vault_USDC: "0x22c543F1303Ba25A52694C89D8d09D26FBb7569E" as `0x${string}`,
  PaymentHub: "0x899f22B60A856Ec6FCb7C888c43f1A9891E9d6C5" as `0x${string}`,
  GroupManager: "0xA09180531Be353D136e35cD5c1667D6c014f5bb1" as `0x${string}`,
  CreatorHub: "0xdB6F2625e866c0D4F885C6425Ba76Ae2b544B73A" as `0x${string}`,
  BusinessHub: "0x79A544EfA82fc1567FfF008ACb8BD90FE6f853BF" as `0x${string}`,
  P2PExchange: "0x6Acfb8bA3E73511dc4e7DE63d5514D3bf9b6696E" as `0x${string}`,
  InheritanceManager: "0x961F292c48631726e86b8715C57b25Be57F0e560" as `0x${string}`,
  PaymentReceipts: "0x976b79128D1d4269942EA4500e89A18D8918DDB5" as `0x${string}`,
  EncryptedFlags: "0xB50843277e7530fba931E73592C11D0b33b049c2" as `0x${string}`,
  GiftMoney: "0x8D57c702DA6E37329ffbe40dD631E69846d8cb16" as `0x${string}`,
  PrivacyRouter: "0x53CBAF7407Ab26cd4C75a04587bb3F7172C2a084" as `0x${string}`,
  StealthPayments: "0xCEa97fFb0CC967C862a9a67E22A5418990523A0E" as `0x${string}`,
  MockDEX: "0xEa27A3c07b27E3d0355F015c62fc7804A2195128" as `0x${string}`,
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
