// Wave 4 task #257 — Create Campaign screen.

import { useState, useMemo } from "react";
import { Megaphone, Copy, Check, AlertCircle } from "lucide-react";
import toast from "react-hot-toast";
import { keccak256, stringToBytes } from "viem";

import { useCrowdfund } from "@/hooks/useCrowdfund";
import { useChain } from "@/providers/ChainProvider";
import { cn } from "@/lib/cn";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";

const DURATIONS: Array<{ label: string; seconds: number }> = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];

export default function CreateCampaign() {
  const { contracts, activeChainId } = useChain();
  const { state, pipeline, createCampaign, reset } = useCrowdfund();

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
