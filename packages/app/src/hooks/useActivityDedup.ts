import { useRef, useCallback } from "react";
import { RealtimeDedup } from "@/lib/realtime-dedup";

/**
 * Shared activity-dedup primitive (#249) — both useActivityFeed and
 * useRealtimeNotifications use the SAME instance via this hook so a single
 * tx_hash being seen by one component prevents the other from re-acting on
 * it.
 *
 * Backed by a module-level Map so the same instance persists across mounts
 * (useful for StrictMode double-mount + cross-component sharing).
 *
 * Window is 60s — slightly longer than the per-table dedup in
 * RealtimeProvider so notifications never re-fire even if the bus dedup
 * has just expired.
 */

const sharedDedups = new Map<string, RealtimeDedup<{ tx_hash?: string }>>();

export function useActivityDedup(
  address: string | undefined,
  chainId: number,
) {
  const key = address ? `${address.toLowerCase()}:${chainId}` : null;
  const ref = useRef<RealtimeDedup<{ tx_hash?: string }> | null>(null);

  if (key) {
    let inst = sharedDedups.get(key);
    if (!inst) {
      inst = new RealtimeDedup<{ tx_hash?: string }>({
        keyFn: (r) => r.tx_hash ?? null,
        windowMs: 60_000,
      });
      sharedDedups.set(key, inst);
    }
    ref.current = inst;
  } else {
    ref.current = null;
  }

  const accept = useCallback((row: { tx_hash?: string }) => {
    // No address yet — admit everything; the caller's downstream gate
    // (e.g. user_to / user_from address match) will filter.
    if (!ref.current) return true;
    return ref.current.accept(row);
  }, []);

  const forget = useCallback((tx_hash: string) => {
    ref.current?.forget(tx_hash);
  }, []);

  return { accept, forget };
}

/** Test/cleanup helper — drop the shared map. Not used in app code. */
export function __resetSharedActivityDedups() {
  sharedDedups.clear();
}
