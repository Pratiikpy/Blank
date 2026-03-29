const APPROVED_KEY = "blank_vault_approved";

/**
 * Checks localStorage to see if we've already approved this spender.
 * Falls back to always-approve if localStorage is unavailable.
 */
export function isVaultApproved(spender: string): boolean {
  try {
    const approved = JSON.parse(localStorage.getItem(APPROVED_KEY) || "{}");
    const entry = approved[spender.toLowerCase()];
    if (!entry) return false;
    // Expire after 24 hours
    if (Date.now() - entry > 24 * 60 * 60 * 1000) return false;
    return true;
  } catch {
    return false;
  }
}

export function markVaultApproved(spender: string) {
  try {
    const approved = JSON.parse(localStorage.getItem(APPROVED_KEY) || "{}");
    approved[spender.toLowerCase()] = Date.now();
    localStorage.setItem(APPROVED_KEY, JSON.stringify(approved));
  } catch {}
}

/**
 * Clears the cached approval for a specific spender.
 * Call this when a transaction fails with an allowance-related error
 * so the next attempt will re-approve instead of using stale cache.
 */
export function clearVaultApproval(spender: string) {
  try {
    const approved = JSON.parse(localStorage.getItem(APPROVED_KEY) || "{}");
    delete approved[spender.toLowerCase()];
    localStorage.setItem(APPROVED_KEY, JSON.stringify(approved));
  } catch {}
}
