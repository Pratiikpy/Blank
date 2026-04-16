import { useEffect, useRef, useState } from "react";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { supabase, type ActivityRow } from "@/lib/supabase";
import { createActivityDedup } from "@/lib/realtime-dedup";

// ══════════════════════════════════════════════════════════════════
//  useLiveActivities
//  - Initial fetch of the most recent N activities (no address filter)
//  - Supabase realtime subscription on INSERT — prepends new rows live
//  - Tracks which rows are "new since mount" so the UI can flash them
//  ══════════════════════════════════════════════════════════════════

export interface LiveActivity extends ActivityRow {
  /** True iff this row arrived via realtime AFTER the initial fetch. */
  isNew?: boolean;
}

// #223: stable secondary sort by `tx_hash desc` so two clients viewing the
// same activity stream agree on the order even when `created_at` ties (same
// block / same wall clock). The proper fix is an `event_index` column on
// the activities table — that's a separate migration.
function sortLiveActivitiesStable(rows: LiveActivity[]): LiveActivity[] {
  return [...rows].sort((a, b) => {
    const dt =
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (dt !== 0) return dt;
    return b.tx_hash.localeCompare(a.tx_hash);
  });
}

interface UseLiveActivitiesResult {
  activities: LiveActivity[];
  isLoading: boolean;
  error: string | null;
  supabaseConfigured: boolean;
}

export function useLiveActivities(limit = 50): UseLiveActivitiesResult {
  const { effectiveAddress: address } = useEffectiveAddress();
  const [activities, setActivities] = useState<LiveActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const newIdsRef = useRef<Set<string>>(new Set());
  // #248: dedup by tx_hash too — frontend may insert an activity with one id
  // and the indexer may insert the SAME tx with a different id. id-based
  // dedup alone misses that case.
  const txDedupRef = useRef(createActivityDedup());

  // Clear feed when the connected wallet changes — avoids leaking the prior
  // user's activity view into the next session.
  useEffect(() => {
    setActivities([]);
    newIdsRef.current = new Set();
    txDedupRef.current.reset();
  }, [address]);

  // Initial load
  useEffect(() => {
    if (!supabase) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("activities")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (cancelled) return;
        if (error) throw error;
        setActivities(sortLiveActivitiesStable((data || []) as LiveActivity[]));
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load activities");
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [limit]);

  // Realtime INSERT subscription — new rows prepend, older rows drop off.
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("public:activities:live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activities" },
        (payload) => {
          const row = payload.new as LiveActivity;
          if (!row?.id) return;
          // #248: tx_hash dedup at the top — frontend + indexer can each insert
          // the same tx with different `id`s; without this the same tx renders
          // twice. Keep the id-based dedup below as a secondary safety net for
          // Supabase event replay.
          if (row.tx_hash && !txDedupRef.current.accept({ tx_hash: row.tx_hash })) {
            return;
          }
          newIdsRef.current.add(row.id);
          setActivities((prev) => {
            // Deduplicate by id (Supabase occasionally replays) AND by
            // tx_hash (in case dedup window above missed it under StrictMode
            // double-mount).
            if (prev.some((a) => a.id === row.id || (row.tx_hash && a.tx_hash === row.tx_hash))) return prev;
            // Re-sort so the realtime row lands deterministically — same
            // tie-breaker rule as the initial fetch.
            const next = sortLiveActivitiesStable([
              { ...row, isNew: true },
              ...prev,
            ]);
            return next.slice(0, limit);
          });
          // Clear the "new" flag after the flash animation completes
          setTimeout(() => {
            setActivities((prev) =>
              prev.map((a) => (a.id === row.id ? { ...a, isNew: false } : a))
            );
          }, 1600);
        }
      )
      .subscribe();

    return () => {
      supabase?.removeChannel(channel);
    };
  }, [limit]);

  return {
    activities,
    isLoading,
    error,
    supabaseConfigured: !!supabase,
  };
}
