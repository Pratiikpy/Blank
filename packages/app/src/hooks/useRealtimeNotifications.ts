import { useEffect, useMemo, useRef } from "react";
import toast from "react-hot-toast";
import { supabase, fetchActivities } from "@/lib/supabase";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { useActivityDedup } from "./useActivityDedup";
import { formatActivityMessage, iconForActivityType } from "@/lib/activity-messages";

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
 * Global real-time notification hook.
 * Mounted at app root — listens for all events relevant to the connected user.
 *
 * Subscribes to TWO activity channels (user_to and user_from) so the sender's
 * own feed updates in realtime as well. Deduplicates via Set<string> on tx_hash.
 *
 * On mount, fetches recent activities from the last 5 minutes and shows toast
 * for any the user may have missed while offline.
 */
export function useRealtimeNotifications() {
  // #6 + #171: smart-wallet users receive activities at their AA address, NOT
  // their EOA. useEffectiveAddress centralises this so notifications actually
  // fire for AA users.
  //
  // #190: when the smart account is active, counterparties may still target
  // the EOA (legacy flows, non-AA-aware apps, etc.). Subscribe on BOTH
  // addresses so we don't miss any notifications. Dedup via `notified`.
  const { effectiveAddress, eoa } = useEffectiveAddress();
  const { activeChainId } = useChain();
  // #249: shared dedup with useActivityFeed — same tx_hash already seen by
  // either hook is suppressed in the other. Backed by a module-level Map.
  const { accept: acceptTx } = useActivityDedup(effectiveAddress, activeChainId);

  const addresses = useMemo(() => {
    const list: string[] = [];
    if (effectiveAddress) list.push(effectiveAddress.toLowerCase());
    if (eoa && (!effectiveAddress || eoa.toLowerCase() !== effectiveAddress.toLowerCase())) {
      list.push(eoa.toLowerCase());
    }
    return list;
  }, [eoa, effectiveAddress]);

  // Backup: per-hook seen-set kept as a safety net.
  const notified = useRef(new Set<string>());

  useEffect(() => {
    if (addresses.length === 0 || !supabase) return;

    const addrSet = new Set(addresses);

    // ─── FIX 3: Initial fetch for missed notifications ──────────
    // Fetch recent activities and toast any from the last 5 minutes
    (async () => {
      try {
        const recent = await fetchActivities(addresses, 10);
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;

        for (const row of recent) {
          const createdAt = new Date(row.created_at).getTime();
          if (createdAt < fiveMinAgo) continue;
          // #249: shared dedup gate (with useActivityFeed) — backup local Set.
          if (!acceptTx({ tx_hash: row.tx_hash })) continue;
          if (notified.current.has(row.tx_hash)) continue;
          addToCappedSet(notified.current, row.tx_hash);

          // Only show toast for activities where we are the recipient (not self-sends).
          // "We" = any of our addresses; a self-send is one where user_to is us AND
          // user_from is also one of ours.
          const toIsUs = addrSet.has(row.user_to);
          const fromIsUs = addrSet.has(row.user_from);
          if (toIsUs && !fromIsUs) {
            const from = `${row.user_from.slice(0, 6)}...${row.user_from.slice(-4)}`;
            toast(formatActivityMessage(row.activity_type, from, row.note), {
              icon: iconForActivityType(row.activity_type),
              duration: 5000,
            });
          }
        }
      } catch {
        // Silently fail — initial fetch is best-effort
      }
    })();

    // ─── Realtime handler (shared by all channels) ───────────────
    // Formatting + icon come from lib/activity-messages which is the single
    // source of truth for every activity type the app knows about.
    function handleActivityInsert(payload: { new: Record<string, unknown> }) {
      const row = payload.new as {
        tx_hash: string;
        user_from: string;
        user_to: string;
        activity_type: string;
        note: string;
      };
      // #249: shared dedup gate (with useActivityFeed) — backup local Set.
      if (!acceptTx({ tx_hash: row.tx_hash })) return;
      if (notified.current.has(row.tx_hash)) return;
      addToCappedSet(notified.current, row.tx_hash);

      // Only show toast when user is the recipient (not for own sends).
      const toIsUs = addrSet.has(row.user_to);
      const fromIsUs = addrSet.has(row.user_from);
      if (!toIsUs || fromIsUs) return;

      const from = `${row.user_from.slice(0, 6)}...${row.user_from.slice(-4)}`;
      toast(formatActivityMessage(row.activity_type, from, row.note), {
        icon: iconForActivityType(row.activity_type),
        duration: 5000,
      });
    }

    // ─── FIX 2: Subscribe to BOTH directions × BOTH addresses ────
    // Supabase postgres_changes filters don't support OR, so one channel
    // per (address, direction) pair. #190: on AA users this means 4 channels.
    const channels = addresses.flatMap((addr) => {
      const incoming = supabase!
        .channel(`notify_activity_incoming_${addr}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "activities", filter: `user_to=eq.${addr}` },
          handleActivityInsert
        )
        .subscribe();

      const outgoing = supabase!
        .channel(`notify_activity_outgoing_${addr}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "activities", filter: `user_from=eq.${addr}` },
          handleActivityInsert
        )
        .subscribe();

      // ─── Payment request notifications (per address) ──────────
      const requestChannel = supabase!
        .channel(`notify_requests_${addr}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "payment_requests", filter: `from_address=eq.${addr}` },
          (payload) => {
            const row = payload.new as { to_address: string; note: string };
            const from = `${row.to_address.slice(0, 6)}...${row.to_address.slice(-4)}`;
            toast(`${from} requested money${row.note ? `: "${row.note}"` : ""}`, {
              icon: "\uD83D\uDCE5",
              duration: 5000,
            });
          }
        )
        .subscribe();

      // ─── Invoice notifications (per address) ──────────────────
      const invoiceChannel = supabase!
        .channel(`notify_invoices_${addr}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "invoices", filter: `client_address=eq.${addr}` },
          (payload) => {
            const row = payload.new as { vendor_address: string; description: string };
            const from = `${row.vendor_address.slice(0, 6)}...${row.vendor_address.slice(-4)}`;
            toast(`New invoice from ${from}: ${row.description}`, {
              icon: "\uD83D\uDCC4",
              duration: 5000,
            });
          }
        )
        .subscribe();

      return [incoming, outgoing, requestChannel, invoiceChannel];
    });

    // Group expense notifications are NOT subscribed here.
    // They arrive via the activities table (filtered by user_to per member),
    // which avoids spamming all users with unrelated group expenses.

    return () => {
      for (const ch of channels) {
        supabase!.removeChannel(ch);
      }
    };
  }, [addresses, acceptTx]);
}
