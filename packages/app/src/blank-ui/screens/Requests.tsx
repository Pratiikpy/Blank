import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useNavigate } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  Plus,
  X,
  Loader2,
  Send,
  Ban,
  FileText,
  AlertCircle,
  Clock,
} from "lucide-react";
import toast from "react-hot-toast";
import { useRequestPayment } from "@/hooks/useRequestPayment";
import { fetchIncomingRequests, fetchOutgoingRequests, type PaymentRequestRow } from "@/lib/supabase";

// ---------------------------------------------------------------
//  CREATE REQUEST MODAL
// ---------------------------------------------------------------

function CreateRequestModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { createRequest, step, error, reset } = useRequestPayment();
  const [payerAddress, setPayerAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const isProcessing = step === "encrypting" || step === "sending";

  const handleCreate = useCallback(async () => {
    if (!payerAddress.trim()) {
      toast.error("Enter the payer address");
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(payerAddress.trim())) {
      toast.error("Invalid Ethereum address");
      return;
    }
    if (!amount || parseFloat(amount) <= 0) {
      toast.error("Enter a valid amount");
      return;
    }

    await createRequest(payerAddress.trim().toLowerCase(), amount, note);
  }, [payerAddress, amount, note, createRequest]);

  // Close on success
  useEffect(() => {
    if (step === "success") {
      onCreated();
      onClose();
      reset();
    }
  }, [step, onCreated, onClose, reset]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated w-full max-w-lg mx-4 mb-4 sm:mb-0 p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-heading font-medium text-[var(--text-primary)]">
            Request Payment
          </h2>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors"
            aria-label="Close"
          >
            <X size={20} className="text-[var(--text-primary)]/50" />
          </button>
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
            Payer Address
          </label>
          <input
            type="text"
            placeholder="0x... (who should pay)"
            value={payerAddress}
            onChange={(e) => setPayerAddress(e.target.value)}
            className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 font-mono text-sm"
          />
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
            Amount (USDC)
          </label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">
              $
            </span>
            <input
              type="text"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                const v = e.target.value;
                if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setAmount(v);
              }}
              className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-lg"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
            Note (visible to payer)
          </label>
          <textarea
            placeholder="Dinner split, rent, etc."
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full px-5 py-4 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 resize-none"
          />
        </div>

        {/* Processing indicator */}
        {isProcessing && (
          <div className="p-4 rounded-2xl bg-blue-50 border border-blue-100">
            <div className="flex items-center gap-3">
              <Loader2 size={20} className="text-blue-600 animate-spin" />
              <p className="text-sm font-medium text-blue-900">
                {step === "encrypting"
                  ? "Encrypting request amount..."
                  : "Sending request on-chain..."}
              </p>
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="p-4 rounded-2xl bg-red-50 border border-red-100">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-red-600 mt-0.5" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 h-14 px-6 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium transition-all hover:bg-black/10"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isProcessing || !payerAddress.trim() || !amount}
            className="flex-1 h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isProcessing ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Send size={20} />
            )}
            <span>Send Request</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  FULFILL (PAY) MODAL
// ---------------------------------------------------------------

function FulfillModal({
  request,
  onClose,
  onFulfilled,
}: {
  request: PaymentRequestRow;
  onClose: () => void;
  onFulfilled: () => void;
}) {
  const { fulfillRequest, step, error, reset } = useRequestPayment();
  const [amount, setAmount] = useState("");

  const isProcessing = step === "encrypting" || step === "sending";

  const handleFulfill = useCallback(async () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    // request.to_address is the requester (who wants money)
    await fulfillRequest(request.request_id, amount, request.to_address);
  }, [amount, fulfillRequest, request.request_id, request.to_address]);

  // Close on success
  useEffect(() => {
    if (step === "success") {
      onFulfilled();
      onClose();
      reset();
    }
  }, [step, onFulfilled, onClose, reset]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated w-full max-w-lg mx-4 mb-4 sm:mb-0 p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-heading font-medium text-[var(--text-primary)]">
            Pay Request
          </h2>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors"
            aria-label="Close"
          >
            <X size={20} className="text-[var(--text-primary)]/50" />
          </button>
        </div>

        {/* Request details */}
        <div className="p-5 rounded-2xl bg-white/50 border border-black/5 space-y-2">
          <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]/50">
            <FileText size={14} />
            <span>Request from</span>
          </div>
          <p className="font-mono text-sm font-medium text-[var(--text-primary)]">
            {request.to_address.slice(0, 10)}...{request.to_address.slice(-8)}
          </p>
          {request.note && (
            <div className="pt-2 border-t border-black/5">
              <p className="text-sm text-[var(--text-primary)]/70 italic">
                &ldquo;{request.note}&rdquo;
              </p>
            </div>
          )}
          <p className="text-xs text-[var(--text-primary)]/40">
            {new Date(request.created_at).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
            Amount to Pay (USDC)
          </label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">
              $
            </span>
            <input
              type="text"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                const v = e.target.value;
                if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setAmount(v);
              }}
              className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-lg"
            />
          </div>
          <p className="text-xs text-[var(--text-primary)]/40 mt-2">
            The requested amount is encrypted. Enter the amount agreed upon with the requester.
          </p>
        </div>

        {/* Processing indicator */}
        {isProcessing && (
          <div className="p-4 rounded-2xl bg-blue-50 border border-blue-100">
            <div className="flex items-center gap-3">
              <Loader2 size={20} className="text-blue-600 animate-spin" />
              <p className="text-sm font-medium text-blue-900">
                {step === "encrypting"
                  ? "Encrypting payment..."
                  : "Fulfilling request on-chain..."}
              </p>
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="p-4 rounded-2xl bg-red-50 border border-red-100">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-red-600 mt-0.5" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 h-14 px-6 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium transition-all hover:bg-black/10"
          >
            Cancel
          </button>
          <button
            onClick={handleFulfill}
            disabled={isProcessing || !amount}
            className="flex-1 h-14 px-6 rounded-2xl bg-emerald-600 text-white font-medium transition-transform active:scale-95 hover:bg-emerald-700 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isProcessing ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Send size={20} />
            )}
            <span>Pay Now</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function Requests() {
  const { address } = useAccount();
  const navigate = useNavigate();
  const { cancelRequest } = useRequestPayment();

  const [tab, setTab] = useState<"incoming" | "outgoing">("incoming");
  const [incoming, setIncoming] = useState<PaymentRequestRow[]>([]);
  const [outgoing, setOutgoing] = useState<PaymentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [fulfillTarget, setFulfillTarget] = useState<PaymentRequestRow | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  const loadRequests = useCallback(() => {
    if (!address) return;
    setLoading(true);
    Promise.all([
      fetchIncomingRequests(address.toLowerCase()),
      fetchOutgoingRequests(address.toLowerCase()),
    ]).then(([inc, out]) => {
      setIncoming(inc);
      setOutgoing(out);
      setLoading(false);
    });
  }, [address]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const handleCancel = useCallback(
    async (req: PaymentRequestRow) => {
      const confirmed = window.confirm(
        `Cancel request to ${req.from_address.slice(0, 8)}...?\n\nNote: "${req.note || "No note"}"`
      );
      if (!confirmed) return;

      setCancellingId(req.request_id);
      await cancelRequest(req.request_id);
      setCancellingId(null);
      // Refresh the list
      loadRequests();
    },
    [cancelRequest, loadRequests]
  );

  const requests = tab === "incoming" ? incoming : outgoing;

  const EXPIRY_DAYS = 7;

  const getRequestAge = useCallback((createdAt: string) => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }, []);

  const isRequestExpired = useCallback((createdAt: string) => {
    return Date.now() - new Date(createdAt).getTime() > EXPIRY_DAYS * 86_400_000;
  }, []);

  if (!address) return null;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate(-1)} className="w-11 h-11 rounded-full bg-white border border-black/5 flex items-center justify-center shadow-sm">
              <ChevronLeft size={20} />
            </button>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight" style={{ fontFamily: "'Outfit', sans-serif" }}>Payment Requests</h1>
              <p className="text-sm text-[var(--text-secondary)]">Manage incoming and outgoing requests</p>
            </div>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="h-12 px-5 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
          >
            <Plus size={18} />
            <span className="hidden sm:inline">Request</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-3 mb-6">
          {(["incoming", "outgoing"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`h-12 px-6 rounded-full font-medium transition-all ${
                tab === t
                  ? "bg-[#1D1D1F] text-white"
                  : "bg-white/60 border border-black/5 text-[var(--text-secondary)] hover:bg-white"
              }`}
            >
              {t === "incoming" ? "Incoming" : "Outgoing"}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="glass-card-static rounded-[2rem] p-6 space-y-3">
          {loading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => <div key={i} className="h-20 rounded-2xl bg-gray-100 animate-pulse" />)}
            </div>
          ) : requests.length === 0 ? (
            <div className="py-12 text-center">
              <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-3">
                <FileText size={28} className="text-amber-400" />
              </div>
              <p className="text-[var(--text-primary)] font-medium mb-1">
                No {tab} requests
              </p>
              <p className="text-sm text-[var(--text-secondary)]">
                {tab === "incoming"
                  ? "Requests for you to pay will appear here"
                  : "Create a request to get started"}
              </p>
            </div>
          ) : (
            requests.map(req => {
              const expired = req.status === "pending" && isRequestExpired(req.created_at);
              return (
              <div key={req.id} className={`p-4 rounded-2xl border border-black/5 transition-all ${expired ? "bg-white/30 opacity-60" : "bg-white/50 hover:bg-white/70"}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${tab === "incoming" ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-600"}`}>
                      {tab === "incoming" ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {tab === "incoming"
                          ? `From ${req.to_address.slice(0, 6)}...${req.to_address.slice(-4)}`
                          : `To ${req.from_address.slice(0, 6)}...${req.from_address.slice(-4)}`}
                      </p>
                      {req.note ? (
                        <p className="text-sm text-[var(--text-primary)]/60 mt-0.5 italic truncate">
                          &ldquo;{req.note}&rdquo;
                        </p>
                      ) : (
                        <p className="text-xs text-[var(--text-tertiary)] mt-0.5">No note</p>
                      )}
                      <p className="text-xs text-[var(--text-primary)]/30 mt-0.5 flex items-center gap-1">
                        <Clock size={10} />
                        {getRequestAge(req.created_at)}
                        {" \u00b7 "}
                        {new Date(req.created_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    {expired && (
                      <span className="text-xs px-2.5 py-1 rounded-full font-medium border bg-gray-100 text-gray-400 border-gray-200">
                        Expired
                      </span>
                    )}
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium border ${
                      req.status === "pending"
                        ? expired
                          ? "bg-gray-50 text-gray-400 border-gray-200"
                          : "bg-amber-50 text-amber-600 border-amber-100"
                        : req.status === "fulfilled"
                          ? "bg-emerald-50 text-emerald-600 border-emerald-100"
                          : "bg-gray-100 text-gray-500 border-gray-200"
                    }`}>
                      {req.status}
                    </span>

                    {/* Action buttons for pending requests */}
                    {req.status === "pending" && tab === "incoming" && (
                      <button
                        onClick={() => setFulfillTarget(req)}
                        disabled={expired}
                        className="h-9 px-4 rounded-xl bg-emerald-600 text-white text-sm font-medium transition-transform active:scale-95 hover:bg-emerald-700 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Send size={14} />
                        Pay
                      </button>
                    )}

                    {req.status === "pending" && tab === "outgoing" && (
                      <button
                        onClick={() => handleCancel(req)}
                        disabled={cancellingId === req.request_id}
                        className="h-9 px-4 rounded-xl bg-red-50 text-red-600 text-sm font-medium border border-red-100 transition-all hover:bg-red-100 flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {cancellingId === req.request_id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Ban size={14} />
                        )}
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </div>
              );
            })
          )}
        </div>
      </div>

      {/* Modals */}
      {showCreateModal && (
        <CreateRequestModal
          onClose={() => setShowCreateModal(false)}
          onCreated={loadRequests}
        />
      )}
      {fulfillTarget && (
        <FulfillModal
          request={fulfillTarget}
          onClose={() => setFulfillTarget(null)}
          onFulfilled={loadRequests}
        />
      )}
    </div>
  );
}
