import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount } from "wagmi";
import { supabase, fetchActivities, type ActivityRow } from "@/lib/supabase";
import { onCrossTabAction } from "@/lib/cross-tab";
import { useSmartAccount } from "./useSmartAccount";

/** Add a value to a Set, evicting the oldest half when maxSize is reached. */
function addToCappedSet(set: Set<string>, value: string, maxSize = 500) {
  if (set.size >= maxSize) {
    const entries = Array.from(set);
    set.clear();
    entries.slice(entries.length - Math.floor(maxSize / 2)).forEach((e) => set.add(e));
  }
  set.add(value);
}

/**
 * Activity feed — works in 3 modes:
 * 1. Supabase configured → real-time push from DB
 * 2. Supabase not configured → reads from localStorage cache
 * 3. Manual additions via addLocalActivity() for immediate UI feedback
 */
export function useActivityFeed() {
  const { address: eoaAddress } = useAccount();
  const smartAccount = useSmartAccount();
  // Smart-wallet-aware: when active, follow the smart account's activities,
  // not the EOA's. Otherwise smart-wallet users would see an empty feed
  // even after they've sent payments via their AA.
  const address =
    smartAccount.status === "ready" && smartAccount.account
      ? (smartAccount.account.address as `0x${string}`)
      : eoaAddress;
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const notifiedTxs = useRef(new Set<string>());

  const cacheKey = address ? `blank_activities_${address}` : null;

  // Load from cache on mount
  useEffect(() => {
    if (!cacheKey) return;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as ActivityRow[];
        setActivities(parsed);
        parsed.forEach((a) => addToCappedSet(notifiedTxs.current, a.tx_hash));
      }
    } catch {
      // corrupt cache, ignore
    }
  }, [cacheKey]);

  // Fetch from Supabase if available
  const loadActivities = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);

    try {
      const data = await fetchActivities(address, 100);
      if (data.length > 0) {
        setActivities(data);
        data.forEach((a) => addToCappedSet(notifiedTxs.current, a.tx_hash));
        // Cache
        if (cacheKey) {
          try {
            localStorage.setItem(cacheKey, JSON.stringify(data.slice(0, 100)));
          } catch {
            // Storage quota exceeded — non-critical, data still in memory
          }
        }
        setIsOffline(false);
      }
    } catch {
      setIsOffline(true);
    }

    setIsLoading(false);
  }, [address, cacheKey]);

  // Real-time subscription
  useEffect(() => {
    if (!address || !supabase) {
      setIsOffline(!supabase);
      return;
    }

    loadActivities();

    const channel = supabase
      .channel(`activities_${address}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activities", filter: `user_to=eq.${address.toLowerCase()}` },
        (payload) => {
          const newActivity = payload.new as ActivityRow;
          if (notifiedTxs.current.has(newActivity.tx_hash)) return;
          addToCappedSet(notifiedTxs.current, newActivity.tx_hash);
          setActivities((prev) => {
            const updated = [newActivity, ...prev].slice(0, 100);
            if (cacheKey) {
              try { localStorage.setItem(cacheKey, JSON.stringify(updated)); } catch { /* quota */ }
            }
            return updated;
          });
        }
      )
      .subscribe();

    return () => { supabase!.removeChannel(channel); };
  }, [address, loadActivities, cacheKey]);

  // Cross-tab sync: when another tab performs an action, refetch activities
  useEffect(() => {
    return onCrossTabAction((action) => {
      if (action === "activity_added" || action === "balance_changed") {
        loadActivities();
      }
    });
  }, [loadActivities]);

  // Add activity locally for immediate UI feedback (even without Supabase)
  const addLocalActivity = useCallback((activity: Omit<ActivityRow, "id" | "created_at">) => {
    const localActivity: ActivityRow = {
      ...activity,
      id: `local_${Date.now()}`,
      created_at: new Date().toISOString(),
    };
    setActivities((prev) => {
      const updated = [localActivity, ...prev].slice(0, 100);
      if (cacheKey) {
        try { localStorage.setItem(cacheKey, JSON.stringify(updated)); } catch { /* quota */ }
      }
      return updated;
    });
  }, [cacheKey]);

  return {
    activities,
    isLoading,
    isOffline,
    refetch: loadActivities,
    addLocalActivity,
  };
}
