import { useState, useEffect, useCallback } from "react";
import {
  Sparkles,
  Send,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Briefcase,
  Receipt,
  Inbox,
  ExternalLink,
} from "lucide-react";
import { isAddress } from "viem";
import toast from "react-hot-toast";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/cn";
import { useAgentPayment, type AgentTemplate, type AgentAttestation } from "@/hooks/useAgentPayment";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { fetchActivities, supabase, type ActivityRow } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { STORAGE_KEYS, getStoredJson, setStoredJson } from "@/lib/storage";

// ──────────────────────────────────────────────────────────────────
//  AgentPayments — server-derived AI payment with on-chain provenance.
//
//  Two demos exposed:
//    - Smart payroll line: describe a role + region → agent derives salary
//    - AI expense split:   describe a receipt → agent derives the share
//
//  Flow on each: derive (preview) → user confirms recipient + note → submit.
//
//  Plus a "Received" tab so recipients of agent-derived payments have a
//  persistent, dedicated view (not just an ephemeral toast) — see #183.
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

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export default function AgentPayments() {
  // Use effectiveAddress everywhere — useAccount().address is null for
  // passkey smart-account users, which would leave the Ask agent button
  // permanently disabled. Same class of bug fixed earlier for
  // Profile/Settings/Receive/Requests.
  const { effectiveAddress } = useEffectiveAddress();
  const address = effectiveAddress;
  const { activeChain, activeChainId } = useChain();
  const { step, error, lastAttestation, blockTimestamp, derive, submit, reset } = useAgentPayment();

  const [activeTab, setActiveTab] = useState<"send" | "received">("send");
  const [activeTemplate, setActiveTemplate] = useState<AgentTemplate>("payroll_line");
  const [contextInput, setContextInput] = useState("");
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  // Local 1s tick for smooth countdown display. Reconciled to the on-chain
  // block timestamp (refreshed every 10s inside useAgentPayment) so we
  // never render "Expired" purely because of client clock skew.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Received-tab state
  const [receivedPayments, setReceivedPayments] = useState<ActivityRow[]>([]);
  const [loadingReceived, setLoadingReceived] = useState(false);
  const [seenTick, setSeenTick] = useState(0);

  const tpl = TEMPLATES.find((t) => t.id === activeTemplate)!;

  const deriving = step === "deriving";
  const submitting = step === "approving" || step === "encrypting" || step === "sending";

  // Live countdown while an attestation is held
  useEffect(() => {
    if (!lastAttestation) return;
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [lastAttestation]);

  // Prefer the on-chain block timestamp as the reference; fall back to the
  // local 1s ticker when no block has been fetched yet. This matches what
  // the contract will actually compare against (block.timestamp).
  const referenceTs = blockTimestamp ?? now;
  const remaining = lastAttestation ? lastAttestation.expiry - referenceTs : 0;
  const expired = lastAttestation ? remaining <= 0 : false;
  // 30s safety margin: block inclusion time + a small buffer.
  const tooCloseToExpiry = lastAttestation ? remaining <= 30 : false;

  // ─── Received-tab data ──────────────────────────────────────────
  const seenKey =
    effectiveAddress && activeChainId
      ? STORAGE_KEYS.agentReceivedSeen(effectiveAddress, activeChainId)
      : null;

  const loadReceived = useCallback(async () => {
    if (!effectiveAddress) return;
    setLoadingReceived(true);
    try {
      const all = await fetchActivities(effectiveAddress, 100);
      const lower = effectiveAddress.toLowerCase();
      const agentOnly = all.filter(
        (a) =>
          a.activity_type === ACTIVITY_TYPES.AGENT_PAYMENT &&
          a.user_to.toLowerCase() === lower &&
          a.user_from.toLowerCase() !== lower,
      );
      setReceivedPayments(agentOnly);
    } finally {
      setLoadingReceived(false);
    }
  }, [effectiveAddress]);

  // Initial load + chain change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!effectiveAddress) {
        setReceivedPayments([]);
        return;
      }
      setLoadingReceived(true);
      try {
        const all = await fetchActivities(effectiveAddress, 100);
        if (cancelled) return;
        const lower = effectiveAddress.toLowerCase();
        const agentOnly = all.filter(
          (a) =>
            a.activity_type === ACTIVITY_TYPES.AGENT_PAYMENT &&
            a.user_to.toLowerCase() === lower &&
            a.user_from.toLowerCase() !== lower,
        );
        setReceivedPayments(agentOnly);
      } finally {
        if (!cancelled) setLoadingReceived(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveAddress, activeChainId]);

  // Realtime: subscribe to new activities where user_to = me, filter client-side
  // for agent_payment rows sent by someone else.
  useEffect(() => {
    if (!effectiveAddress || !supabase) return;
    const lower = effectiveAddress.toLowerCase();
    const channel = supabase
      .channel(`agent_received_${lower}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "activities",
          filter: `user_to=eq.${lower}`,
        },
        (payload: { new: Record<string, unknown> }) => {
          const row = payload.new as unknown as ActivityRow;
          if (
            row.activity_type !== ACTIVITY_TYPES.AGENT_PAYMENT ||
            row.user_from.toLowerCase() === lower
          ) {
            return;
          }
          setReceivedPayments((prev) => {
            if (prev.some((p) => p.tx_hash === row.tx_hash)) return prev;
            return [row, ...prev];
          });
        },
      )
      .subscribe();

    return () => {
      supabase!.removeChannel(channel);
    };
  }, [effectiveAddress]);

  const seenHashes: string[] = seenKey ? getStoredJson<string[]>(seenKey, []) : [];
  // seenTick is referenced so React re-reads seenHashes after we mark them seen.
  void seenTick;
  const unreadCount = receivedPayments.filter((p) => !seenHashes.includes(p.tx_hash)).length;

  const handleSwitchToReceived = () => {
    setActiveTab("received");
    if (seenKey && receivedPayments.length > 0) {
      const allHashes = receivedPayments.map((p) => p.tx_hash);
      setStoredJson(seenKey, allHashes);
      setSeenTick((n) => n + 1);
    }
  };

  // When a new payment lands while the received tab is already open, mark it
  // seen immediately so the badge doesn't re-appear.
  useEffect(() => {
    if (activeTab !== "received" || !seenKey) return;
    const allHashes = receivedPayments.map((p) => p.tx_hash);
    const current = getStoredJson<string[]>(seenKey, []);
    const merged = Array.from(new Set([...current, ...allHashes]));
    if (merged.length !== current.length) {
      setStoredJson(seenKey, merged);
      setSeenTick((n) => n + 1);
    }
  }, [activeTab, receivedPayments, seenKey]);

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
    // Guard against the on-chain block timestamp (the hook also re-checks
    // this before the tx — this is just fast-fail UX).
    const secondsLeft = att.expiry - (blockTimestamp ?? Math.floor(Date.now() / 1000));
    if (secondsLeft <= 30) {
      toast.error("Attestation about to expire — re-derive");
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

        {/* Tab Switcher */}
        <div
          className="flex flex-wrap gap-2 sm:gap-3 mb-6"
          role="tablist"
          aria-label="Agent payment tabs"
        >
          <button
            onClick={() => setActiveTab("send")}
            role="tab"
            aria-selected={activeTab === "send"}
            aria-label="Send via agent"
            className={cn(
              "flex-1 min-w-[140px] h-12 sm:h-14 px-3 sm:px-6 rounded-2xl font-medium transition-all text-xs sm:text-sm",
              activeTab === "send"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80",
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Send size={18} />
              <span>Send</span>
            </div>
          </button>
          <button
            onClick={handleSwitchToReceived}
            role="tab"
            aria-selected={activeTab === "received"}
            aria-label="Received agent payments"
            className={cn(
              "flex-1 min-w-[140px] h-12 sm:h-14 px-3 sm:px-6 rounded-2xl font-medium transition-all relative text-xs sm:text-sm",
              activeTab === "received"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80",
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Inbox size={18} />
              <span>Received</span>
              {unreadCount > 0 && (
                <span
                  className={cn(
                    "ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold",
                    activeTab === "received"
                      ? "bg-white text-[var(--text-primary)]"
                      : "bg-purple-500 text-white",
                  )}
                  aria-label={`${unreadCount} new agent payments received`}
                >
                  {unreadCount}
                </span>
              )}
            </div>
          </button>
        </div>

        {/* Send Tab */}
        {activeTab === "send" && (
          <>
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
            <div className="glass-card-static rounded-[2rem] p-4 sm:p-6 mb-6">
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
              <div className="glass-card-static rounded-[2rem] p-4 sm:p-6 space-y-5">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={18} className="text-emerald-600 dark:text-emerald-400" />
                  <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    Agent attestation
                  </span>
                </div>

                <div className="rounded-2xl bg-purple-50/60 dark:bg-purple-500/10 border border-purple-200/50 dark:border-purple-500/20 p-4 sm:p-5">
                  <div className="text-xs uppercase tracking-wider font-semibold text-purple-700/70 dark:text-purple-300/70 mb-1">
                    Agent proposed
                  </div>
                  <div className="text-2xl sm:text-3xl font-mono font-semibold text-[var(--text-primary)] break-all">
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
                      <code
                        className={cn(
                          "block font-mono",
                          expired ? "text-red-600 dark:text-red-400" : "text-[var(--text-secondary)]",
                        )}
                      >
                        {expired
                          ? "Expired — please re-derive"
                          : `Expires in ${Math.floor(remaining / 60)}m ${remaining % 60}s`}
                      </code>
                    </div>
                  </div>
                  {lastAttestation.model && (
                    <div className="mt-3 flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                      <span className="font-semibold uppercase tracking-wider">Model</span>
                      <code className="font-mono bg-black/[0.04] dark:bg-white/[0.05] px-2 py-0.5 rounded">
                        {lastAttestation.model}
                      </code>
                      {lastAttestation.provider && (
                        <span className="px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-300">
                          {lastAttestation.provider}
                        </span>
                      )}
                    </div>
                  )}
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
                  disabled={submitting || !recipient || !isAddress(recipient) || expired || tooCloseToExpiry}
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
                  ECDSA-verified on {activeChain.name}. Anyone can audit the agent
                  address from the AgentPaymentSubmission event.
                </p>
              </div>
            )}
          </>
        )}

        {/* Received Tab */}
        {activeTab === "received" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm text-[var(--text-secondary)]">
                {loadingReceived
                  ? "Loading…"
                  : receivedPayments.length === 1
                  ? "1 agent payment received"
                  : `${receivedPayments.length} agent payments received`}
              </div>
              <button
                onClick={loadReceived}
                disabled={loadingReceived || !effectiveAddress}
                className="text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-30"
              >
                {loadingReceived ? "Refreshing…" : "Refresh"}
              </button>
            </div>

            {receivedPayments.length === 0 && !loadingReceived && (
              <div className="glass-card-static rounded-3xl p-8 text-center">
                <div className="w-14 h-14 rounded-2xl bg-purple-50 dark:bg-purple-500/10 flex items-center justify-center mx-auto mb-4">
                  <Inbox size={28} className="text-purple-500 dark:text-purple-300" />
                </div>
                <h3 className="text-lg font-heading font-medium text-[var(--text-primary)] mb-2">
                  No agent payments received yet
                </h3>
                <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto leading-relaxed">
                  When someone sends you a payment derived by an AI agent, it'll appear
                  here with the sender, the public note, and a link to the on-chain
                  event you can audit.
                </p>
              </div>
            )}

            {receivedPayments.map((p) => {
              const unread = !seenHashes.includes(p.tx_hash);
              return (
                <div
                  key={p.tx_hash}
                  className={cn(
                    "glass-card-static rounded-3xl p-4 sm:p-5 transition-all",
                    unread && "ring-2 ring-purple-300/60 dark:ring-purple-500/30",
                  )}
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Sparkles size={14} className="text-purple-600 dark:text-purple-400 shrink-0" />
                        <span className="text-xs font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">
                          Agent payment
                        </span>
                        {unread && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider bg-purple-500 text-white rounded-full px-2 py-0.5">
                            New
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-[var(--text-primary)]">
                        <span className="text-[var(--text-tertiary)]">From</span>{" "}
                        <code className="font-mono text-[var(--text-primary)]">
                          {shortAddr(p.user_from)}
                        </code>
                      </div>
                      {p.note && (
                        <div className="mt-2 text-sm text-[var(--text-secondary)] break-words">
                          {p.note}
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)] whitespace-nowrap">
                      {p.created_at ? relativeTime(p.created_at) : ""}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between flex-wrap gap-2">
                    <code className="text-[11px] font-mono text-[var(--text-tertiary)] break-all">
                      {p.tx_hash.slice(0, 18)}…
                    </code>
                    <a
                      href={`${activeChain.explorerUrl}/tx/${p.tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-600 dark:text-purple-300 hover:text-purple-700 dark:hover:text-purple-200 transition-colors"
                    >
                      View on explorer
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
