import { AlertTriangle, WifiOff } from "lucide-react";
import { useConnectionHealth } from "@/hooks/useConnectionHealth";

/**
 * Audit Top-28 #21 + #22: surface RPC + Supabase realtime degradation.
 *
 * The banner only renders when at least one connection is degraded. It's
 * intentionally narrow — replacing the in-screen toast with a persistent
 * banner so users with stale balances or stale activity feeds see the
 * cause at a glance instead of guessing.
 */
export function ConnectionHealthBanner() {
  const { rpcDegraded, realtimeDegraded } = useConnectionHealth();
  if (!rpcDegraded && !realtimeDegraded) return null;

  // Two-fault state: combined message keeps the banner small.
  const both = rpcDegraded && realtimeDegraded;

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-2xl border border-amber-300/60 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-900/20 px-4 py-2.5 mb-4 flex items-center gap-2.5 text-sm text-amber-900 dark:text-amber-100"
    >
      {rpcDegraded ? (
        <WifiOff size={16} className="shrink-0 text-amber-700 dark:text-amber-300" />
      ) : (
        <AlertTriangle size={16} className="shrink-0 text-amber-700 dark:text-amber-300" />
      )}
      <span className="leading-tight">
        {both
          ? "Connection issues. Balances and live updates may be stale. Retrying…"
          : rpcDegraded
            ? "RPC connection unstable. On-chain reads may be stale. Retrying…"
            : "Live updates paused. Try refreshing if your activity feed looks stale."}
      </span>
    </div>
  );
}
