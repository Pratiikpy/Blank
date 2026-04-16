import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase, fetchActivities, type ActivityRow } from "@/lib/supabase";
import { onCrossTabAction } from "@/lib/cross-tab";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { STORAGE_KEYS, getStoredJson, setStoredJson } from "@/lib/storage";
import { useActivityDedup } from "./useActivityDedup";

/** Add a value to a Set, evicting the oldest half when maxSize is reached. */
function addToCappedSet(set: Set<string>, value: string, maxSize = 500) {
  if (set.size >= maxSize) {
    const entries = Array.from(set);
    set.clear();
    entries.slice(entries.length - Math.floor(maxSize / 2)).forEach((e) => set.add(e));
  }
  set.add(value);
}

// Page size for both the initial load and each subsequent loadMore() call.
// Kept small-ish so the first paint is fast; loadMore fetches additional
// pages on demand.
const PAGE_SIZE = 50;

// #223: deterministic activity sort. Server sorts by `created_at desc`, but
// rows that share a `created_at` (same block, same wall clock) come back in
// arbitrary order, so two clients can render different feeds. We always
// re-sort with `tx_hash desc` as the tie-breaker so every viewer agrees on
// the order. tx_hash includes a per-row suffix for fanout rows
// (`{hash}_{recipient}`), so it's unique even when the underlying tx is
// shared across recipients.
//
// TODO: the proper fix is an `event_index` column on activities populated
// from log_index at insert time — that's a separate migration.
function sortActivitiesStable<T extends { created_at: string; tx_hash: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const dt =
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (dt !== 0) return dt;
    return b.tx_hash.localeCompare(a.tx_hash);
  });
}
// Hard cap on how many rows we keep in localStorage. Loaded-more rows beyond
// this cap don't get cached — the server is the source of truth for deep
// history, the cache only exists to make the first paint feel instant.
const CACHE_CAP = 100;

/**
 * Activity feed — works in 3 modes:
 * 1. Supabase configured → real-time push from DB
 * 2. Supabase not configured → reads from localStorage cache
 * 3. Manual additions via addLocalActivity() for immediate UI feedback
 */
export function useActivityFeed() {
  // Smart-wallet-aware: when active, follow the smart account's activities,
  // not the EOA's. Otherwise smart-wallet users would see an empty feed
  // even after they've sent payments via their AA.
  //
  // #190: when the smart account is active, the EOA still appears in some
  // rows (e.g. counterparties that paid the EOA before the AA was deployed,
  // or off-the-AA-path flows). We query for BOTH addresses so the feed is
  // complete regardless of which address a given counterparty targeted.
  const { effectiveAddress, eoa } = useEffectiveAddress();
  const address = effectiveAddress;
  const { activeChainId } = useChain();
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // #249: shared dedup with useRealtimeNotifications — same tx_hash seen by
  // either hook is suppressed in the other. Backed by a module-level Map.
  const { accept: acceptTx } = useActivityDedup(address, activeChainId);
  // Backup: per-hook seen-set for the "have we already cached this tx?" check
  // used by loadActivities() / loadMore() / cache hydration. Kept as a
  // safety net so a buggy shared dedup doesn't double-prepend rows.
  const notifiedTxs = useRef(new Set<string>());

  // #251: realtime INSERT batching — when a single tx (e.g. PaymentHub.batchSend)
  // emits N events that arrive within a few ms, queue them in a ref and flush
  // every 100ms in one setActivities call. Avoids N back-to-back re-renders.
  const insertBufferRef = useRef<ActivityRow[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Both EOA and AA when they differ. Sender doesn't need this because the
  // writer already tagged user_from with whichever address actually signed;
  // recipient does, because counterparties may target either one.
  const addresses = useMemo(() => {
    const list: string[] = [];
    if (effectiveAddress) list.push(effectiveAddress);
    if (eoa && (!effectiveAddress || eoa.toLowerCase() !== effectiveAddress.toLowerCase())) {
      list.push(eoa);
    }
    return list;
  }, [eoa, effectiveAddress]);

  const cacheKey = address
    ? STORAGE_KEYS.activities(address, activeChainId)
    : null;

  // Load from cache on mount
  useEffect(() => {
    if (!cacheKey) return;
    const parsed = getStoredJson<ActivityRow[] | null>(cacheKey, null);
    if (parsed) {
      setActivities(sortActivitiesStable(parsed));
      parsed.forEach((a) => addToCappedSet(notifiedTxs.current, a.tx_hash));
    }
  }, [cacheKey]);

  // Fetch first page from Supabase
  const loadActivities = useCallback(async () => {
    if (addresses.length === 0) return;
    setIsLoading(true);

    try {
      const data = await fetchActivities(addresses, PAGE_SIZE);
      if (data.length > 0) {
        const sorted = sortActivitiesStable(data);
        setActivities(sorted);
        sorted.forEach((a) => addToCappedSet(notifiedTxs.current, a.tx_hash));
        // Cache — capped at CACHE_CAP so the cache stays small.
        if (cacheKey) {
          setStoredJson(cacheKey, sorted.slice(0, CACHE_CAP));
        }
        setIsOffline(false);
      }
      // hasMore is true only if the page filled completely — partial page
      // means we've hit the end of the user's history.
      setHasMore(data.length === PAGE_SIZE);
    } catch {
      setIsOffline(true);
    }

    setIsLoading(false);
  }, [addresses, cacheKey]);

  /**
   * Load the next page of older activities using the oldest current row's
   * created_at as a cursor. Returns the number of rows added (0 means no
   * more history — hasMore is set to false).
   *
   * Cache is NOT updated for loaded-more rows: keeping the cache capped at
   * CACHE_CAP rows avoids bloating localStorage for heavy users, and the
   * server is the source of truth when a user scrolls deep.
   */
  const loadMore = useCallback(async (): Promise<number> => {
    if (addresses.length === 0 || isLoadingMore) return 0;
    if (activities.length === 0) return 0;

    const oldest = activities[activities.length - 1];
    if (!oldest?.created_at) {
      setHasMore(false);
      return 0;
    }

    setIsLoadingMore(true);
    try {
      const data = await fetchActivities(addresses, PAGE_SIZE, oldest.created_at);
      // Dedupe against existing tx_hashes in the list — avoids any chance
      // of a realtime insert landing between loadMore calls duplicating a row.
      const existing = new Set(activities.map((a) => a.tx_hash));
      const fresh = data.filter((a) => !existing.has(a.tx_hash));

      if (fresh.length === 0) {
        setHasMore(false);
        return 0;
      }

      fresh.forEach((a) => addToCappedSet(notifiedTxs.current, a.tx_hash));
      // #223: re-sort the merged list so loaded-more rows interleave
      // deterministically with the current head if any timestamps overlap.
      setActivities((prev) => sortActivitiesStable([...prev, ...fresh]));
      // If the server returned a partial page, we've hit the end.
      setHasMore(data.length === PAGE_SIZE);
      return fresh.length;
    } catch {
      return 0;
    } finally {
      setIsLoadingMore(false);
    }
  }, [addresses, activities, isLoadingMore]);

  // Real-time subscription
  useEffect(() => {
    if (addresses.length === 0 || !supabase) {
      setIsOffline(!supabase);
      return;
    }

    loadActivities();

    // #88: previously only subscribed to user_to → the SENDER's own feed
    // never updated in realtime after their own send. Supabase doesn't
    // support OR in a single postgres_changes filter, so open two channels.
    //
    // #190: EOA + AA — a user may have both addresses relevant at once.
    // Open two channels per address (incoming + outgoing); dedup happens
    // via `notifiedTxs`.

    function flushInserts() {
      flushTimerRef.current = null;
      const buffered = insertBufferRef.current;
      if (buffered.length === 0) return;
      insertBufferRef.current = [];
      setActivities((prev) => {
        // Prepend all buffered rows in one batch, then re-sort so they land
        // in the deterministic position even if `created_at` ties.
        const updated = sortActivitiesStable([...buffered, ...prev]);
        if (cacheKey) {
          setStoredJson(cacheKey, updated.slice(0, CACHE_CAP));
        }
        return updated;
      });
    }

    function handleInsert(payload: { new: Record<string, unknown> }) {
      const newActivity = payload.new as unknown as ActivityRow;
      // #249: shared dedup gate — same tx_hash seen by useRealtimeNotifications
      // (or vice versa) is suppressed here. Local notifiedTxs Set kept as a
      // backup safety net for cache-hydration / loadMore paths.
      if (!acceptTx({ tx_hash: newActivity.tx_hash })) return;
      if (notifiedTxs.current.has(newActivity.tx_hash)) return;
      addToCappedSet(notifiedTxs.current, newActivity.tx_hash);
      // #251: buffer + 100ms debounce — coalesces N events from a single
      // batchSend tx into one render instead of N back-to-back updates.
      insertBufferRef.current.push(newActivity);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = setTimeout(flushInserts, 100);
    }

    const channels = addresses.flatMap((a) => {
      const addrLower = a.toLowerCase();
      const incoming = supabase!
        .channel(`activities_in_${addrLower}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "activities", filter: `user_to=eq.${addrLower}` },
          handleInsert
        )
        .subscribe();

      const outgoing = supabase!
        .channel(`activities_out_${addrLower}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "activities", filter: `user_from=eq.${addrLower}` },
          handleInsert
        )
        .subscribe();

      return [incoming, outgoing];
    });

    return () => {
      for (const ch of channels) {
        supabase!.removeChannel(ch);
      }
      // #251: drain any pending buffered inserts on unmount so we don't
      // drop rows that arrived in the last 100ms before teardown.
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushInserts();
    };
  }, [addresses, loadActivities, cacheKey, acceptTx]);

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
      const updated = sortActivitiesStable([localActivity, ...prev]);
      if (cacheKey) {
        setStoredJson(cacheKey, updated.slice(0, CACHE_CAP));
      }
      return updated;
    });
  }, [cacheKey]);

  return {
    activities,
    isLoading,
    isLoadingMore,
    isOffline,
    hasMore,
    refetch: loadActivities,
    loadMore,
    addLocalActivity,
  };
}
