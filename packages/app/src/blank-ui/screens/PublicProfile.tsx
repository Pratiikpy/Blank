import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Send, ExternalLink, AlertOctagon } from "lucide-react";

import { useChain } from "@/providers/ChainProvider";
import { useHandleResolver, type HandleRecord } from "@/hooks/useHandleResolver";

const ZERO = "0x0000000000000000000000000000000000000000";

function chainSuffix(name: string): string {
  if (name.toLowerCase().includes("base")) return "base";
  if (name.toLowerCase().includes("ethereum")) return "eth";
  return name.toLowerCase().slice(0, 4);
}

export default function PublicProfile() {
  const { handle: rawHandle } = useParams<{ handle: string }>();
  const { activeChain } = useChain();
  const { deploy, lookup } = useHandleResolver();

  const cleanHandle = useMemo(() => (rawHandle ?? "").replace(/^@/, ""), [rawHandle]);
  const [record, setRecord] = useState<HandleRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    lookup(cleanHandle).then((r) => {
      if (!cancelled) {
        setRecord(r);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [lookup, cleanHandle]);

  const suffix = chainSuffix(activeChain.name);

  if (deploy.status !== "live") {
    return <Shell>
      <Banner kind="amber">
        <strong>Handles not yet live on {activeChain.name}.</strong>{" "}
        Operator must run the deploy-blank-handles task.
      </Banner>
    </Shell>;
  }

  if (loading) {
    return <Shell><div className="text-[var(--text-secondary)]">Loading…</div></Shell>;
  }

  if (!record || record.owner === ZERO) {
    return (
      <Shell>
        <Banner kind="amber">
          <strong>No one owns @{cleanHandle}.{suffix} on this chain.</strong>{" "}
          Reserve it from Settings if it's still available.
        </Banner>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-6">
        <h1 className="text-3xl font-heading font-semibold mb-1">
          <span className="text-[var(--text-secondary)]">@</span>{cleanHandle}
          <span className="text-[var(--text-secondary)] text-base font-normal ml-1">.{suffix}</span>
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Public profile on {activeChain.name}.
        </p>
      </header>

      <div className="glass-card-static rounded-2xl p-6 mb-6 space-y-3">
        <Row label="Owner">
          <code data-testid="profile-owner" className="font-mono text-xs break-all">{record.owner}</code>
        </Row>
        <Row label="Reserved">
          {new Date(Number(record.createdAt) * 1000).toLocaleDateString()}
        </Row>
        <Row label="Last activity">
          {new Date(Number(record.lastActivityAt) * 1000).toLocaleDateString()}
        </Row>
        {record.ensRecord && record.ensRecord !== ("0x" + "00".repeat(32)) && (
          <Row label="ENS fallback">
            <code className="font-mono text-xs break-all">{record.ensRecord}</code>
          </Row>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Link
          to={`/app/send?to=${record.owner}`}
          data-testid="profile-send-cta"
          className="inline-flex items-center gap-2 h-12 px-6 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black"
        >
          <Send size={16} /> Send to @{cleanHandle}
        </Link>
        <a
          href={`${activeChain.explorerUrl}/address/${record.owner}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          View on explorer <ExternalLink size={12} />
        </a>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F9FAFB] py-10 px-4">
      <div className="max-w-xl mx-auto">
        <Link to="/app/wallet" className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] mb-6 hover:text-[var(--text-primary)]">
          <ArrowLeft size={14} /> Back
        </Link>
        {children}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-[var(--text-secondary)] shrink-0">{label}</span>
      <span className="text-sm text-right">{children}</span>
    </div>
  );
}

function Banner({ kind, children }: { kind: "amber"; children: React.ReactNode }) {
  const tone = kind === "amber" ? "border-amber-500/30 bg-amber-500/5 text-amber-700" : "";
  return (
    <div className={`rounded-2xl border px-4 py-3 flex items-start gap-3 ${tone}`}>
      <AlertOctagon size={18} className="shrink-0 mt-0.5" />
      <div className="text-sm">{children}</div>
    </div>
  );
}
