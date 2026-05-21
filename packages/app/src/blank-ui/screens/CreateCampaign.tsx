// Wave 4 task #257 — Create Campaign screen.

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  Megaphone, Copy, Check, AlertCircle, RefreshCw, Loader2, Clock, CheckCircle2, XCircle,
} from "lucide-react";
import toast from "react-hot-toast";
import { keccak256, stringToBytes } from "viem";

import { useCrowdfund } from "@/hooks/useCrowdfund";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { cn } from "@/lib/cn";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";

const STATUS_CLOSED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDING = 3;

interface CreatorCampaign {
  id: bigint;
  deadline: bigint;
  status: number;
  goalMet: boolean;
  resultPublished: boolean;
  title: string;
  createdAt: bigint;
}

const DURATIONS: Array<{ label: string; seconds: number }> = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];

export default function CreateCampaign() {
  const { contracts, activeChainId } = useChain();
  const { effectiveAddress } = useEffectiveAddress();
  const {
    state, pipeline, createCampaign, closeCampaign, fetchCreatorCampaigns, fetchCampaign, reset,
  } = useCrowdfund();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [goal, setGoal] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(DURATIONS[1].seconds);

  const validation = useMemo(() => {
    if (title.trim().length === 0) return "Title required";
    if (!goal || Number.parseFloat(goal) <= 0) return "Set a goal above zero";
    return null;
  }, [title, goal]);

  const handleCreate = async () => {
    if (validation) { toast.error(validation); return; }
    const descCidHash = description.trim()
      ? keccak256(stringToBytes(description.trim()))
      : (("0x" + "00".repeat(32)) as `0x${string}`);
    await createCampaign({
      vault: contracts.FHERC20Vault_USDC,
      goalTokens: goal,
      decimals: 6,
      durationSeconds,
      title: title.trim(),
      descriptionCidHash: descCidHash,
    });
  };

  const shareUrl = state.lastCampaignId !== null
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/fund/${activeChainId}/${state.lastCampaignId}`
    : null;
  const copyUrl = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    toast.success("Link copied");
  };

  // §1.15 B4b — creator's own campaigns list + close action.
  const [creatorCampaigns, setCreatorCampaigns] = useState<CreatorCampaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [closingId, setClosingId] = useState<bigint | null>(null);
  const [campaignsRefreshedAt, setCampaignsRefreshedAt] = useState<number | null>(null);

  const refreshCreatorCampaigns = useCallback(async () => {
    if (!effectiveAddress) return;
    setLoadingCampaigns(true);
    try {
      const ids = await fetchCreatorCampaigns(effectiveAddress as `0x${string}`);
      const records = await Promise.all(ids.map((id) => fetchCampaign(id)));
      const filtered = records
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .map((r) => ({
          id: r.id,
          deadline: r.deadline,
          status: r.status,
          goalMet: r.goalMet,
          resultPublished: r.resultPublished,
          title: r.title,
          createdAt: r.createdAt,
      }));
      filtered.sort((a, b) => Number(b.createdAt - a.createdAt));
      setCreatorCampaigns(filtered);
      setCampaignsRefreshedAt(Date.now());
    } finally {
      setLoadingCampaigns(false);
    }
  }, [effectiveAddress, fetchCreatorCampaigns, fetchCampaign]);

  useEffect(() => {
    refreshCreatorCampaigns();
  }, [refreshCreatorCampaigns]);

  useEffect(() => {
    if (state.step === "success") refreshCreatorCampaigns();
  }, [state.step, refreshCreatorCampaigns]);

  const handleClose = useCallback(
    async (campaignId: bigint) => {
      setClosingId(campaignId);
      try {
        const ok = await closeCampaign(Number(campaignId));
        if (ok) await refreshCreatorCampaigns();
      } finally {
        setClosingId(null);
      }
    },
    [closeCampaign, refreshCreatorCampaigns],
  );

  const copyCampaignUrl = useCallback(
    async (campaignId: bigint) => {
      const url = `${window.location.origin}/fund/${activeChainId}/${campaignId.toString()}`;
      await navigator.clipboard.writeText(url);
      toast.success("Campaign URL copied");
    },
    [activeChainId],
  );

  if (state.step === "success" && shareUrl) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="glass-card-static rounded-[2rem] p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-6">
            <Check size={32} className="text-emerald-600" />
          </div>
          <h2 className="text-2xl font-heading font-semibold mb-3">Campaign live</h2>
          <p className="text-[var(--text-secondary)] mb-6">
            Share this link. Contributions stay encrypted. If the goal isn't met, contributors get refunded.
          </p>
          <div className="bg-[var(--surface-2)] rounded-2xl p-4 mb-4 break-all text-sm font-mono text-left">
            {shareUrl}
          </div>
          <button
            onClick={copyUrl}
            className="inline-flex items-center gap-2 px-6 h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black"
          >
            <Copy size={18} /> Copy link
          </button>
          <button
            onClick={() => { reset(); setTitle(""); setGoal(""); setDescription(""); }}
            className="block mt-6 mx-auto text-sm underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Create another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto">
      <div className="glass-card-static rounded-[2rem] p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-xl bg-violet-50 flex items-center justify-center">
            <Megaphone size={24} className="text-violet-600" />
          </div>
          <div>
            <h1 className="text-xl font-heading font-semibold">Launch a private campaign</h1>
            <p className="text-sm text-[var(--text-secondary)]">Encrypted goal. Encrypted contributions. Refund-on-miss.</p>
          </div>
        </div>

        <Field label="Campaign title" value={title} onChange={setTitle} placeholder="Save the bees fund" />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="What you're raising for. Why people should chip in."
          multiline
        />
        <Field
          label="Funding goal (USDC)"
          value={goal}
          onChange={(v) => setGoal(v.replace(/[^0-9.]/g, ""))}
          placeholder="500.00"
        />

        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Duration</label>
          <div className="grid grid-cols-3 gap-2">
            {DURATIONS.map((opt) => (
              <button
                key={opt.seconds}
                onClick={() => setDurationSeconds(opt.seconds)}
                aria-pressed={durationSeconds === opt.seconds}
                className={cn(
                  "h-12 rounded-xl border-2 text-sm font-medium transition-all",
                  durationSeconds === opt.seconds
                    ? "bg-[#1D1D1F] border-[#1D1D1F] text-white shadow-sm"
                    : "bg-white border-black/10 text-[var(--text-primary)] hover:border-black/30 hover:bg-black/[0.02]",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {pipeline.phase !== "idle" && (
          <div className="mb-4">
            <FhePipelineProgress state={pipeline} />
          </div>
        )}
        {state.error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 text-red-700 flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{state.error}</span>
          </div>
        )}

        {validation && !state.isProcessing && (
          <p className="text-xs text-[var(--text-secondary)] mb-2 text-center">{validation}</p>
        )}
        <button
          onClick={handleCreate}
          disabled={state.isProcessing || !!validation}
          className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
        >
          {state.isProcessing ? "Creating…" : "Launch campaign"}
        </button>
      </div>

      {/* §1.15 B4b — Your campaigns. */}
      {effectiveAddress && (
        <div className="glass-card-static rounded-[2rem] p-6 sm:p-8 mt-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-lg font-heading font-semibold">Your campaigns</h2>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                On-chain campaign state. Copy the public URL, close after deadline, then release or refund from the public page.
              </p>
              {campaignsRefreshedAt && (
                <p className="text-[11px] text-[var(--text-tertiary)] mt-1">
                  Checked {new Date(campaignsRefreshedAt).toLocaleTimeString()}.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={refreshCreatorCampaigns}
              disabled={loadingCampaigns}
              className="h-9 px-3 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] text-xs flex items-center gap-1.5 disabled:opacity-50"
              aria-label="Refresh your campaigns"
            >
              <RefreshCw size={11} className={loadingCampaigns ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {loadingCampaigns && creatorCampaigns.length === 0 ? (
            <div className="text-center py-6 text-[var(--text-secondary)] text-sm">
              <Loader2 size={20} className="animate-spin inline mr-2 opacity-60" />
              Loading…
            </div>
          ) : creatorCampaigns.length === 0 ? (
            <div className="text-center py-8 text-[var(--text-tertiary)] text-sm">
              <Megaphone size={28} className="mx-auto mb-2 opacity-30" />
              <p>You haven't launched any campaigns yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {creatorCampaigns.map((c) => {
                const past = Number(c.deadline) * 1000 < Date.now();
                const phase =
                  c.status === STATUS_RELEASED || (c.resultPublished && c.goalMet)
                    ? "released"
                    : c.status === STATUS_REFUNDING || (c.resultPublished && !c.goalMet)
                      ? "refunding"
                      : c.status === STATUS_CLOSED && !c.resultPublished
                        ? "awaiting"
                        : past
                          ? "needs close"
                          : "open";
                const phaseIcon = {
                  open: <Clock size={10} />,
                  "needs close": <Clock size={10} />,
                  awaiting: <Clock size={10} />,
                  released: <CheckCircle2 size={10} />,
                  refunding: <XCircle size={10} />,
                }[phase];
                const phaseColor = {
                  open: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
                  "needs close": "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
                  awaiting: "bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-300",
                  released: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                  refunding: "bg-slate-100 text-slate-700 dark:bg-slate-500/10 dark:text-slate-300",
                }[phase];
                return (
                  <div
                    key={c.id.toString()}
                    className="rounded-2xl bg-white/50 dark:bg-white/[0.03] border border-black/5 dark:border-white/5 p-4 flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs text-[var(--text-tertiary)]">
                          #{c.id.toString()}
                        </span>
                        <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide flex items-center gap-1", phaseColor)}>
                          {phaseIcon} {phase}
                        </span>
                      </div>
                      <p className="text-sm text-[var(--text-primary)] truncate">{c.title}</p>
                      <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                        Deadline {new Date(Number(c.deadline) * 1000).toLocaleDateString()}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)] mt-1">
                        {phase === "open" && "Accepting encrypted contributions."}
                        {phase === "needs close" && "Deadline passed. Close to request the encrypted goal verdict."}
                        {phase === "awaiting" && "Close submitted. Waiting for the goal verdict to be published."}
                        {phase === "released" && "Goal met. Creator release path is complete."}
                        {phase === "refunding" && "Goal missed. Contributors can claim refunds."}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => copyCampaignUrl(c.id)}
                        className="h-8 px-3 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] text-[11px] flex items-center gap-1.5"
                        aria-label={`Copy URL for campaign ${c.id}`}
                      >
                        <Copy size={10} /> Copy
                      </button>
                      {phase === "needs close" && (
                        <button
                          type="button"
                          onClick={() => handleClose(c.id)}
                          disabled={closingId === c.id}
                          className="h-8 px-3 rounded-lg bg-[#1D1D1F] hover:bg-black text-white text-[11px] flex items-center gap-1.5 disabled:opacity-50"
                          aria-label={`Close campaign ${c.id}`}
                        >
                          {closingId === c.id ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            <Clock size={10} />
                          )}
                          Close
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  const cls = cn(
    "w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-base focus:border-[var(--border-strong)] focus:outline-none transition-colors",
    props.multiline ? "py-3 min-h-[96px] resize-y" : "h-12",
  );
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium mb-2">{props.label}</label>
      {props.multiline
        ? <textarea value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder={props.placeholder} className={cls} />
        : <input type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder={props.placeholder} className={cls} />}
    </div>
  );
}
