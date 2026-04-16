import { useEffect, useState } from "react";

/**
 * Polls `/api/health` to report service availability for the app shell.
 *
 * Used by `<ServiceHealthBanner>` and any screen that wants to gate behavior
 * (e.g. disable Shield button if Fhenix TN is down). Graceful-degradation
 * primitive — we don't hide features, we tell the user what's happening.
 *
 * Poll interval is intentionally slow (90s). For tighter feedback on a
 * specific action, components should do their own targeted probe (e.g.
 * before submitting, check `fhenixReachable` and show the banner if not).
 */

export interface ServiceHealth {
  agentsReachable: boolean;
  relayReachable: boolean;
  fhenixReachable: boolean;
  supabaseReachable: boolean;
  /** true while the initial fetch is in flight; UI can skeleton. */
  loading: boolean;
  /** The raw /api/health payload for debugging. */
  raw?: Record<string, unknown>;
}

const POLL_MS = 90_000;

const DEFAULT_HEALTH: ServiceHealth = {
  agentsReachable: true,
  relayReachable: true,
  fhenixReachable: true,
  supabaseReachable: true,
  loading: true,
};

export function useServiceHealth(): ServiceHealth {
  const [health, setHealth] = useState<ServiceHealth>(DEFAULT_HEALTH);

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await fetch("/api/health", {
          signal: AbortSignal.timeout(5_000),
        });
        const body: Record<string, unknown> = await res.json().catch(() => ({}));
        if (cancelled) return;

        const derived = (body.derived as Record<string, unknown> | undefined) ?? {};
        setHealth({
          agentsReachable: derived.agentsReachable !== false,
          relayReachable: derived.relayReachable !== false,
          fhenixReachable: derived.fhenixReachable !== false,
          // Supabase reachability isn't probed server-side yet; leave true
          // unless we observe client-side failures via window online event.
          supabaseReachable: typeof navigator === "undefined" ? true : navigator.onLine,
          loading: false,
          raw: body,
        });
      } catch {
        if (cancelled) return;
        // `/api/health` unreachable → probably offline or Vercel fn cold-start
        // exceeded timeout. Don't flip ALL services to down — just be honest
        // that we can't know, leave previous state, flip loading off.
        setHealth((h) => ({ ...h, loading: false }));
      }
    };

    void probe();
    const id = setInterval(probe, POLL_MS);

    const onOnline = () => setHealth((h) => ({ ...h, supabaseReachable: true }));
    const onOffline = () => setHealth((h) => ({ ...h, supabaseReachable: false }));
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
    }

    return () => {
      cancelled = true;
      clearInterval(id);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
    };
  }, []);

  return health;
}
