import { useEffect, useRef, useState } from "react";
import { supabase, type ActivityRow } from "@/lib/supabase";

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

interface UseLiveActivitiesResult {
  activities: LiveActivity[];
  isLoading: boolean;
  error: string | null;
  supabaseConfigured: boolean;
}

export function useLiveActivities(limit = 50): UseLiveActivitiesResult {
  const [activities, setActivities] = useState<LiveActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const newIdsRef = useRef<Set<string>>(new Set());

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
        setActivities((data || []) as LiveActivity[]);
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
          newIdsRef.current.add(row.id);
          setActivities((prev) => {
            // Deduplicate by id (Supabase occasionally replays)
            if (prev.some((a) => a.id === row.id)) return prev;
            const next = [{ ...row, isNew: true }, ...prev];
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
