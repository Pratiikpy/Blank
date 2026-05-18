const MAX_STORAGE_KEYS = 100;
// cleanupOldStorage below matches BOTH "blank_" (legacy underscore-separator)
// AND "blank:" (canonical colon-separator, used by buildStorageKey below).
// Pre-fix the prefix was "blank_" only — so the canonical "blank:scope:addr:chain"
// keys produced by buildStorageKey were NEVER caught by cleanup, letting
// localStorage grow unboundedly in any active user's browser.

/**
 * Cleans up old localStorage entries created by the app.
 * Keeps at most MAX_STORAGE_KEYS entries with the "blank" prefix
 * (covers both legacy "blank_" and canonical "blank:" forms).
 */
export function cleanupOldStorage() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      // Accept both "blank_..." and "blank:..." — anything starting with
      // "blank" followed by the separator chars used by either convention.
      if (key && (key.startsWith("blank_") || key.startsWith("blank:"))) {
        keys.push(key);
      }
    }
    if (keys.length > MAX_STORAGE_KEYS) {
      keys.sort();
      const toRemove = keys.slice(0, keys.length - MAX_STORAGE_KEYS);
      toRemove.forEach((k) => localStorage.removeItem(k));
    }
  } catch {
    /* localStorage may be unavailable (private browsing, quota exceeded, etc.) */
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Centralized storage key builder (ARCHITECTURE_PLAN Layer 1)
// ═══════════════════════════════════════════════════════════════════
//
// Every per-user / per-chain cache must be scoped correctly or it leaks
// across wallet switches and chain switches. Use these helpers everywhere
// instead of hand-rolling keys in each hook.
//
// Convention: `blank:<scope>[:<lowerAddress>][:<chainId>]`

export function buildStorageKey(scope: string, address?: string, chainId?: number): string {
  const parts: string[] = ["blank", scope];
  if (address) parts.push(address.toLowerCase());
  if (chainId !== undefined) parts.push(String(chainId));
  return parts.join(":");
}

/** Typed storage-key builders. Prefer these over `buildStorageKey` directly. */
export const STORAGE_KEYS = {
  activities: (address: string, chainId: number) =>
    buildStorageKey("activities", address, chainId),
  contacts: (address: string) => buildStorageKey("contacts", address),
  pendingUnshield: (address: string, chainId: number) =>
    buildStorageKey("pending_unshield", address, chainId),
  pendingSend: (address: string, chainId: number) =>
    buildStorageKey("pending_send", address, chainId),
  giftRateLimit: () => buildStorageKey("gift_rate"),
  faucetCooldown: (address: string, chainId: number) =>
    buildStorageKey("faucet_cooldown", address, chainId),
  // Per-token cooldown for the USDT faucet — separate key so minting USDT
  // doesn't silence the USDC faucet button (and vice versa).
  faucetCooldownUsdt: (address: string, chainId: number) =>
    buildStorageKey("faucet_cooldown_usdt", address, chainId),
  claimCodes: (address: string, chainId: number) =>
    buildStorageKey("claim_codes", address, chainId),
  pendingStealthClaims: (address: string, chainId: number) =>
    buildStorageKey("pending_stealth_claims", address, chainId),
  stealthInbox: (address: string, chainId: number) =>
    buildStorageKey("stealth_inbox", address, chainId),
  agentReceivedSeen: (address: string, chainId: number) =>
    buildStorageKey("agent_received_seen", address, chainId),
  activeChainId: () => buildStorageKey("active_chain_id"),
  onboardingComplete: (address: string) =>
    buildStorageKey("onboarding", address),
  privacy: (address: string) => buildStorageKey("privacy", address),
  vaultApproved: () => buildStorageKey("vault_approved_v2"),
  myRolesSeen: (address: string, chainId: number) =>
    buildStorageKey("my_roles_seen", address, chainId),
  // CCTP V2 bridge — persists between burn and claim so a user who
  // closes the tab during the ~15 min Iris attestation poll can return
  // and resume from where they left off. Per-address (not per source
  // chain) because a single AA may have multiple bridges in flight on
  // different source chains; the persisted record carries its own
  // sourceChainId. See `useBridgeUSDC.ts` for the schema.
  pendingBridge: (address: string) =>
    buildStorageKey("pending_bridge", address),
  // Phase 6.1 — burner wallet registry. Per-MAIN-account list of derived
  // burner AAs (different `salt` values, same passkey ownership). The
  // address is recomputable from the salt + the user's passkey pubkey,
  // but the LABEL only lives here — losing localStorage means losing
  // which burner is "tips for newsletter" vs "Twitter giveaway" vs etc.
  // 6.2 (on-chain encrypted registry) is the durable backup.
  burners: (mainAddress: string) =>
    buildStorageKey("burners", mainAddress),
  // Phase 9 — ERC-5564 stealth meta-address keys. Stored per main
  // address so the same browser can host multiple stealth identities.
  // Schema (JSON):
  //   {
  //     spendingPrivateKey: "0x..."  // 32-byte hex
  //     viewingPrivateKey:  "0x..."  // 32-byte hex
  //     metaAddress:        "st:eth:0x..."
  //     publishedAt?:       <unix-seconds>  // when registry tx confirmed
  //   }
  // SECURITY NOTE: stored as plaintext today. Phase 9.6 will migrate
  // to AES-GCM at rest with key derived from passkey signature. Until
  // then, anyone with localStorage access can sweep the user's stealth
  // funds — surface this in the Setup UI when Phase 9.6 ships and warn
  // the user not to use this on shared devices.
  stealthKeys: (mainAddress: string) =>
    buildStorageKey("stealth_keys", mainAddress),
  // Phase 9.4 — last-scanned block number for the Announcement event
  // log scan, per chain + recipient. Scanning thousands of historical
  // logs every page load is too slow on free RPC tiers; we watermark
  // and only scan forward from the last seen block on subsequent loads.
  stealthInboxWatermark: (address: string, chainId: number) =>
    buildStorageKey("stealth_inbox_watermark", address, chainId),
  // Phase 9.4 — cached matched-announcement payloads, per chain +
  // recipient. Avoids re-running checkStealthAddress on the entire
  // history every load; we only check NEW logs since the watermark.
  stealthInboxMatches: (address: string, chainId: number) =>
    buildStorageKey("stealth_inbox_matches", address, chainId),
} as const;

/** Guarded getters/setters — never throw; fail-closed returning null/false. */

export function getStoredString(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getStoredJson<T>(key: string, fallback: T): T {
  const raw = getStoredString(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setStoredString(key: string, value: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function setStoredJson(key: string, value: unknown): boolean {
  try {
    return setStoredString(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

export function removeStored(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

/** Remove every key that starts with `blank:<scope>:<lowerAddress>`. Call on
 *  wallet disconnect to purge caches for one address without touching others. */
export function clearAddressScope(scope: string, address: string): void {
  if (typeof localStorage === "undefined") return;
  const prefix = buildStorageKey(scope, address) + ":";
  const plainKey = buildStorageKey(scope, address);
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(prefix) || k === plainKey)) toDelete.push(k);
    }
    toDelete.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* noop */
  }
}

// #313: every scope listed below carries per-user state (activity cache,
// pending-tx receipts, claim codes, privacy prefs, etc.). On explicit sign-out
// we purge all of them so a shared browser doesn't leak one user's cached UI
// state into the next person's session. Onboarding and theme are persistent
// device-level preferences; intentionally NOT cleared.
//
// Audit Top-28 #3 + #4: stealth_keys (spending+viewing private keys),
// stealth_inbox_watermark (last-scanned block), stealth_inbox_matches
// (matched announcement payloads), burners (named burner-wallet labels)
// were missing — leaving stealth + burner state for the next user of a
// shared browser. Pending-bridge state must also clear so a half-finished
// CCTP burn doesn't surface to the next account.
const ADDRESS_SCOPED_SCOPES = [
  "activities",
  "contacts",
  "pending_unshield",
  "pending_send",
  "pending_bridge",
  "faucet_cooldown",
  "claim_codes",
  "pending_stealth_claims",
  "stealth_inbox",
  "stealth_inbox_watermark",
  "stealth_inbox_matches",
  "stealth_keys",
  "burners",
  "agent_received_seen",
  "privacy",
  "my_roles_seen",
] as const;

/** Purge every address-scoped cache for `address`. Safe no-op when
 *  localStorage is unavailable. Called from the app's disconnect handlers. */
export function clearAllAddressScopes(address: string): void {
  for (const scope of ADDRESS_SCOPED_SCOPES) clearAddressScope(scope, address);
}
