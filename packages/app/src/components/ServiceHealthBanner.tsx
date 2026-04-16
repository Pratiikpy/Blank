import { AlertTriangle, WifiOff } from "lucide-react";
import { useServiceHealth } from "@/hooks/useServiceHealth";

/**
 * Sticky banner that appears ONLY when a dependency is degraded.
 *
 * Graceful-degradation principle: the app still tries every action; if the
 * network is down it surfaces the reason so the user doesn't blame us or
 * keep retrying blindly. Never blocks the UI — just informs.
 *
 * Order of checks:
 *   1. Offline (navigator.onLine = false) — most likely cause, biggest impact
 *   2. Fhenix TN / verifier / cofhe unreachable — FHE flows will fail
 *   3. Relayer / agents unreachable — smart-wallet + AI flows will fail
 *
 * Only shows the HIGHEST-PRIORITY issue to keep UI calm. If everything is
 * green, renders nothing.
 */
export function ServiceHealthBanner() {
  const h = useServiceHealth();
  if (h.loading) return null;

  if (!h.supabaseReachable) {
    return (
      <Banner
        tone="offline"
        icon={<WifiOff size={14} />}
        title="You're offline"
        body="Activities won't sync until you reconnect. Actions in flight will retry."
      />
    );
  }
  if (!h.fhenixReachable) {
    return (
      <Banner
        tone="warn"
        icon={<AlertTriangle size={14} />}
        title="FHE network degraded"
        body="Shield / unshield / stealth claim may hang. Try again in a minute."
      />
    );
  }
  if (!h.relayReachable) {
    return (
      <Banner
        tone="warn"
        icon={<AlertTriangle size={14} />}
        title="Smart-wallet relay unavailable"
        body="You can still use the app with a connected wallet (MetaMask / WalletConnect)."
      />
    );
  }
  if (!h.agentsReachable) {
    return (
      <Banner
        tone="warn"
        icon={<AlertTriangle size={14} />}
        title="AI agents unavailable"
        body="Agent-derived payments disabled. Other features unaffected."
      />
    );
  }
  return null;
}

function Banner({
  tone,
  icon,
  title,
  body,
}: {
  tone: "warn" | "offline";
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  const toneClasses =
    tone === "offline"
      ? "bg-gray-100 text-gray-900 border-gray-200 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700"
      : "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-500/30";
  return (
    <div
      role="status"
      className={`sticky top-0 z-[95] border-b px-4 py-2 text-xs ${toneClasses}`}
    >
      <div className="max-w-7xl mx-auto flex items-center gap-2">
        {icon}
        <span className="font-medium">{title}</span>
        <span className="opacity-70">· {body}</span>
      </div>
    </div>
  );
}
