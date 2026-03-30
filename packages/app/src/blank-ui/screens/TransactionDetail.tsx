import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  Copy,
  ExternalLink,
  Check,
  Send,
  ArrowDownLeft,
  ArrowLeftRight,
  Ghost,
  KeyRound,
  Gift,
  Heart,
  Briefcase,
  FileText,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchActivityById, type ActivityRow } from "@/lib/supabase";

const activityLabels: Record<string, string> = {
  payment: "Sent payment",
  request: "Payment request",
  request_fulfilled: "Request fulfilled",
  request_cancelled: "Request cancelled",
  group_expense: "Group expense",
  group_settle: "Debt settled",
  tip: "Creator tip",
  invoice_created: "Invoice created",
  invoice_paid: "Invoice paid",
  payroll: "Payroll sent",
  escrow_created: "Escrow created",
  escrow_released: "Escrow released",
  exchange_created: "Swap offer",
  exchange_filled: "Swap completed",
  shield: "Deposited to vault",
  unshield: "Withdrawn from vault",
  mint: "Faucet tokens",
  gift_created: "Gift sent",
  gift_claimed: "Gift opened",
  stealth_sent: "Anonymous payment",
  stealth_claim_started: "Claim started",
  stealth_claimed: "Payment claimed",
};

const typeIconMap: Record<string, { icon: React.ReactNode; bg: string }> = {
  payment: {
    icon: <Send size={24} />,
    bg: "bg-[#007AFF]/10 text-[#007AFF]",
  },
  receive: {
    icon: <ArrowDownLeft size={24} />,
    bg: "bg-emerald-50 text-emerald-600",
  },
  shield: {
    icon: <KeyRound size={24} />,
    bg: "bg-amber-50 text-amber-600",
  },
  unshield: {
    icon: <KeyRound size={24} />,
    bg: "bg-amber-50 text-amber-600",
  },
  swap: {
    icon: <ArrowLeftRight size={24} />,
    bg: "bg-purple-50 text-purple-600",
  },
  exchange_created: {
    icon: <ArrowLeftRight size={24} />,
    bg: "bg-purple-50 text-purple-600",
  },
  exchange_filled: {
    icon: <ArrowLeftRight size={24} />,
    bg: "bg-purple-50 text-purple-600",
  },
  stealth_sent: {
    icon: <Ghost size={24} />,
    bg: "bg-gray-100 text-gray-600",
  },
  stealth_claim_started: {
    icon: <Ghost size={24} />,
    bg: "bg-gray-100 text-gray-600",
  },
  stealth_claimed: {
    icon: <Ghost size={24} />,
    bg: "bg-gray-100 text-gray-600",
  },
  gift_created: {
    icon: <Gift size={24} />,
    bg: "bg-pink-50 text-pink-600",
  },
  gift_claimed: {
    icon: <Gift size={24} />,
    bg: "bg-pink-50 text-pink-600",
  },
  tip: {
    icon: <Heart size={24} />,
    bg: "bg-red-50 text-red-500",
  },
  invoice_created: {
    icon: <FileText size={24} />,
    bg: "bg-indigo-50 text-indigo-600",
  },
  invoice_paid: {
    icon: <FileText size={24} />,
    bg: "bg-indigo-50 text-indigo-600",
  },
  payroll: {
    icon: <Briefcase size={24} />,
    bg: "bg-teal-50 text-teal-600",
  },
};

function CopyableAddress({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  return (
    <div className="flex justify-between items-start p-4 rounded-2xl bg-white/50 border border-black/5">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-[var(--text-tertiary)] mb-1">{label}</p>
        <p className="text-sm font-mono text-[var(--text-primary)] break-all leading-relaxed">
          {address}
        </p>
      </div>
      <button
        onClick={handleCopy}
        className="ml-3 p-2 rounded-xl hover:bg-black/5 transition-colors flex-shrink-0"
        aria-label={`Copy ${label.toLowerCase()} address`}
      >
        {copied ? (
          <Check size={16} className="text-emerald-500" />
        ) : (
          <Copy size={16} className="text-[var(--text-tertiary)]" />
        )}
      </button>
    </div>
  );
}

export default function TransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activity, setActivity] = useState<ActivityRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) {
      setNotFound(true);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setIsLoading(true);
      const data = await fetchActivityById(id!);
      if (cancelled) return;

      if (data) {
        setActivity(data);
      } else {
        setNotFound(true);
      }
      setIsLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (isLoading) {
    return (
      <div className="animate-in fade-in duration-300">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-4 mb-8">
            <div className="shimmer w-11 h-11 rounded-full" />
            <div className="shimmer h-6 w-48 rounded" />
          </div>
          <div className="glass-card-static rounded-[2rem] p-8 space-y-4">
            <div className="flex items-center gap-4">
              <div className="shimmer w-16 h-16 rounded-2xl" />
              <div className="space-y-2 flex-1">
                <div className="shimmer h-5 w-32 rounded" />
                <div className="shimmer h-4 w-24 rounded" />
              </div>
            </div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="shimmer h-16 w-full rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (notFound || !activity) {
    return (
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-4 mb-8">
            <button
              onClick={() => navigate(-1)}
              className="w-11 h-11 rounded-full bg-white border border-black/5 flex items-center justify-center shadow-sm hover:bg-gray-50 transition-colors"
              aria-label="Go back"
            >
              <ChevronLeft size={20} />
            </button>
            <h1
              className="text-2xl font-semibold tracking-tight"
              style={{ fontFamily: "'Outfit', sans-serif" }}
            >
              Transaction Details
            </h1>
          </div>
          <div className="glass-card-static rounded-[2rem] p-16 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mb-4">
              <AlertCircle size={32} className="text-red-400" />
            </div>
            <p className="text-xl font-heading font-medium text-[var(--text-primary)] mb-1">
              Transaction not found
            </p>
            <p className="text-sm text-[var(--text-primary)]/50 mb-6">
              This transaction may have been removed or the link is invalid.
            </p>
            <button
              onClick={() => navigate("/history")}
              className="h-12 px-6 rounded-full bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors"
            >
              View All Transactions
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isPending = activity.id.startsWith("local_") || activity.block_number === 0;
  const typeInfo = typeIconMap[activity.activity_type] || {
    icon: <Send size={24} />,
    bg: "bg-gray-50 text-gray-400",
  };
  const hasValidTxHash = activity.tx_hash && !activity.tx_hash.includes("_");
  const formattedDate = new Date(activity.created_at).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const formattedTime = new Date(activity.created_at).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="w-11 h-11 rounded-full bg-white border border-black/5 flex items-center justify-center shadow-sm hover:bg-gray-50 transition-colors"
            aria-label="Go back"
          >
            <ChevronLeft size={20} />
          </button>
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: "'Outfit', sans-serif" }}
          >
            Transaction Details
          </h1>
        </div>

        <div className="glass-card-static rounded-[2rem] p-6 sm:p-8 space-y-5">
          {/* Type + Status Header */}
          <div className="flex items-center gap-4 pb-4 border-b border-black/5">
            <div
              className={cn(
                "w-14 h-14 rounded-2xl flex items-center justify-center",
                typeInfo.bg,
              )}
            >
              {typeInfo.icon}
            </div>
            <div className="flex-1 min-w-0">
              <h2
                className="text-lg font-semibold text-[var(--text-primary)]"
                style={{ fontFamily: "'Outfit', sans-serif" }}
              >
                {activityLabels[activity.activity_type] || activity.activity_type}
              </h2>
              <div className="flex items-center gap-2 mt-1">
                <div
                  className={cn(
                    "inline-flex px-2.5 py-1 rounded-full text-xs font-medium border",
                    isPending
                      ? "bg-amber-50 text-amber-700 border-amber-100"
                      : "bg-emerald-50 text-emerald-700 border-emerald-100",
                  )}
                >
                  {isPending ? "Pending" : "Confirmed"}
                </div>
              </div>
            </div>
          </div>

          {/* From Address */}
          <CopyableAddress address={activity.user_from} label="From" />

          {/* To Address */}
          <CopyableAddress address={activity.user_to} label="To" />

          {/* Encrypted Amount */}
          <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
            <p className="text-xs text-[var(--text-tertiary)] mb-1">Amount</p>
            <p className="text-xl font-heading font-medium font-mono text-[var(--text-primary)]">
              <span aria-hidden="true" className="encrypted-text">
                {"\u2588\u2588\u2588\u2588\u2588.\u2588\u2588"}
              </span>
              <span className="sr-only">Amount hidden (encrypted)</span>
            </p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">
              Encrypted with FHE — tap to reveal requires permit
            </p>
          </div>

          {/* Date & Time */}
          <div className="flex justify-between items-center p-4 rounded-2xl bg-white/50 border border-black/5">
            <div>
              <p className="text-xs text-[var(--text-tertiary)] mb-1">Date & Time</p>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                {formattedDate}
              </p>
              <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                {formattedTime}
              </p>
            </div>
          </div>

          {/* Note */}
          {activity.note && (
            <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
              <p className="text-xs text-[var(--text-tertiary)] mb-1">Note</p>
              <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                {activity.note}
              </p>
            </div>
          )}

          {/* Transaction Hash */}
          {hasValidTxHash && (
            <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
              <p className="text-xs text-[var(--text-tertiary)] mb-1">
                Transaction Hash
              </p>
              <p className="text-xs font-mono text-[var(--text-secondary)] break-all leading-relaxed">
                {activity.tx_hash}
              </p>
            </div>
          )}

          {/* Explorer Link */}
          {hasValidTxHash && (
            <a
              href={`https://sepolia.basescan.org/tx/${activity.tx_hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 h-14 rounded-2xl bg-blue-50 text-blue-600 font-medium text-sm hover:bg-blue-100 transition-colors"
            >
              View on Basescan
              <ExternalLink size={16} />
            </a>
          )}

          {/* Back to History */}
          <button
            onClick={() => navigate("/history")}
            className="h-12 w-full rounded-2xl bg-gray-100 text-[var(--text-secondary)] font-medium text-sm hover:bg-gray-200 transition-colors"
          >
            Back to Activity
          </button>
        </div>
      </div>
    </div>
  );
}
