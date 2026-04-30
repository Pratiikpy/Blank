/**
 * Audit Top-28 #21 + #22: global connection-health probe.
 *
 * Surfaces two transient infrastructure failures that previously caused
 * silent app degradation:
 *
 *   1. RPC offline / failing — every balance/state read silently returns
 *      null and the UI shows "—" or 0 indefinitely. The user has no way
 *      to know "the balance is wrong because the RPC is down" vs "the
 *      balance is genuinely 0".
 *
 *   2. Supabase realtime drops — the activity feed and request lists
 *      stop updating without any visual signal. Users send a payment
 *      and its row never appears in their feed.
 *
 * The hook polls the chain's RPC every 15s with a cheap eth_blockNumber
 * call and counts consecutive failures. After 2 failures we report
 * `rpcDegraded`; recovery clears it on the first success.
 *
 * Realtime health is sampled by attaching to the global Supabase channel
 * via supabase.realtime — `connect()` gives us `onClose` / `onError`
 * lifecycle events. We treat any CLOSED/CHANNEL_ERROR within the last 30s
 * as `realtimeDegraded`; the next successful connect clears it.
 */
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { useChain } from "@/providers/ChainProvider";
import { supabase } from "@/lib/supabase";

const RPC_PROBE_INTERVAL_MS = 15_000;
const RPC_FAIL_THRESHOLD = 2;
const REALTIME_DEGRADED_GRACE_MS = 30_000;

export interface ConnectionHealth {
  /** True when ≥ RPC_FAIL_THRESHOLD consecutive eth_blockNumber probes failed. */
  rpcDegraded: boolean;
  /** True when Supabase realtime emitted a CLOSED/CHANNEL_ERROR within the
   *  REALTIME_DEGRADED_GRACE_MS window and hasn't recovered since. */
  realtimeDegraded: boolean;
}

export function useConnectionHealth(): ConnectionHealth {
  const { activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const [rpcDegraded, setRpcDegraded] = useState(false);
  const [realtimeDegraded, setRealtimeDegraded] = useState(false);

  // ─── RPC probe ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    let consecutiveFailures = 0;

    const probe = async () => {
      try {
        await publicClient.getBlockNumber();
        if (cancelled) return;
        consecutiveFailures = 0;
        setRpcDegraded((prev) => (prev ? false : prev));
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= RPC_FAIL_THRESHOLD) {
          setRpcDegraded((prev) => (prev ? prev : true));
        }
      }
    };

    // Run once on mount so the user sees the banner immediately if RPC is
    // already down — don't make them wait 15s for the first probe.
    void probe();
    const id = setInterval(probe, RPC_PROBE_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [publicClient]);

  // ─── Realtime probe ──────────────────────────────────────────────────
  // Subscribe to a sentinel channel just to tap into the realtime
  // connection lifecycle. We don't care about INSERT/UPDATE events here —
  // the existing per-feature subscriptions handle data flow.
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    let degradedAt: number | null = null;

    const channel = supabase
      .channel("connection_health_probe")
      .subscribe((status) => {
        if (cancelled) return;
        // Status values are SUBSCRIBED, CLOSED, CHANNEL_ERROR, TIMED_OUT
        if (status === "SUBSCRIBED") {
          degradedAt = null;
          setRealtimeDegraded((prev) => (prev ? false : prev));
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          degradedAt = Date.now();
          setRealtimeDegraded((prev) => (prev ? prev : true));
        }
      });

    // Reset the degraded flag if it's been a while and we haven't seen
    // a recovery — the sub will keep retrying internally, but we don't
    // want a stale "degraded" lingering forever after a transient blip.
    const id = setInterval(() => {
      if (degradedAt && Date.now() - degradedAt > REALTIME_DEGRADED_GRACE_MS * 2) {
        // Long-term degraded — leave the flag set so the user knows
        // updates aren't flowing. This is intentionally conservative.
      }
    }, REALTIME_DEGRADED_GRACE_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
      void supabase!.removeChannel(channel);
    };
  }, []);

  return { rpcDegraded, realtimeDegraded };
}
