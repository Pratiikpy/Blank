import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { MessageSquare, Plus, ArrowRight, CreditCard, X, Ban, RefreshCw } from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { useRequestPayment } from "@/hooks/useRequestPayment";
import { useContacts } from "@/hooks/useContacts";
import { fetchIncomingRequests, fetchOutgoingRequests, type PaymentRequestRow } from "@/lib/supabase";

type TabType = "incoming" | "outgoing";

export function RequestPage() {
  const { isConnected, address } = useAccount();
  const [tab, setTab] = useState<TabType>("incoming");
  const [showCreate, setShowCreate] = useState(false);
  const { createRequest, fulfillRequest, cancelRequest, step } = useRequestPayment();
  const { contacts } = useContacts();

  // Form state for creating a request
  const [fromAddress, setFromAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  // Pay-prompt state: which request is being paid and the amount input
  const [payingRequestId, setPayingRequestId] = useState<number | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  // Data
  const [incoming, setIncoming] = useState<PaymentRequestRow[]>([]);
  const [outgoing, setOutgoing] = useState<PaymentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshData = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    const [inc, out] = await Promise.all([
      fetchIncomingRequests(address),
      fetchOutgoingRequests(address),
    ]);
    setIncoming(inc);
    setOutgoing(out);
    setLoading(false);
  }, [address]);

  // Fetch requests on mount + poll every 30s
  useEffect(() => {
    refreshData();
    const interval = setInterval(() => refreshData(), 30000);
    return () => clearInterval(interval);
  }, [refreshData]);

  if (!isConnected) return <ConnectPrompt />;

  const handleCreateRequest = async () => {
    if (!fromAddress || !amount) return;
    await createRequest(fromAddress, amount, note);
    setFromAddress("");
    setAmount("");
    setNote("");
    setShowCreate(false);
    await refreshData();
  };

  const handleFulfill = async (reqId: number) => {
    if (!payAmount) return;
    setActionLoading(reqId);
    const request = incoming.find((r) => r.request_id === reqId);
    await fulfillRequest(reqId, payAmount, request?.to_address || "");
    setPayingRequestId(null);
    setPayAmount("");
    setActionLoading(null);
    await refreshData();
  };

  const handleDecline = async (reqId: number) => {
    setActionLoading(reqId);
    await cancelRequest(reqId);
    setActionLoading(null);
    await refreshData();
  };

  const handleCancel = async (reqId: number) => {
    setActionLoading(reqId);
    await cancelRequest(reqId);
    setActionLoading(null);
    await refreshData();
  };

  const requests = tab === "incoming" ? incoming : outgoing;

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Requests</h1>
          <p className="text-base text-apple-secondary font-medium mt-1">Request money or pay pending requests</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refreshData} className="text-xs text-apple-secondary hover:text-white transition-colors flex items-center gap-1">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(!showCreate)}>
            New Request
          </Button>
        </div>
      </div>

      {/* Create Request Form */}
      <AnimatePresence>
        {showCreate && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <GlassCard variant="elevated" className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                  <MessageSquare className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-subheading font-semibold">Request Payment</h3>
                  <p className="text-caption text-apple-secondary">They'll see the request in their app</p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <Input label="From (address)" placeholder="0x... who should pay you" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} error={fromAddress && !fromAddress.match(/^0x[a-fA-F0-9]{40}$/) ? "Invalid Ethereum address" : undefined} />
                  {fromAddress && contacts.length > 0 && (
                    <div className="mt-1 bg-apple-gray6 border border-white/[0.06] rounded-xl overflow-hidden max-h-32 overflow-y-auto">
                      {contacts
                        .filter(c => c.nickname.toLowerCase().includes(fromAddress.toLowerCase()) || c.address.toLowerCase().includes(fromAddress.toLowerCase()))
                        .slice(0, 3)
                        .map(c => (
                          <button key={c.address} onClick={() => setFromAddress(c.address)} className="w-full text-left px-3 py-2 hover:bg-apple-gray5 text-sm flex items-center gap-2">
                            <span className="text-white">{c.nickname}</span>
                            <span className="text-xs font-mono text-apple-secondary">{c.address.slice(0, 8)}...</span>
                          </button>
                        ))
                      }
                    </div>
                  )}
                </div>
                <Input label="Amount (USDC)" placeholder="0.00" value={amount} onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setAmount(v); }} isAmount rightElement={<span className="text-xs font-semibold text-neutral-500 tracking-wider">USDC</span>} />
                <Input label="Reason" placeholder="Dinner split, rent, etc." value={note} onChange={(e) => setNote(e.target.value)} />
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  icon={<ArrowRight className="w-4 h-4" />}
                  onClick={handleCreateRequest}
                  loading={step === "encrypting" || step === "sending"}
                  disabled={!fromAddress || !amount || (!!fromAddress && !/^0x[a-fA-F0-9]{40}$/.test(fromAddress))}
                >
                  Send Request
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tab selector */}
      <div className="flex gap-1 bg-glass-surface border border-glass-border rounded-xl p-1">
        {(["incoming", "outgoing"] as TabType[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className="relative flex-1 py-2 text-sm font-medium rounded-lg transition-colors">
            {tab === t && (
              <motion.div layoutId="request-tab" className="absolute inset-0 bg-glass-hover border border-glass-border-hover rounded-lg"
                transition={{ type: "spring", stiffness: 400, damping: 30 }} />
            )}
            <span className={`relative z-10 ${tab === t ? "text-white" : "text-sm font-medium text-apple-secondary"}`}>
              {t === "incoming" ? `To Pay (${incoming.length})` : `Sent (${outgoing.length})`}
            </span>
          </button>
        ))}
      </div>

      {/* Request list */}
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-3">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="shimmer h-16 rounded-xl" style={{ animationDelay: `${i * 0.15}s` }} />)}
          </div>
        ) : requests.length > 0 ? (
          requests.map((req) => (
            <motion.div key={req.id} variants={fadeInUp}>
              <GlassCard variant="interactive" className="!rounded-2xl">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white">
                      {tab === "incoming" ? `Requested by: ${req.to_address.slice(0, 8)}...` : `Requesting from: ${req.from_address.slice(0, 8)}...`}
                    </p>
                    {req.note && <p className="text-caption text-apple-secondary truncate">{req.note}</p>}
                    <p className="text-caption text-neutral-600">{new Date(req.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`badge-${req.status === "pending" ? "warning" : req.status === "fulfilled" ? "success" : "error"}`}>
                      {req.status}
                    </span>

                    {/* Action buttons for pending requests */}
                    {req.status === "pending" && tab === "incoming" && (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          icon={<CreditCard className="w-3.5 h-3.5" />}
                          onClick={() => setPayingRequestId(payingRequestId === req.request_id ? null : req.request_id)}
                          loading={actionLoading === req.request_id && payingRequestId === req.request_id}
                        >
                          Pay
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Ban className="w-3.5 h-3.5" />}
                          onClick={() => handleDecline(req.request_id)}
                          loading={actionLoading === req.request_id && payingRequestId !== req.request_id}
                        >
                          Decline
                        </Button>
                      </>
                    )}

                    {req.status === "pending" && tab === "outgoing" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<X className="w-3.5 h-3.5" />}
                        onClick={() => handleCancel(req.request_id)}
                        loading={actionLoading === req.request_id}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>

                {/* Inline pay amount prompt */}
                <AnimatePresence>
                  {payingRequestId === req.request_id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-3 pt-3 border-t border-glass-border"
                    >
                      <p className="text-caption text-neutral-400 mb-2">
                        Enter the amount to pay (encrypted on-chain)
                      </p>
                      <div className="flex gap-2">
                        <Input
                          placeholder="0.00"
                          value={payAmount}
                          onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setPayAmount(v); }}
                          className="flex-1"
                          isAmount
                          rightElement={<span className="text-xs font-semibold text-neutral-500 tracking-wider">USDC</span>}
                        />
                        <Button
                          variant="primary"
                          size="md"
                          icon={<ArrowRight className="w-4 h-4" />}
                          onClick={() => handleFulfill(req.request_id)}
                          loading={actionLoading === req.request_id}
                          disabled={!payAmount}
                        >
                          Confirm
                        </Button>
                        <Button
                          variant="ghost"
                          size="md"
                          onClick={() => { setPayingRequestId(null); setPayAmount(""); }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </GlassCard>
            </motion.div>
          ))
        ) : (
          <motion.div variants={fadeInUp}>
            <GlassCard className="py-12">
              <div className="flex flex-col items-center justify-center">
                <div className="relative mb-6">
                  <motion.div
                    animate={{ scale: [1, 1.3, 1], opacity: [0.15, 0.05, 0.15] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute inset-0 rounded-2xl bg-accent/20"
                    style={{ filter: "blur(16px)" }}
                    aria-hidden="true"
                  />
                  <div className="relative w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}>
                      <MessageSquare className="w-8 h-8 text-text-muted" />
                    </motion.div>
                  </div>
                </div>
                <p className="text-heading-3 font-semibold text-text-secondary mb-1.5">
                  {tab === "incoming" ? "No pending requests" : "No sent requests"}
                </p>
                <p className="text-body text-text-muted text-center max-w-xs mb-6">
                  {tab === "incoming" ? "When someone requests money from you, it'll appear here" : "Create a request to start collecting payments"}
                </p>
                <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
                  {tab === "incoming" ? "Request a Payment" : "Create Your First Request"}
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}
