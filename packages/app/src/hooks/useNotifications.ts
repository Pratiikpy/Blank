import { useCallback, useEffect, useMemo, useState } from "react";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { supabase as sb } from "@/lib/supabase";
import {
  type NotificationEventType,
} from "@/lib/notification-events";

// Wave 5 Block 5 — in-app notification feed.
//
// Reads the `notifications` table for the current address. Subscribes
// to realtime INSERT events so new notifications appear without a
// refresh. Marks rows as read on the bell-click open. Caches the last
// 50 in IndexedDB-via-localStorage so the bell paints instantly.
//
// Supabase is optional. If sb is null, the hook returns a stable
// empty state — the bell still renders with a zero count.

export interface NotificationRow {
  id: string;
  event_id: string;
  handle: string;
  event_type: NotificationEventType;
  payload: Record<string, unknown>;
  read: boolean;
  delivered_push: boolean;
  delivered_email: boolean;
  created_at: string;
}

const CACHE_KEY_PREFIX = "blank:notif-cache:v1:";

function readCache(handle: string): NotificationRow[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + handle);
    if (!raw) return [];
    return JSON.parse(raw) as NotificationRow[];
  } catch {
    return [];
  }
}

function writeCache(handle: string, rows: NotificationRow[]) {
  try {
    localStorage.setItem(CACHE_KEY_PREFIX + handle, JSON.stringify(rows.slice(0, 50)));
  } catch {
    // quota errors are non-fatal
  }
}

export function useNotifications() {
  const { effectiveAddress } = useEffectiveAddress();
  const handleKey = effectiveAddress?.toLowerCase() ?? "";

  const [rows, setRows] = useState<NotificationRow[]>(() =>
    handleKey ? readCache(handleKey) : [],
  );
  const [loading, setLoading] = useState(false);

  const unreadCount = useMemo(() => rows.filter((r) => !r.read).length, [rows]);

  const load = useCallback(async () => {
    if (!sb || !handleKey) return;
    setLoading(true);
    try {
      const { data, error } = await sb
        .from("notifications")
        .select("*")
        .eq("handle", handleKey)
        .order("created_at", { ascending: false })
        .limit(50);
      if (!error && data) {
        setRows(data as NotificationRow[]);
        writeCache(handleKey, data as NotificationRow[]);
      }
    } finally {
      setLoading(false);
    }
  }, [handleKey]);

  useEffect(() => {
    if (!handleKey) return;
    setRows(readCache(handleKey));
    void load();
  }, [handleKey, load]);

  // Realtime subscription: INSERT events for this handle.
  useEffect(() => {
    if (!sb || !handleKey) return;
    const channel = sb
      .channel(`notifications:${handleKey}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `handle=eq.${handleKey}` },
        (payload) => {
          const row = payload.new as NotificationRow;
          setRows((prev) => {
            if (prev.some((r) => r.event_id === row.event_id)) return prev;
            const next = [row, ...prev].slice(0, 50);
            writeCache(handleKey, next);
            return next;
          });
        },
      )
      .subscribe();
    return () => { if (sb) void sb.removeChannel(channel); };
  }, [handleKey]);

  const markAllRead = useCallback(async () => {
    if (rows.length === 0) return;
    const next = rows.map((r) => ({ ...r, read: true }));
    setRows(next);
    writeCache(handleKey, next);
    if (sb && handleKey) {
      void sb.from("notifications").update({ read: true }).eq("handle", handleKey).eq("read", false);
    }
  }, [rows, handleKey]);

  return {
    rows,
    unreadCount,
    loading,
    load,
    markAllRead,
  };
}
