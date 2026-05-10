import { useState, useMemo } from "react";
import { Link2, Mail, AtSign, Lock, Copy, Check, AlertCircle } from "lucide-react";
import toast from "react-hot-toast";
import { isAddress } from "viem";

import { useClaimLinks, type CreateLinkInput } from "@/hooks/useClaimLinks";
import { useChain } from "@/providers/ChainProvider";
import { MODE, type LinkMode } from "@/lib/claim-links";
import { cn } from "@/lib/cn";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";

// Pre-set expiry windows. Sender can pick "1 day" through "30 days".
const EXPIRY_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];

export default function CreateClaimLink() {
  const { contracts } = useChain();
  const { state, pipeline, createLink, reset } = useClaimLinks();

  const [mode, setMode] = useState<LinkMode>(MODE.EmailBound);
  const [amount, setAmount] = useState("");
  const [email, setEmail] = useState("");
  const [boundAddress, setBoundAddress] = useState("");
  const [note, setNote] = useState("");
  const [expirySeconds, setExpirySeconds] = useState(EXPIRY_OPTIONS[1].seconds);

  const validation = useMemo(() => {
    if (!amount || Number.parseFloat(amount) <= 0) return "Enter an amount above zero";
    if (mode === MODE.EmailBound) {
      if (!email || email.indexOf("@") < 1) return "Enter a valid email";
    }
    if (mode === MODE.AddressBound) {
      if (!boundAddress || !isAddress(boundAddress)) return "Enter a valid address";
    }
    return null;
  }, [amount, mode, email, boundAddress]);

  const handleCreate = async () => {
    if (validation) {
      toast.error(validation);
      return;
    }
    const input: CreateLinkInput =
      mode === MODE.Bearer
        ? { mode: MODE.Bearer }
        : mode === MODE.EmailBound
          ? { mode: MODE.EmailBound, email }
          : { mode: MODE.AddressBound, boundAddress: boundAddress as `0x${string}` };

    await createLink({
      vault: contracts.FHERC20Vault_USDC,
      amountTokens: amount,
      decimals: 6,
      note,
      expirySeconds,
      input,
    });
  };

  const copyUrl = async () => {
    if (!state.shareableUrl) return;
    await navigator.clipboard.writeText(state.shareableUrl);
    toast.success("Link copied");
  };

  // ─── Success screen ───────────────────────────────────────────────
  if (state.step === "success" && state.shareableUrl) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="glass-card-static rounded-[2rem] p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-6">
            <Check size={32} className="text-emerald-600" />
          </div>
          <h2 className="text-2xl font-heading font-semibold mb-3">Link ready</h2>
          <p className="text-[var(--text-secondary)] mb-6">
            Share this URL with the recipient. The amount stays encrypted until they claim it.
          </p>
          <div className="bg-[var(--surface-2)] rounded-2xl p-4 mb-4 break-all text-sm font-mono text-left">
            {state.shareableUrl}
          </div>
          <button
            onClick={copyUrl}
            className="inline-flex items-center gap-2 px-6 h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors mb-3"
          >
            <Copy size={18} /> Copy link
          </button>
          <div className="text-sm text-[var(--text-secondary)] mt-2">
            Expires {new Date(Date.now() + expirySeconds * 1000).toLocaleString()}.
            If unclaimed, you can refund from the Claim Links tab.
          </div>
          <button
            onClick={reset}
            className="mt-6 text-sm underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Create another link
          </button>
        </div>
      </div>
    );
  }

  // ─── Form screen ──────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto">
      <div className="glass-card-static rounded-[2rem] p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
            <Link2 size={24} className="text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-heading font-semibold">Send by link</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Encrypted. Refundable if unclaimed.
            </p>
          </div>
        </div>

        {/* Mode picker */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Who can claim it?</label>
          <div className="grid grid-cols-3 gap-2">
            <ModePill
              active={mode === MODE.Bearer}
              onClick={() => setMode(MODE.Bearer)}
              icon={<Link2 size={16} />}
              label="Anyone"
              hint="Open link"
            />
            <ModePill
              active={mode === MODE.EmailBound}
              onClick={() => setMode(MODE.EmailBound)}
              icon={<Mail size={16} />}
              label="Email"
              hint="Default"
            />
            <ModePill
              active={mode === MODE.AddressBound}
              onClick={() => setMode(MODE.AddressBound)}
              icon={<AtSign size={16} />}
              label="Address"
              hint="One wallet"
            />
          </div>
        </div>

        {/* Conditional second-factor input */}
        {mode === MODE.EmailBound && (
          <Field
            label="Recipient email"
            icon={<Mail size={16} />}
            value={email}
            onChange={setEmail}
            placeholder="alice@example.com"
            type="email"
          />
        )}
        {mode === MODE.AddressBound && (
          <Field
            label="Recipient address"
            icon={<AtSign size={16} />}
            value={boundAddress}
            onChange={setBoundAddress}
            placeholder="0x... or alice.eth"
          />
        )}

        {/* Amount */}
        <Field
          label="Amount (USDC)"
          value={amount}
          onChange={(v) => setAmount(v.replace(/[^0-9.]/g, ""))}
          placeholder="10.00"
          type="text"
        />

        {/* Optional note */}
        <Field
          label="Note (optional)"
          value={note}
          onChange={setNote}
          placeholder="Lunch tab"
        />

        {/* Expiry */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Expires after</label>
          <div className="grid grid-cols-3 gap-2">
            {EXPIRY_OPTIONS.map((opt) => (
              <button
                key={opt.seconds}
                onClick={() => setExpirySeconds(opt.seconds)}
                aria-pressed={expirySeconds === opt.seconds}
                className={cn(
                  "h-12 rounded-xl border-2 text-sm font-medium transition-all",
                  expirySeconds === opt.seconds
                    ? "bg-[#1D1D1F] border-[#1D1D1F] text-white shadow-sm"
                    : "bg-white border-black/10 text-[var(--text-primary)] hover:border-black/30 hover:bg-black/[0.02]",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-2 flex items-center gap-1">
            <Lock size={12} /> If unclaimed by then, you can refund yourself.
          </p>
        </div>

        {/* Wave 4 task #245 — real-step FHE pipeline progress, driven
            by the SDK's onStep callback for the 5 encrypt phases plus
            our own submit/confirm markers. Replaces the old single-line
            spinner with a transparent multi-step view. */}
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
          className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {state.isProcessing ? "Creating…" : "Create link"}
        </button>
      </div>
    </div>
  );
}

// ─── small primitives ─────────────────────────────────────────────────

function ModePill(props: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "flex flex-col items-center justify-center gap-1 h-20 rounded-xl border-2 transition-all",
        props.active
          ? "bg-[#1D1D1F] border-[#1D1D1F] text-white shadow-sm"
          : "bg-white border-black/10 text-[var(--text-primary)] hover:border-black/30 hover:bg-black/[0.02]",
      )}
    >
      <div className={props.active ? "text-white/90" : "text-[var(--text-secondary)]"}>{props.icon}</div>
      <div className="text-sm font-medium">{props.label}</div>
      {props.hint && (
        <div className={cn("text-xs", props.active ? "text-white/60" : "text-[var(--text-secondary)]")}>
          {props.hint}
        </div>
      )}
    </button>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium mb-2">{props.label}</label>
      <div className="relative">
        {props.icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]">
            {props.icon}
          </div>
        )}
        <input
          type={props.type || "text"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          className={cn(
            "w-full h-12 rounded-xl border border-[var(--border)] bg-transparent text-base",
            "focus:border-[var(--border-strong)] focus:outline-none transition-colors",
            props.icon ? "pl-10 pr-3" : "px-3",
          )}
        />
      </div>
    </div>
  );
}
