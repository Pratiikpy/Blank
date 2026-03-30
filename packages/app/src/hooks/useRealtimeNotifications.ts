import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import toast from "react-hot-toast";
import { supabase, fetchActivities } from "@/lib/supabase";

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
  const { address } = useAccount();
  const notified = useRef(new Set<string>());

  useEffect(() => {
    if (!address || !supabase) return;

    const addr = address.toLowerCase();

    // ─── FIX 3: Initial fetch for missed notifications ──────────
    // Fetch recent activities and toast any from the last 5 minutes
    (async () => {
      try {
        const recent = await fetchActivities(addr, 10);
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;

        for (const row of recent) {
          const createdAt = new Date(row.created_at).getTime();
          if (createdAt < fiveMinAgo) continue;
          if (notified.current.has(row.tx_hash)) continue;
          addToCappedSet(notified.current, row.tx_hash);

          // Only show toast for activities where we are the recipient (not self-sends)
          if (row.user_to === addr && row.user_from !== addr) {
            const from = `${row.user_from.slice(0, 6)}...${row.user_from.slice(-4)}`;
            toast(formatActivityMessage(row.activity_type, from, row.note), {
              icon: row.activity_type === "payment" || row.activity_type === "tip" ? "\uD83D\uDCB0" : "\uD83D\uDCEC",
              duration: 5000,
            });
          }
        }
      } catch {
        // Silently fail — initial fetch is best-effort
      }
    })();

    // ─── Helper: format notification message ──────────────────────
    function formatActivityMessage(activityType: string, from: string, note: string): string {
      // Parse envelope ID from gift notes (format: "[envelope:123] ...")
      let giftMsg = `${from} sent you a gift`;
      if (activityType === "gift_created" && note) {
        const envMatch = note.match(/^\[envelope:(\d+)\]\s*(.*)/);
        if (envMatch) {
          const envId = envMatch[1];
          const displayNote = envMatch[2];
          giftMsg = `${from} sent you a gift! Envelope #${envId}${displayNote ? ` "${displayNote}"` : ""}`;
        } else if (note) {
          giftMsg = `${from} sent you a gift "${note}"`;
        }
      }

      const messages: Record<string, string> = {
        payment: `${from} sent you a payment${note ? ` "${note}"` : ""}`,
        tip: `${from} tipped you${note ? ` "${note}"` : ""}`,
        request: `${from} requested money${note ? ` "${note}"` : ""}`,
        request_fulfilled: `${from} paid your request`,
        request_cancelled: `${from} cancelled a payment request`,
        invoice_created: `New invoice from ${from}${note ? `: ${note}` : ""}`,
        invoice_paid: `${from} paid your invoice`,
        payroll: `${from} sent payroll`,
        escrow_created: `${from} created an escrow${note ? `: ${note}` : ""}`,
        escrow_released: `Escrow funds released from ${from}`,
        escrow_expired: `Escrow from ${from} expired`,
        escrow_resolved: `Escrow dispute resolved by ${from}`,
        group_expense: `New group expense from ${from}`,
        group_settle: `${from} settled a group debt`,
        shield: `${from} shielded tokens`,
        gift_created: giftMsg,
        gift_claimed: `${from} opened a gift envelope`,
        debt_settled: `${from} settled a group debt`,
      };
      return messages[activityType] || `Activity from ${from}`;
    }

    // ─── Realtime handler (shared by both channels) ───────────────
    function handleActivityInsert(payload: { new: Record<string, unknown> }) {
      const row = payload.new as {
        tx_hash: string;
        user_from: string;
        user_to: string;
        activity_type: string;
        note: string;
      };
      if (notified.current.has(row.tx_hash)) return;
      addToCappedSet(notified.current, row.tx_hash);

      // Only show toast when user is the recipient (not for own sends)
      if (row.user_to !== addr || row.user_from === addr) return;

      const from = `${row.user_from.slice(0, 6)}...${row.user_from.slice(-4)}`;
      toast(formatActivityMessage(row.activity_type, from, row.note), {
        icon: row.activity_type === "payment" || row.activity_type === "tip" ? "\uD83D\uDCB0" : "\uD83D\uDCEC",
        duration: 5000,
      });
    }

    // ─── FIX 2: Subscribe to BOTH directions for activity feed ────
    // Channel 1: activities where user is the recipient
    const activityIncomingChannel = supabase
      .channel(`notify_activity_incoming_${addr}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activities", filter: `user_to=eq.${addr}` },
        handleActivityInsert
      )
      .subscribe();

    // Channel 2: activities where user is the sender (so own feed updates)
    const activityOutgoingChannel = supabase
      .channel(`notify_activity_outgoing_${addr}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activities", filter: `user_from=eq.${addr}` },
        handleActivityInsert
      )
      .subscribe();

    // ─── Payment request notifications ──────────────────────────
    const requestChannel = supabase
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

    // ─── Invoice notifications ──────────────────────────────────
    const invoiceChannel = supabase
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

    // Group expense notifications are NOT subscribed here.
    // They arrive via the activities table (filtered by user_to per member),
    // which avoids spamming all users with unrelated group expenses.

    return () => {
      supabase!.removeChannel(activityIncomingChannel);
      supabase!.removeChannel(activityOutgoingChannel);
      supabase!.removeChannel(requestChannel);
      supabase!.removeChannel(invoiceChannel);
    };
  }, [address]);
}
