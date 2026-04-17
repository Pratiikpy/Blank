import { useState, useEffect, useCallback } from "react";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import {
  ShieldCheck,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Copy,
  ExternalLink,
  AlertCircle,
  Twitter,
} from "lucide-react";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";
import { useQualificationProof, type ProofRecord } from "@/hooks/useQualificationProof";
import { useChain } from "@/providers/ChainProvider";

// ───────────────────────────────────────────────────────────────────
//  Proofs — generate & manage encrypted "income ≥ X" proofs
//  Each proof is shareable as /verify/:proofId. Anyone can verify the
//  verdict on-chain WITHOUT learning the actual income amount.
// ───────────────────────────────────────────────────────────────────

const PRESET_THRESHOLDS = [1_000, 10_000, 50_000, 100_000];

export default function Proofs() {
  // Passkey-aware — passkey-only users have no wagmi address but still have
  // a smart-account address via useEffectiveAddress. Without this the page
  // showed "Connect your wallet" even when a passkey was fully set up.
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChain, activeChainId } = useChain();
  const { createIncomeProof, createBalanceProof, fetchProof, fetchProofsByUser, step, error, reset } =
    useQualificationProof();

  const [thresholdInput, setThresholdInput] = useState<string>("");
  const [proofKind, setProofKind] = useState<"income" | "balance">("income");
  const [proofIds, setProofIds] = useState<bigint[]>([]);
  const [proofs, setProofs] = useState<Record<string, ProofRecord>>({});
  const [loadingList, setLoadingList] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoadingList(true);
    const ids = await fetchProofsByUser();
    setProofIds(ids);
    const records: Record<string, ProofRecord> = {};
    for (const id of ids) {
      const p = await fetchProof(id);
      if (p) records[id.toString()] = p;
    }
    setProofs(records);
    setLoadingList(false);
  }, [address, fetchProofsByUser, fetchProof]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-poll while any proof is still pending (not yet ready on-chain).
  // Handles reorg-safe updates + remote publishes without user action.
  useEffect(() => {
    const anyPending = Object.values(proofs).some((p) => !p.isReady);
    if (!anyPending) return;
    const id = setInterval(() => refresh(), 10_000);
    return () => clearInterval(id);
  }, [proofs, refresh]);

  const submitting = step === "creating";

  const handleCreate = useCallback(async () => {
    const value = parseFloat(thresholdInput);
    if (!Number.isFinite(value) || value < 0) {
      toast.error("Enter a positive threshold");
      return;
    }
    const id =
      proofKind === "income"
        ? await createIncomeProof(value)
        : await createBalanceProof(value);
    if (id !== null) {
      setThresholdInput("");
      reset();
      await refresh();
    }
  }, [thresholdInput, proofKind, createIncomeProof, createBalanceProof, reset, refresh]);

  const buildShareLink = (proofId: bigint) =>
    `${window.location.origin}/verify/${proofId.toString()}?chain=${activeChainId}`;

  const copyShareLink = (proofId: bigint) => {
    navigator.clipboard.writeText(buildShareLink(proofId));
    toast.success("Verification link copied");
  };

  // Build a Twitter/X intent URL for sharing a proof. The intent endpoint
  // pre-populates the compose box; users still confirm before posting.
  const buildTweetIntent = (proofId: bigint, threshold: bigint, isReady: boolean, isTrue: boolean) => {
    const thresholdUSD = Number(threshold) / 1_000_000;
    const link = buildShareLink(proofId);
    let text: string;
    if (!isReady) {
      text = `I just created an encrypted proof on @blank that my income is at least $${thresholdUSD.toLocaleString()} — without revealing the actual number.\n\nVerify it on-chain (anyone can): ${link}`;
    } else if (isTrue) {
      text = `Verified on-chain: my income is ≥ $${thresholdUSD.toLocaleString()}.\n\nThe blockchain saw the comparison run inside FHE. Nobody — not even @blank — knows the actual amount.\n\nVerify yourself: ${link}`;
    } else {
      text = `Verified on-chain via @blank: this proof of "income ≥ $${thresholdUSD.toLocaleString()}" is FALSE.\n\nNo amount was leaked — just the boolean answer. That's the whole point of FHE.\n\nVerify: ${link}`;
    }
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Encrypted Proofs
          </h1>
          <p className="text-sm sm:text-base text-[var(--text-primary)]/50 leading-relaxed max-w-2xl">
            Prove "my income is at least $X" — without revealing the actual amount.
            Your proof is an encrypted boolean. Anyone with the link can verify the
            answer on-chain; nobody learns your real income.
          </p>
        </div>

        {/* Create proof card */}
        <div className="glass-card-static rounded-[2rem] p-4 sm:p-8 mb-8">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <ShieldCheck size={22} />
            </div>
            <div>
              <h2 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                Create a new {proofKind} proof
              </h2>
              <p className="text-sm text-[var(--text-primary)]/50 mt-1">
                Threshold is public; your actual {proofKind} stays encrypted forever.
              </p>
            </div>
          </div>

          {/* Kind toggle */}
          <div className="flex items-center gap-2 mb-4 p-1 bg-black/[0.04] dark:bg-white/[0.04] rounded-2xl w-fit">
            <button
              type="button"
              onClick={() => setProofKind("income")}
              className={cn(
                "px-4 py-1.5 rounded-xl text-sm font-medium transition-colors",
                proofKind === "income"
                  ? "bg-white dark:bg-white/[0.1] text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              Income
            </button>
            <button
              type="button"
              onClick={() => setProofKind("balance")}
              className={cn(
                "px-4 py-1.5 rounded-xl text-sm font-medium transition-colors",
                proofKind === "balance"
                  ? "bg-white dark:bg-white/[0.1] text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              Balance
            </button>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={thresholdInput}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/^\d*\.?\d{0,2}$/.test(v) || v === "") setThresholdInput(v);
                }}
                placeholder="Threshold (e.g. 50,000)"
                aria-label="Income threshold in USD"
                disabled={submitting}
                className="h-14 w-full pl-8 pr-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg font-mono tabular-nums disabled:opacity-50"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={submitting || !thresholdInput || parseFloat(thresholdInput) < 0}
              className="h-14 px-7 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              aria-label="Create proof"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Creating...
                </>
              ) : (
                "Create proof"
              )}
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {PRESET_THRESHOLDS.map((preset) => (
              <button
                key={preset}
                onClick={() => setThresholdInput(String(preset))}
                disabled={submitting}
                className="text-xs font-medium px-3 py-1.5 rounded-full bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] transition-colors disabled:opacity-50"
              >
                ${preset.toLocaleString()}
              </button>
            ))}
          </div>

          {step === "error" && error && (
            <div className="mt-4 flex items-center gap-2 text-sm text-red-600">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* My proofs */}
        <div className="glass-card-static rounded-[2rem] p-4 sm:p-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-heading font-medium text-[var(--text-primary)]">
              Your proofs
            </h2>
            <button
              onClick={refresh}
              disabled={loadingList}
              className="text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              {loadingList ? "Loading..." : "Refresh"}
            </button>
          </div>

          {!address && (
            <div className="text-center py-10 text-[var(--text-tertiary)]">
              Connect your wallet to see your proofs.
            </div>
          )}

          {address && proofIds.length === 0 && !loadingList && (
            <div className="text-center py-10 text-[var(--text-tertiary)]">
              <ShieldCheck size={32} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">No proofs yet</p>
              <p className="text-sm mt-1">Create one above to get started.</p>
            </div>
          )}

          <div className="space-y-3">
            {proofIds.map((id) => {
              const p = proofs[id.toString()];
              if (!p) return null;
              const thresholdUSD = Number(p.threshold) / 1_000_000;
              const created = new Date(Number(p.timestamp) * 1000).toLocaleString();
              return (
                <div
                  key={id.toString()}
                  className="rounded-2xl bg-white/50 dark:bg-white/[0.03] border border-black/5 dark:border-white/5 p-4 sm:p-5"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <div
                        className={cn(
                          "w-10 h-10 rounded-xl flex items-center justify-center mt-0.5 shrink-0",
                          !p.isReady
                            ? "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
                            : p.isTrue
                              ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
                              : "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
                        )}
                      >
                        {!p.isReady ? (
                          <Clock size={18} />
                        ) : p.isTrue ? (
                          <CheckCircle2 size={18} />
                        ) : (
                          <XCircle size={18} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-[var(--text-primary)]">
                          Income ≥ ${thresholdUSD.toLocaleString()}
                        </p>
                        <p className="text-xs text-[var(--text-tertiary)] mt-0.5 font-mono break-all">
                          Proof #{id.toString()} · created {created}
                        </p>
                        <p className="text-xs mt-1.5">
                          {!p.isReady ? (
                            <span className="text-amber-600 dark:text-amber-400">
                              Pending verification — share the link to publish on-chain
                            </span>
                          ) : p.isTrue ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              ✓ Verified true — anyone can read this on-chain
                            </span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400">
                              ✗ Verified false — anyone can read this on-chain
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-row sm:flex-col flex-wrap gap-1.5 sm:shrink-0">
                      <a
                        href={buildTweetIntent(id, p.threshold, p.isReady, p.isTrue)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium px-3 py-2 rounded-lg bg-[#0f1419] hover:bg-black text-white transition-colors flex items-center gap-1.5"
                        aria-label="Share on X / Twitter"
                      >
                        <Twitter size={12} />
                        Share on X
                      </a>
                      <button
                        onClick={() => copyShareLink(id)}
                        className="text-xs font-medium px-3 py-2 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] transition-colors flex items-center gap-1.5"
                        aria-label="Copy verification link"
                      >
                        <Copy size={12} />
                        Copy link
                      </button>
                      <a
                        href={`${activeChain.explorerUrl}/block/${p.blockNumber}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium px-3 py-2 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] transition-colors flex items-center gap-1.5"
                        aria-label="View on explorer"
                      >
                        <ExternalLink size={12} />
                        Explorer
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
