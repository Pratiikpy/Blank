import { useState } from "react";
import {
  Sparkles,
  Send,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Briefcase,
  Receipt,
} from "lucide-react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { useAgentPayment, type AgentTemplate, type AgentAttestation } from "@/hooks/useAgentPayment";
import { ACTIVE_CHAIN } from "@/lib/constants";

// ──────────────────────────────────────────────────────────────────
//  AgentPayments — server-derived AI payment with on-chain provenance.
//
//  Two demos exposed:
//    - Smart payroll line: describe a role + region → agent derives salary
//    - AI expense split:   describe a receipt → agent derives the share
//
//  Flow on each: derive (preview) → user confirms recipient + note → submit.
// ──────────────────────────────────────────────────────────────────

interface TemplateDef {
  id: AgentTemplate;
  icon: React.ReactNode;
  title: string;
  blurb: string;
  placeholder: string;
  example: string;
}

const TEMPLATES: TemplateDef[] = [
  {
    id: "payroll_line",
    icon: <Briefcase size={18} />,
    title: "Smart payroll line",
    blurb: "Describe a role + region. Agent derives a fair monthly USDC salary, signs it, you encrypt + submit.",
    placeholder: "e.g. Senior full-stack engineer, San Francisco, 6 years experience, equity grant pending.",
    example: "Mid-level mobile engineer, Berlin, 4 years experience, Kotlin + Swift.",
  },
  {
    id: "expense_share",
    icon: <Receipt size={18} />,
    title: "AI expense split",
    blurb: "Paste a receipt + split context. Agent derives this person's share, signs it, you encrypt + submit.",
    placeholder: "e.g. Dinner $120 total. Me + Ada split food ($80), Bob had wine ($30), Cara just coffee ($10). My share?",
    example: "Lunch $48 split equally between 4 people. My share?",
  },
];

export default function AgentPayments() {
  const { address } = useAccount();
  const { step, error, lastAttestation, derive, submit, reset } = useAgentPayment();

  const [activeTemplate, setActiveTemplate] = useState<AgentTemplate>("payroll_line");
  const [contextInput, setContextInput] = useState("");
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");

  const tpl = TEMPLATES.find((t) => t.id === activeTemplate)!;

  const deriving = step === "deriving";
  const submitting = step === "approving" || step === "encrypting" || step === "sending";

  const handleDerive = async () => {
    if (!contextInput.trim()) {
      toast.error("Describe the situation for the agent first");
      return;
    }
    await derive(activeTemplate, contextInput.trim());
  };

  const handleSubmit = async (att: AgentAttestation) => {
    if (!recipient || !isAddress(recipient)) {
      toast.error("Enter a valid recipient address");
      return;
    }
    const hash = await submit(recipient as `0x${string}`, att, note.trim());
    if (hash) {
      setRecipient("");
      setNote("");
      setContextInput("");
      reset();
    }
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={22} className="text-purple-600 dark:text-purple-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">
              AI Agents · provenance on-chain
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Pay with an AI agent
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed max-w-2xl">
            Describe a payment in natural language. A server-side Claude derives the
            number, signs the attestation with a published agent key, and you submit
            the encrypted amount on-chain. The agent's address is recoverable on every
            event — auditable forever, never custodial.
          </p>
        </div>

        {/* Template picker */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setActiveTemplate(t.id);
                setContextInput("");
                reset();
              }}
              className={cn(
                "text-left rounded-2xl p-4 transition-all border",
                activeTemplate === t.id
                  ? "bg-purple-50 dark:bg-purple-500/10 border-purple-300 dark:border-purple-500/30"
                  : "bg-white/50 dark:bg-white/[0.03] border-black/5 hover:border-black/10 dark:border-white/5",
              )}
            >
              <div className="flex items-center gap-2 mb-2 text-purple-700 dark:text-purple-300">
                {t.icon}
                <span className="font-medium">{t.title}</span>
              </div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{t.blurb}</p>
            </button>
          ))}
        </div>

        {/* Context input + derive */}
        <div className="glass-card-static rounded-[2rem] p-6 mb-6">
          <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2 block">
            Describe the situation
          </label>
          <textarea
            value={contextInput}
            onChange={(e) => setContextInput(e.target.value.slice(0, 4000))}
            placeholder={tpl.placeholder}
            disabled={deriving || submitting}
            rows={4}
            className="w-full p-4 rounded-2xl bg-white/60 dark:bg-white/[0.03] border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none resize-none text-sm leading-relaxed disabled:opacity-50"
          />
          <div className="flex items-center justify-between mt-3">
            <button
              onClick={() => setContextInput(tpl.example)}
              disabled={deriving || submitting}
              className="text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            >
              Use example
            </button>
            <button
              onClick={handleDerive}
              disabled={deriving || submitting || !contextInput.trim() || !address}
              className="h-12 px-5 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium hover:bg-black dark:hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {deriving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Deriving...
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  Ask agent
                </>
              )}
            </button>
          </div>
          {step === "error" && error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Attestation review + submit */}
        {lastAttestation && (
          <div className="glass-card-static rounded-[2rem] p-6 space-y-5">
            <div className="flex items-center gap-2">
              <ShieldCheck size={18} className="text-emerald-600 dark:text-emerald-400" />
              <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                Agent attestation
              </span>
            </div>

            <div className="rounded-2xl bg-purple-50/60 dark:bg-purple-500/10 border border-purple-200/50 dark:border-purple-500/20 p-5">
              <div className="text-xs uppercase tracking-wider font-semibold text-purple-700/70 dark:text-purple-300/70 mb-1">
                Agent proposed
              </div>
              <div className="text-3xl font-mono font-semibold text-[var(--text-primary)]">
                {(Number(lastAttestation.amount) / 1_000_000).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 6,
                })}{" "}
                <span className="text-base text-[var(--text-secondary)]">USDC</span>
              </div>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-[var(--text-tertiary)]">Agent</span>
                  <code className="block font-mono break-all text-[var(--text-secondary)]">
                    {lastAttestation.agent}
                  </code>
                </div>
                <div>
                  <span className="text-[var(--text-tertiary)]">Expires</span>
                  <code className="block font-mono text-[var(--text-secondary)]">
                    {new Date(lastAttestation.expiry * 1000).toLocaleTimeString()}
                  </code>
                </div>
              </div>
              <details className="mt-3">
                <summary className="text-xs font-medium text-[var(--text-tertiary)] cursor-pointer">
                  Raw model output
                </summary>
                <pre className="mt-2 text-xs whitespace-pre-wrap text-[var(--text-secondary)] bg-white/40 dark:bg-black/30 rounded-lg p-3 max-h-32 overflow-auto">
                  {lastAttestation.raw}
                </pre>
              </details>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5 block">
                  Recipient address
                </label>
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="0x…"
                  disabled={submitting}
                  className="w-full h-12 px-4 rounded-2xl bg-white/60 dark:bg-white/[0.03] border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5 block">
                  Public note (optional)
                </label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value.slice(0, 80))}
                  placeholder="e.g. October payroll · senior eng"
                  disabled={submitting}
                  className="w-full h-12 px-4 rounded-2xl bg-white/60 dark:bg-white/[0.03] border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-sm disabled:opacity-50"
                />
              </div>
            </div>

            <button
              onClick={() => handleSubmit(lastAttestation)}
              disabled={submitting || !recipient || !isAddress(recipient)}
              className="w-full h-14 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium hover:bg-black dark:hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {step === "approving" ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Approving vault...
                </>
              ) : step === "encrypting" ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Encrypting amount...
                </>
              ) : step === "sending" ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Submitting on-chain...
                </>
              ) : step === "success" ? (
                <>
                  <CheckCircle2 size={16} /> Submitted!
                </>
              ) : (
                <>
                  <Send size={16} /> Encrypt & submit
                </>
              )}
            </button>

            <p className="text-xs text-[var(--text-tertiary)] text-center">
              The amount is encrypted before submission. The agent's signature is
              ECDSA-verified on {ACTIVE_CHAIN.name}. Anyone can audit the agent
              address from the AgentPaymentSubmission event.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
