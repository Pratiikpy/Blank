import { useEffect, useState } from "react";
import { CheckCircle, AlertTriangle, AlertOctagon, RefreshCw, ExternalLink } from "lucide-react";

// Public read-only status page at /status.
//
// Surfaces:
//   - Per-chain RPC liveness (block number latency)
//   - Paymaster EntryPoint deposit with warn/page thresholds
//   - Relayer hot-wallet ETH balance
//   - Fhenix CoFHE network probe (encrypt + verifier + threshold)
//   - Last-deployed commit SHA + branch + env
//
// Refreshes every 30s in the background. The page is meant to be left
// open in a tab; honest "stale" state if the fetch fails so users see a
// real signal.

interface StatusResponse {
  status: "ok" | "warn" | "page";
  chains: Array<{
    chainId: number;
    label: string;
    rpc: { ok: boolean; blockNumber?: number; error?: string };
    paymaster: { ok: boolean; balanceEth?: string; level?: "ok" | "warn" | "page"; address?: string; error?: string } | null;
    relayer: { ok: boolean; balanceEth?: string; level?: "ok" | "warn" | "page"; address?: string; error?: string } | null;
  }>;
  fhenix: {
    reachable: boolean;
    cofhe: { ok: boolean; status?: number; error?: string };
    verifier: { ok: boolean; status?: number; error?: string };
    thresholdNetwork: { ok: boolean; status?: number; error?: string };
  };
  deploy: {
    sha: string | null;
    branch: string | null;
    env: string;
    region: string | null;
  };
  thresholds: {
    paymasterWarnEth: string;
    paymasterPageEth: string;
    relayerWarnEth: string;
    relayerPageEth: string;
  };
  timestamp: string;
}

function levelIcon(level: "ok" | "warn" | "page" | undefined, size = 16) {
  if (level === "page") return <AlertOctagon size={size} className="text-rose-600" />;
  if (level === "warn") return <AlertTriangle size={size} className="text-amber-600" />;
  return <CheckCircle size={size} className="text-emerald-600" />;
}

function overallBanner(s: StatusResponse["status"]) {
  if (s === "page") {
    return {
      icon: <AlertOctagon size={20} className="text-rose-600" />,
      label: "Operating with degraded capacity",
      tone: "border-rose-500/30 bg-rose-500/5 text-rose-700",
    };
  }
  if (s === "warn") {
    return {
      icon: <AlertTriangle size={20} className="text-amber-600" />,
      label: "Minor degradation",
      tone: "border-amber-500/30 bg-amber-500/5 text-amber-700",
    };
  }
  return {
    icon: <CheckCircle size={20} className="text-emerald-600" />,
    label: "All systems normal",
    tone: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700",
  };
}

const FETCH_INTERVAL_MS = 30_000;

export default function Status() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [staleSince, setStaleSince] = useState<Date | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/health?kind=status", { cache: "no-store" });
      if (!res.ok) throw new Error(`/api/health?kind=status ${res.status}`);
      const json = (await res.json()) as StatusResponse;
      setData(json);
      setError(null);
      setStaleSince(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (!staleSince) setStaleSince(new Date());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = window.setInterval(load, FETCH_INTERVAL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-[#F9FAFB] flex items-center justify-center">
        <div className="text-[var(--text-secondary)]">Loading status…</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#F9FAFB] flex items-center justify-center">
        <div className="max-w-md text-center">
          <AlertOctagon size={32} className="text-rose-600 mx-auto mb-3" />
          <h1 className="text-xl font-semibold mb-2">Status endpoint unreachable</h1>
          <p className="text-sm text-[var(--text-secondary)]">{error ?? "Unknown error"}</p>
        </div>
      </div>
    );
  }

  const banner = overallBanner(data.status);

  return (
    <div className="min-h-screen bg-[#F9FAFB] py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-heading font-semibold mb-2">Blank status</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Live testnet health for Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia. Refreshes every 30 seconds.
          </p>
        </header>

        <div className={`rounded-2xl border ${banner.tone} px-6 py-4 mb-8 flex items-center gap-3`}>
          {banner.icon}
          <div className="flex-1">
            <div className="font-medium">{banner.label}</div>
            <div className="text-xs opacity-80 mt-0.5">
              Last checked {new Date(data.timestamp).toLocaleTimeString()}
              {staleSince && ` · stale since ${staleSince.toLocaleTimeString()}`}
            </div>
          </div>
          <button
            onClick={load}
            className="p-2 rounded-xl hover:bg-white/40 transition-colors"
            aria-label="Refresh"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Per-chain panels */}
        <section className="space-y-4 mb-8">
          <h2 className="text-lg font-semibold">Chains</h2>
          {data.chains.map((c) => (
            <div key={c.chainId} className="glass-card-static rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium">{c.label}</h3>
                <div className="text-xs text-[var(--text-secondary)] font-mono">{c.chainId}</div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <div className="rounded-xl bg-white/60 px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    {c.rpc.ok ? <CheckCircle size={14} className="text-emerald-600" /> : <AlertOctagon size={14} className="text-rose-600" />}
                    <span className="text-xs text-[var(--text-secondary)]">RPC</span>
                  </div>
                  {c.rpc.ok ? (
                    <div className="text-sm">Block {c.rpc.blockNumber?.toLocaleString()}</div>
                  ) : (
                    <div className="text-xs text-rose-600 break-words">{c.rpc.error}</div>
                  )}
                </div>

                <div className="rounded-xl bg-white/60 px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    {levelIcon(c.paymaster?.level, 14)}
                    <span className="text-xs text-[var(--text-secondary)]">Paymaster</span>
                  </div>
                  {c.paymaster?.ok ? (
                    <div className="text-sm tabular-nums">{c.paymaster.balanceEth} ETH</div>
                  ) : c.paymaster?.error ? (
                    <div className="text-xs text-rose-600 break-words">{c.paymaster.error}</div>
                  ) : (
                    <div className="text-xs text-[var(--text-secondary)]">unavailable</div>
                  )}
                </div>

                <div className="rounded-xl bg-white/60 px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    {levelIcon(c.relayer?.level, 14)}
                    <span className="text-xs text-[var(--text-secondary)]">Relayer</span>
                  </div>
                  {c.relayer?.ok ? (
                    <div className="text-sm tabular-nums">{c.relayer.balanceEth} ETH</div>
                  ) : c.relayer?.error ? (
                    <div className="text-xs text-rose-600 break-words">{c.relayer.error}</div>
                  ) : (
                    <div className="text-xs text-[var(--text-secondary)]">not configured</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>

        {/* FHE network */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Fhenix CoFHE network</h2>
          <div className="glass-card-static rounded-2xl p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              {[
                { label: "Encrypt", probe: data.fhenix.cofhe },
                { label: "Verifier", probe: data.fhenix.verifier },
                { label: "Threshold network", probe: data.fhenix.thresholdNetwork },
              ].map((row) => (
                <div key={row.label} className="rounded-xl bg-white/60 px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    {row.probe.ok ? <CheckCircle size={14} className="text-emerald-600" /> : <AlertOctagon size={14} className="text-rose-600" />}
                    <span className="text-xs text-[var(--text-secondary)]">{row.label}</span>
                  </div>
                  {row.probe.ok ? (
                    <div className="text-sm">Reachable</div>
                  ) : (
                    <div className="text-xs text-rose-600 break-words">{row.probe.error}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Deploy info */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Deploy</h2>
          <div className="glass-card-static rounded-2xl p-6 text-sm grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <div className="text-xs text-[var(--text-secondary)] mb-1">Environment</div>
              <div className="font-medium">{data.deploy.env}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-secondary)] mb-1">Region</div>
              <div className="font-medium">{data.deploy.region ?? "-"}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-secondary)] mb-1">Branch</div>
              <div className="font-medium">{data.deploy.branch ?? "-"}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-secondary)] mb-1">Commit</div>
              {data.deploy.sha ? (
                <a
                  href={`https://github.com/Pratiikpy/Blank/commit/${data.deploy.sha}`}
                  className="font-mono text-xs inline-flex items-center gap-1 hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {data.deploy.sha.slice(0, 7)} <ExternalLink size={11} />
                </a>
              ) : (
                <div className="font-medium">-</div>
              )}
            </div>
          </div>
        </section>

        {/* Thresholds */}
        <section className="mb-12">
          <h2 className="text-lg font-semibold mb-3">Thresholds</h2>
          <div className="glass-card-static rounded-2xl p-6 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-[var(--text-secondary)] mb-1">Paymaster</div>
                <div className="text-amber-600">Warn at {data.thresholds.paymasterWarnEth} ETH</div>
                <div className="text-rose-600">Page at {data.thresholds.paymasterPageEth} ETH</div>
              </div>
              <div>
                <div className="text-xs text-[var(--text-secondary)] mb-1">Relayer</div>
                <div className="text-amber-600">Warn at {data.thresholds.relayerWarnEth} ETH</div>
                <div className="text-rose-600">Page at {data.thresholds.relayerPageEth} ETH</div>
              </div>
            </div>
          </div>
        </section>

        <footer className="text-xs text-[var(--text-secondary)] text-center pb-8">
          Live data from <code>/api/health?kind=status</code>.
        </footer>
      </div>
    </div>
  );
}
