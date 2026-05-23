import { useMemo, useState } from "react";
import { Download, BarChart3, Users, Tag, AlertOctagon } from "lucide-react";

import { useEncryptedAnalytics, type MonthlyBucket } from "@/hooks/useEncryptedAnalytics";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";

// Wave 5 Block 4 — Encrypted analytics screen.
//
// Shows monthly event counts, top counterparties, category breakdown,
// CSV export. NO amount values are computed or shown — amounts stay
// encrypted on-chain. Honest privacy claim banner at the top tells
// the user exactly what is and isn't aggregated.

function shortAddr(a: string) {
  if (!a) return "—";
  if (a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function MonthBars({ months }: { months: MonthlyBucket[] }) {
  const max = useMemo(
    () => months.reduce((acc, m) => Math.max(acc, m.total), 1),
    [months],
  );
  if (months.length === 0) {
    return (
      <div className="text-sm text-[var(--text-secondary)]">
        No activity yet.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {months.slice(0, 12).map((m) => {
        const sentPct = (m.sent / max) * 100;
        const recvPct = (m.received / max) * 100;
        return (
          <div key={m.yyyymm} data-testid="insights-month-row">
            <div className="flex justify-between text-xs text-[var(--text-secondary)] mb-1">
              <span>{m.yearMonth}</span>
              <span className="tabular-nums">
                {m.sent} sent · {m.received} received
              </span>
            </div>
            <div className="flex h-3 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="bg-rose-400/80"
                style={{ width: `${sentPct}%` }}
                title={`Sent ${m.sent}`}
              />
              <div
                className="bg-emerald-400/80"
                style={{ width: `${recvPct}%` }}
                title={`Received ${m.received}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Insights() {
  const { effectiveAddress } = useEffectiveAddress();
  const { snapshot, csv, isLoading } = useEncryptedAnalytics();
  const [exporting, setExporting] = useState(false);

  const handleExport = () => {
    setExporting(true);
    try {
      const day = new Date().toISOString().slice(0, 10);
      downloadCsv(csv, `blank-insights-${day}.csv`);
    } finally {
      setExporting(false);
    }
  };

  if (!effectiveAddress) {
    return (
      <div className="min-h-screen bg-[#F9FAFB] py-10 px-4">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-heading font-semibold mb-2">Insights</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Connect a wallet to see your activity summary.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F9FAFB] py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-heading font-semibold mb-2">Insights</h1>
            <p className="text-sm text-[var(--text-secondary)] max-w-xl">
              Your activity at a glance. Amounts stay encrypted on-chain.
              These counts and counterparty groupings are computed
              locally from your activity feed.
            </p>
          </div>
          <button
            data-testid="insights-csv-export"
            onClick={handleExport}
            disabled={exporting || snapshot.totalEvents === 0}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40"
          >
            <Download size={16} /> CSV
          </button>
        </header>

        <div
          role="note"
          data-testid="insights-privacy-note"
          className="rounded-2xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 mb-6 text-sm text-[var(--text-primary)]/80"
        >
          <strong className="font-medium text-blue-700">Encrypted by design.</strong>{" "}
          Wave 5 v1 aggregates by event count, not by amount. Amounts
          live on-chain encrypted, decrypted only by your passkey-bound
          permit. Per-row amount decrypt + FHE-aggregated totals ship
          in a later wave.
        </div>

        {/* Summary cards */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
          <SummaryCard
            label="Total events"
            value={snapshot.totalEvents}
            icon={<BarChart3 size={16} className="text-slate-600" />}
            testId="insights-total"
          />
          <SummaryCard
            label="Sent"
            value={snapshot.sent}
            icon={<BarChart3 size={16} className="text-rose-600" />}
            tone="bg-rose-500/5"
            testId="insights-sent"
          />
          <SummaryCard
            label="Received"
            value={snapshot.received}
            icon={<BarChart3 size={16} className="text-emerald-600" />}
            tone="bg-emerald-500/5"
            testId="insights-received"
          />
        </section>

        {/* Monthly */}
        <section className="glass-card-static rounded-2xl p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 size={18} className="text-[var(--text-secondary)]" />
            <h2 className="text-lg font-semibold">Monthly activity</h2>
          </div>
          {isLoading && snapshot.monthly.length === 0 ? (
            <div className="text-sm text-[var(--text-secondary)]">Loading…</div>
          ) : (
            <MonthBars months={snapshot.monthly} />
          )}
        </section>

        {/* Counterparties */}
        <section className="glass-card-static rounded-2xl p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Users size={18} className="text-[var(--text-secondary)]" />
            <h2 className="text-lg font-semibold">Top counterparties</h2>
          </div>
          {snapshot.counterparties.length === 0 ? (
            <div className="text-sm text-[var(--text-secondary)]">
              No counterparties yet.
            </div>
          ) : (
            <div className="space-y-2">
              {snapshot.counterparties.slice(0, 10).map((cp) => (
                <div
                  key={cp.address}
                  data-testid="insights-counterparty-row"
                  className="flex items-center justify-between text-sm"
                >
                  <code className="font-mono text-xs">{shortAddr(cp.address)}</code>
                  <span className="text-[var(--text-secondary)] tabular-nums">
                    {cp.total} · sent to me {cp.isSender} · I sent {cp.isReceiver}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Categories */}
        <section className="glass-card-static rounded-2xl p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Tag size={18} className="text-[var(--text-secondary)]" />
            <h2 className="text-lg font-semibold">By category</h2>
          </div>
          {snapshot.categories.length === 0 ? (
            <div className="text-sm text-[var(--text-secondary)]">
              No categories yet.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {snapshot.categories.map((c) => (
                <div
                  key={c.category}
                  data-testid="insights-category-row"
                  className="flex items-center justify-between text-sm rounded-xl bg-white/60 px-3 py-2"
                >
                  <span>{c.category}</span>
                  <span className="text-[var(--text-secondary)] tabular-nums">{c.count}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {snapshot.totalEvents === 0 && (
          <div
            role="note"
            data-testid="insights-empty"
            className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 flex items-start gap-3"
          >
            <AlertOctagon size={16} className="shrink-0 mt-0.5" />
            <span>
              No activity captured yet. Send a payment or receive one,
              and the chart will populate after the activity feed
              syncs.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label, value, icon, tone, testId,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`glass-card-static rounded-2xl p-5 ${tone ?? ""}`.trim()}
    >
      <div className="flex items-center gap-2 mb-2 text-xs text-[var(--text-secondary)]">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
