const MAX_STORAGE_KEYS = 100;
const BLANK_PREFIX = "blank_";

/**
 * Cleans up old localStorage entries created by the app.
 * Keeps at most MAX_STORAGE_KEYS entries with the "blank_" prefix.
 */
export function cleanupOldStorage() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(BLANK_PREFIX)) keys.push(key);
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
const ADDRESS_SCOPED_SCOPES = [
  "activities",
  "contacts",
  "pending_unshield",
  "pending_send",
  "faucet_cooldown",
  "claim_codes",
  "pending_stealth_claims",
  "stealth_inbox",
  "agent_received_seen",
  "privacy",
  "my_roles_seen",
] as const;

/** Purge every address-scoped cache for `address`. Safe no-op when
 *  localStorage is unavailable. Called from the app's disconnect handlers. */
export function clearAllAddressScopes(address: string): void {
  for (const scope of ADDRESS_SCOPED_SCOPES) clearAddressScope(scope, address);
}
