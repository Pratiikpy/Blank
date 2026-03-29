const MAX_STORAGE_KEYS = 100;
const BLANK_PREFIX = "blank_";

/**
 * Cleans up old localStorage entries created by the app.
 * Keeps at most MAX_STORAGE_KEYS entries with the "blank_" prefix,
 * removing the oldest ones (sorted lexicographically, which works
 * for keys that include timestamps).
 */
export function cleanupOldStorage() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(BLANK_PREFIX)) keys.push(key);
    }
    // If we have more than MAX keys, remove oldest (by key name, which includes timestamps)
    if (keys.length > MAX_STORAGE_KEYS) {
      keys.sort();
      const toRemove = keys.slice(0, keys.length - MAX_STORAGE_KEYS);
      toRemove.forEach((k) => localStorage.removeItem(k));
    }
  } catch {
    // localStorage may be unavailable (private browsing, quota exceeded, etc.)
  }
}
