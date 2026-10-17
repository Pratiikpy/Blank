import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Receipt,
  DollarSign,
  Lock,
  FileText,
  CheckCircle2,
  Plus,
  X,
  Loader2,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/cn";
import { truncateAddress } from "@/lib/address";
import toast from "react-hot-toast";
import { isAddress } from "viem";
import { useBusinessHub } from "@/hooks/useBusinessHub";
import {
  PAYMENT_MODE,
  formatWait,
  secondsUntilOpenRelease,
  type InvoiceSettlementState,
} from "@/lib/invoice-settlement";
import { disputeTimeoutAt, escrowArbiterError, hasArbiter } from "@/lib/escrow-rules";
import { useOnChainBusinessRecords } from "@/hooks/useOnChainBusinessRecords";
import { toastMappedError } from "@/lib/error-messages";
import { EmptyState } from "@/components/common/EmptyState";
import { MILESTONE_TEMPLATES } from "@/lib/escrow-templates";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { CopyInvoiceLink } from "@/blank-ui/components/CopyInvoiceLink";
import {
  fetchVendorInvoices,
  fetchClientInvoices,
  fetchUserEscrows,
  type InvoiceRow,
  type EscrowRow,
} from "@/lib/supabase";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useRealtime } from "@/providers/RealtimeProvider";
import { log } from "@/lib/log";

const MAX_PAYROLL_SIZE = 30;
const INVOICE_PAGE_SIZE = 10;
const ESCROW_PAGE_SIZE = 10;

type TabValue = "invoices" | "payroll" | "escrow";
type EscrowFilter = "all" | "mine" | "arbitrating";

const getStatusBadge = (status: string) => {
  const styles: Record<string, string> = {
    paid: "bg-emerald-50 text-emerald-700 border-emerald-100",
    pending: "bg-amber-50 text-amber-700 border-amber-100",
    overdue: "bg-red-50 text-red-700 border-red-100",
    scheduled: "bg-blue-50 text-blue-700 border-blue-100",
    active: "bg-purple-50 text-purple-700 border-purple-100",
    completed: "bg-emerald-50 text-emerald-700 border-emerald-100",
    released: "bg-emerald-50 text-emerald-700 border-emerald-100",
    disputed: "bg-red-50 text-red-700 border-red-100",
    expired: "bg-gray-50 text-gray-700 border-gray-100",
    payment_pending: "bg-amber-50 text-amber-700 border-amber-100",
  };
  return styles[status] || "bg-gray-50 text-gray-700 border-gray-100";
};

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function BusinessTools() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChainId } = useChain();
  const {
    step,
    createInvoice,
    runPayroll,
    createEscrow,
    finalizeInvoice,
    refundDisputedInvoice,
    getInvoiceSettlement,
    getEscrowDisputedAt,
    markDelivered,
    approveRelease,
    disputeEscrow,
    claimDisputeTimeout,
    payInvoice,
    cancelInvoice,
    arbiterDecide,
    claimExpiredEscrow,
  } = useBusinessHub();
  const { activities } = useActivityFeed();
  const {
    invoices: onChainInvoices,
    escrows: onChainEscrows,
    refresh: refreshOnChainRecords,
  } = useOnChainBusinessRecords();
  const payrollActivities = useMemo(
    () => activities.filter((a) => a.activity_type === "payroll"),
    [activities],
  );

  const [activeTab, setActiveTab] = useState<TabValue>("invoices");
  const [escrowFilter, setEscrowFilter] = useState<EscrowFilter>("all");
  const [showModal, setShowModal] = useState(false);
  const [visibleInvoiceCount, setVisibleInvoiceCount] = useState(INVOICE_PAGE_SIZE);
  const [visibleEscrowCount, setVisibleEscrowCount] = useState(ESCROW_PAGE_SIZE);
  const { subscribe } = useRealtime();

  // Real data from Supabase. Merged below with what BusinessHub itself
  // reports, so neither list depends on the indexer being reachable.
  const [dbInvoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [dbEscrows, setEscrows] = useState<EscrowRow[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [confirmDisputeId, setConfirmDisputeId] = useState<number | null>(null);
  const [payInvoiceId, setPayInvoiceId] = useState<number | null>(null);
  const [payInvoiceAmount, setPayInvoiceAmount] = useState("");
  const [confirmCancelInvoiceId, setConfirmCancelInvoiceId] = useState<number | null>(null);
  const [confirmArbiterEscrow, setConfirmArbiterEscrow] = useState<{ id: number; release: boolean } | null>(null);
  const [confirmClaimExpiredId, setConfirmClaimExpiredId] = useState<number | null>(null);

  // Invoice form
  const [invoiceClient, setInvoiceClient] = useState("");
  const [invoiceClientEmail, setInvoiceClientEmail] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceDesc, setInvoiceDesc] = useState("");
  const [invoiceDueDays, setInvoiceDueDays] = useState("30");

  // Payroll form
  const [payAddresses, setPayAddresses] = useState("");
  const [payAmounts, setPayAmounts] = useState("");

  // Escrow form
  const [escrowBeneficiary, setEscrowBeneficiary] = useState("");
  const [escrowAmount, setEscrowAmount] = useState("");
  const [escrowDesc, setEscrowDesc] = useState("");
  const [escrowArbiter, setEscrowArbiter] = useState("");
  const [escrowDeadlineDays, setEscrowDeadlineDays] = useState("30");
  const [escrowTemplateId, setEscrowTemplateId] = useState("single");
  const [escrowFile, setEscrowFile] = useState<File | null>(null);

  const isProcessing =
    step === "approving" || step === "encrypting" || step === "sending" || step === "decrypting";

  // Load real data
  const loadData = useCallback(async () => {
    if (!address) return;
    setIsLoadingData(true);
    setDataError(null);
    try {
      const addr = address.toLowerCase();
      const [vendorInv, clientInv, userEscrows] = await Promise.all([
        fetchVendorInvoices(addr),
        fetchClientInvoices(addr),
        fetchUserEscrows(addr),
      ]);
      // Merge vendor and client invoices, deduplicate by id
      const allInvoices = [...vendorInv, ...clientInv];
      const seen = new Set<string>();
      const deduped = allInvoices.filter((inv) => {
        if (seen.has(inv.id)) return false;
        seen.add(inv.id);
        return true;
      });
      setInvoices(deduped);
      setEscrows(userEscrows);
    } catch (err) {
      log.warn("businessTools.loadData.failed", err instanceof Error ? err : new Error(String(err)));
      setDataError("Failed to load data. Tap to retry.");
    } finally {
      setIsLoadingData(false);
    }
  }, [address]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Supabase rows win on any invoice or escrow it knows about — they carry
  // fields the chain does not (client email, PDF CID, reminder state). The
  // chain fills the gaps, which is what makes an invoice payable and an
  // escrow actionable when the indexer is behind or unreachable. Without
  // this, a client named on a real on-chain invoice saw "No invoices yet"
  // and had no Pay button at all.
  // Status is the exception: the chain is the truth, so a Supabase row that
  // missed an update (a finalize from another device, a timed-out dispute)
  // still shows the right actions.
  const invoices = useMemo(() => {
    const chainById = new Map(onChainInvoices.map((i) => [i.invoice_id, i]));
    const known = new Set(dbInvoices.map((i) => i.invoice_id));
    const merged = dbInvoices.map((row) => {
      const chain = chainById.get(row.invoice_id);
      return chain && chain.status !== row.status && row.status !== "refunded"
        ? { ...row, status: chain.status }
        : row;
    });
    return [...merged, ...onChainInvoices.filter((i) => !known.has(i.invoice_id))];
  }, [dbInvoices, onChainInvoices]);

  const escrows = useMemo(() => {
    const chainById = new Map(onChainEscrows.map((e) => [e.escrow_id, e]));
    const known = new Set(dbEscrows.map((e) => e.escrow_id));
    const merged = dbEscrows.map((row) => {
      const chain = chainById.get(row.escrow_id);
      return chain && chain.status !== row.status ? { ...row, status: chain.status } : row;
    });
    return [...merged, ...onChainEscrows.filter((e) => !known.has(e.escrow_id))];
  }, [dbEscrows, onChainEscrows]);

  // Per-invoice payment mode for funded / disputed invoices, and the dispute
  // start for disputed escrows, so each row offers only the call the contract
  // accepts from this wallet right now.
  const [settlements, setSettlements] = useState<Record<number, InvoiceSettlementState>>({});
  const [disputedAt, setDisputedAt] = useState<Record<number, number>>({});
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

  const settlementKey = invoices
    .filter((i) => i.status === "payment_pending" || i.status === "disputed")
    .map((i) => `${i.invoice_id}:${i.status}`)
    .join(",");
  useEffect(() => {
    if (!settlementKey) return;
    let cancelled = false;
    const ids = settlementKey.split(",").map((k) => Number(k.split(":")[0]));
    void Promise.all(ids.map(async (id) => [id, await getInvoiceSettlement(id)] as const)).then((rows) => {
      if (cancelled) return;
      setSettlements((prev) => {
        const next = { ...prev };
        for (const [id, s] of rows) if (s) next[id] = s;
        return next;
      });
    });
    return () => { cancelled = true; };
    // getInvoiceSettlement is stable per chain; the key captures the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlementKey, step === "success"]);

  const disputedKey = escrows
    .filter((e) => e.status === "disputed")
    .map((e) => e.escrow_id)
    .join(",");
  useEffect(() => {
    if (!disputedKey) return;
    let cancelled = false;
    const ids = disputedKey.split(",").map(Number);
    void Promise.all(ids.map(async (id) => [id, await getEscrowDisputedAt(id)] as const)).then((rows) => {
      if (cancelled) return;
      setDisputedAt((prev) => {
        const next = { ...prev };
        for (const [id, at] of rows) if (at !== null) next[id] = at;
        return next;
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disputedKey]);

  // Reload data after successful operations. Re-read the chain too, so a
  // freshly created invoice or a payment that just mined shows its new status
  // without waiting on the indexer.
  useEffect(() => {
    if (step === "success") {
      loadData();
      refreshOnChainRecords();
    }
  }, [step, loadData, refreshOnChainRecords]);

  // Realtime: refetch escrows when this address is added/updated as arbiter,
  // depositor, or beneficiary. Without the arbiter subscription, Carol's
  // client never learns Alice named her as arbiter until a manual reload.
  useEffect(() => {
    if (!address) return;
    const addr = address.toLowerCase();
    const unsubs = [
      subscribe("escrows", { event: "INSERT", filter: { column: "arbiter_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "UPDATE", filter: { column: "arbiter_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "INSERT", filter: { column: "depositor_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "UPDATE", filter: { column: "depositor_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "INSERT", filter: { column: "beneficiary_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "UPDATE", filter: { column: "beneficiary_address", value: addr } }, () => loadData()),
    ];
    return () => { for (const u of unsubs) u(); };
  }, [address, subscribe, loadData]);

  const handleCreateInvoice = async () => {
    if (!invoiceClient || !invoiceAmount) { toast.error("Enter client address and amount"); return; }
    if (!isAddress(invoiceClient)) {
      toast.error("Invalid Ethereum address");
      return;
    }
    const trimmedEmail = invoiceClientEmail.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error("Client email looks invalid");
      return;
    }
    try {
      const dueDate = Math.floor(Date.now() / 1000) + parseInt(invoiceDueDays) * 86400;
      await createInvoice(
        invoiceClient,
        invoiceAmount,
        invoiceDesc || "Invoice",
        dueDate,
        trimmedEmail || undefined,
      );
      setShowModal(false);
      setInvoiceClient("");
      setInvoiceClientEmail("");
      setInvoiceAmount("");
      setInvoiceDesc("");
    } catch (err) {
      toastMappedError(err);
    }
  };

  // Phase 3.4: when the user picks a milestone template, prepend the
  // milestone label to the description so the on-chain note carries that
  // context. The on-chain Escrow struct is single-milestone, so for now
  // each template just suggests a label — multi-milestone escrows live
  // in the Wave 3 contract upgrade pass.
  const applyEscrowTemplate = useCallback((id: string) => {
    setEscrowTemplateId(id);
    if (id === "single") return;
    const tpl = MILESTONE_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const firstStep = tpl.splits[0]?.name ?? "Milestone";
    setEscrowDesc((prev) => {
      const stripped = prev.replace(/^\[[^\]]+\]\s*/, "");
      return `[${firstStep}] ${stripped}`.trim();
    });
  }, []);

  const handleRunPayroll = async () => {
    const addresses = payAddresses.split(",").map((a) => a.trim()).filter(Boolean);
    const amounts = payAmounts.split(",").map((a) => a.trim()).filter(Boolean);
    if (addresses.length === 0) { toast.error("Enter at least one employee address"); return; }
    if (addresses.length !== amounts.length) { toast.error("Number of addresses must match number of amounts"); return; }
    if (addresses.length > MAX_PAYROLL_SIZE) {
      toast.error(`Maximum ${MAX_PAYROLL_SIZE} employees per payroll batch`);
      return;
    }
    const invalidAddr = addresses.find((a) => !isAddress(a));
    if (invalidAddr) {
      toast.error(`Invalid address: ${invalidAddr}`);
      return;
    }
    try {
      await runPayroll(addresses, amounts);
      setShowModal(false);
      setPayAddresses("");
      setPayAmounts("");
    } catch (err) {
      toastMappedError(err);
    }
  };

  const handleCreateEscrowReset = () => {
    setEscrowBeneficiary("");
    setEscrowAmount("");
    setEscrowDesc("");
    setEscrowArbiter("");
    setEscrowTemplateId("single");
    setEscrowFile(null);
  };

  const handleCreateEscrow = async () => {
    if (!escrowBeneficiary || !escrowAmount) { toast.error("Enter beneficiary address and amount"); return; }
    if (!isAddress(escrowBeneficiary)) {
      toast.error("Invalid beneficiary address");
      return;
    }
    if (escrowArbiter && !isAddress(escrowArbiter)) {
      toast.error("Invalid arbiter address");
      return;
    }
    const arbiterErr = escrowArbiterError(escrowArbiter, address ?? "", escrowBeneficiary);
    if (arbiterErr) {
      toast.error(arbiterErr);
      return;
    }
    try {
      const deadline = Math.floor(Date.now() / 1000) + parseInt(escrowDeadlineDays) * 86400;
      await createEscrow(
        escrowBeneficiary,
        escrowAmount,
        escrowDesc || "Escrow",
        escrowArbiter,
        deadline,
        escrowFile,
      );
      setShowModal(false);
      handleCreateEscrowReset();
    } catch (err) {
      toastMappedError(err);
    }
  };

  const handleFinalizeInvoice = async (invoiceId: number) => {
    await finalizeInvoice(invoiceId);
  };

  const handleRefundDisputed = async (invoiceId: number) => {
    await refundDisputedInvoice(invoiceId);
  };

  const handleClaimDisputeTimeout = async (escrowId: number) => {
    await claimDisputeTimeout(escrowId);
    loadData();
  };

  const handlePayInvoice = async () => {
    if (payInvoiceId === null || !payInvoiceAmount) return;
    try {
      await payInvoice(payInvoiceId, payInvoiceAmount);
      setPayInvoiceId(null);
      setPayInvoiceAmount("");
    } catch (err) {
      toastMappedError(err);
    }
  };

  const handleCancelInvoice = async (invoiceId: number) => {
    try {
      await cancelInvoice(invoiceId);
      setConfirmCancelInvoiceId(null);
      loadData();
    } catch (err) {
      toastMappedError(err);
    }
  };

  const handleArbiterDecide = async (escrowId: number, release: boolean) => {
    try {
      await arbiterDecide(escrowId, release);
      setConfirmArbiterEscrow(null);
      loadData();
    } catch (err) {
      toastMappedError(err);
    }
  };

  const handleClaimExpired = async (escrowId: number) => {
    try {
      await claimExpiredEscrow(escrowId);
      setConfirmClaimExpiredId(null);
      loadData();
    } catch (err) {
      toastMappedError(err);
    }
  };

  const handleReleaseFunds = async (escrowId: number) => {
    // Route by role: beneficiary marks delivered; depositor (after
    // delivery) approves the release. Calling both unconditionally breaks
    // the depositor path — markDelivered reverts with "not beneficiary".
    const escrow = escrows.find((e) => e.escrow_id === escrowId);
    if (!escrow || !address) {
      toast.error("Escrow not found");
      return;
    }
    const me = address.toLowerCase();
    const isBeneficiary = escrow.beneficiary_address?.toLowerCase() === me;
    const isDepositor = escrow.depositor_address?.toLowerCase() === me;
    try {
      if (isBeneficiary) {
        await markDelivered(escrowId);
      } else if (isDepositor) {
        await approveRelease(escrowId);
      } else {
        toast.error("You are neither beneficiary nor depositor of this escrow");
        return;
      }
      loadData();
    } catch (err) {
      toastMappedError(err);
    }
  };

  const handleDisputeEscrow = async (escrowId: number) => {
    try {
      await disputeEscrow(escrowId);
      setConfirmDisputeId(null);
      loadData();
    } catch (err) {
      toastMappedError(err);
    }
  };

  const tabs: { id: TabValue; label: string; icon: typeof Receipt }[] = [
    { id: "invoices", label: "Invoices", icon: Receipt },
    { id: "payroll", label: "Payroll", icon: DollarSign },
    { id: "escrow", label: "Escrow", icon: Lock },
  ];

  // Filter escrows by user role (mine = depositor/beneficiary,
  // arbitrating = named as arbiter). "all" returns every row the user can see.
  const filteredEscrows = useMemo(() => {
    if (!address) return escrows;
    const addr = address.toLowerCase();
    if (escrowFilter === "mine") {
      return escrows.filter(
        (e) =>
          e.depositor_address.toLowerCase() === addr ||
          e.beneficiary_address.toLowerCase() === addr,
      );
    }
    if (escrowFilter === "arbitrating") {
      return escrows.filter(
        (e) => e.arbiter_address && e.arbiter_address.toLowerCase() === addr,
      );
    }
    return escrows;
  }, [escrows, escrowFilter, address]);

  const arbitratingCount = useMemo(() => {
    if (!address) return 0;
    const addr = address.toLowerCase();
    return escrows.filter(
      (e) => e.arbiter_address && e.arbiter_address.toLowerCase() === addr,
    ).length;
  }, [escrows, address]);

  const formatDate = (iso: string | null) => {
    if (!iso) return "No date";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  // #216: due-dates / deadlines must read identically across timezones for
  // both parties (vendor + client, depositor + arbiter). The naive
  // `toLocaleDateString` shows each viewer their own day boundary, which
  // means "due today" can disagree by 24h between Tokyo and LA. We render
  // a relative phrase ("in 2 days", "5 hours ago") + the canonical UTC
  // absolute timestamp so both sides always have a shared reference.
  const formatDeadline = (iso: string | null): string => {
    if (!iso) return "No deadline";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "Invalid date";
    const relative = formatDistanceToNowStrict(d, { addSuffix: true });
    const utc = d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
    return `${relative} (${utc} UTC)`;
  };

  const truncateAddr = truncateAddress;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Business Tools
          </h1>
          <p className="text-sm sm:text-base text-[var(--text-primary)]/50 leading-relaxed">
            Manage invoices, payroll, and escrow with financial privacy
          </p>
        </div>

        {/* Step Indicator */}
        {isProcessing && (
          <div className="mb-6 p-4 rounded-2xl bg-amber-50 border border-amber-100 flex items-center gap-3">
            <Loader2 size={20} className="text-amber-600 animate-spin" />
            <p className="text-sm font-medium text-amber-900">
              {step === "approving" && "Approving vault access..."}
              {step === "encrypting" && "Encrypting amounts with FHE..."}
              {step === "sending" && "Submitting transaction..."}
              {step === "decrypting" && "Waiting for the decrypted check from the threshold network..."}
            </p>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex gap-3 mb-6 overflow-x-auto" role="tablist" aria-label="Business tools tabs">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              role="tab"
              aria-selected={activeTab === id}
              aria-label={label}
              className={cn(
                "flex items-center gap-2 h-12 px-6 rounded-2xl font-medium transition-all whitespace-nowrap",
                activeTab === id
                  ? "bg-[var(--text-primary)] text-white"
                  : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80",
              )}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Invoices Tab */}
        {activeTab === "invoices" && (
          <div className="space-y-6">
            <div className="flex justify-end">
              <button
                onClick={() => setShowModal(true)}
                className="h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
              >
                <Plus size={20} />
                <span>New Invoice</span>
              </button>
            </div>

            <div className="rounded-[2rem] glass-card p-4 sm:p-8">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">Recent Invoices</h3>

              {isLoadingData ? (
                <div className="flex items-center justify-center py-8 gap-3">
                  <Loader2 size={24} className="animate-spin text-[var(--text-primary)]/40" />
                  <span className="text-[var(--text-primary)]/50">Loading invoices...</span>
                </div>
              ) : dataError && invoices.length === 0 ? (
                <button onClick={loadData} className="w-full text-center py-8 text-red-500 hover:bg-red-50/50 rounded-2xl transition-colors">
                  <AlertTriangle size={40} className="mx-auto mb-3 opacity-60" />
                  <p className="font-medium mb-1">{dataError}</p>
                </button>
              ) : invoices.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  tone="slate"
                  title="No invoices yet"
                  body="Send your first private invoice. Amounts stay encrypted on-chain. Only you and your client see them."
                  cta={{ label: "Create your first invoice", onClick: () => setShowModal(true) }}
                />
              ) : (
                <div className="space-y-3">
                  {/* The indexer failed but the chain answered. Show what we
                      have and say the list may be short, rather than replacing
                      a payable invoice with a retry button. */}
                  {dataError && (
                    <button
                      onClick={loadData}
                      className="w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm text-amber-800 transition-colors hover:bg-amber-100"
                    >
                      Showing invoices read from the chain. Some details may be missing. Tap to retry.
                    </button>
                  )}
                  {invoices.slice(0, visibleInvoiceCount).map((invoice) => (
                    <div
                      key={invoice.id}
                      className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 sm:p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 hover:bg-white/70 transition-all"
                    >
                      <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                        <div className="w-12 h-12 rounded-xl bg-[#007AFF]/10 flex items-center justify-center shrink-0">
                          <FileText size={24} className="text-[#007AFF]" />
                        </div>
                        <div className="min-w-0">
                          {/* Show the other party. This always printed the
                              client, which reads as your own address when you
                              are the one being billed. Nobody noticed while
                              clients could not see their invoices at all. */}
                          <p className="font-medium text-[var(--text-primary)] truncate">
                            {invoice.client_address?.toLowerCase() === address?.toLowerCase()
                              ? `From ${truncateAddr(invoice.vendor_address)}`
                              : `To ${truncateAddr(invoice.client_address)}`}
                          </p>
                          <p className="text-sm text-[var(--text-primary)]/50">
                            {/* An invoice read from the chain has no creation
                                date, and "No date · Due in 30 days" reads as a
                                bug. Drop the half we do not have. */}
                            {invoice.created_at && `${formatDate(invoice.created_at)} · `}
                            Due {formatDeadline(invoice.due_date)}
                          </p>
                          {invoice.description && <p className="text-xs text-[var(--text-primary)]/40 truncate">{invoice.description}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 sm:gap-4 justify-between sm:justify-end">
                        <div className="text-right">
                          <p className="text-lg font-heading font-medium encrypted-text">
                            ${"\u2022\u2022\u2022\u2022\u2022.\u2022\u2022"}
                          </p>
                          <div className={cn("inline-flex px-2 py-1 rounded-full text-xs font-medium border", getStatusBadge(invoice.status))}>
                            {invoice.status}
                          </div>
                        </div>
                        {invoice.status === "pending" && invoice.client_address?.toLowerCase() === address?.toLowerCase() && (
                          <button
                            onClick={() => setPayInvoiceId(invoice.invoice_id)}
                            disabled={isProcessing}
                            className="h-10 px-4 rounded-xl bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                          >
                            Pay
                          </button>
                        )}
                        {invoice.status === "pending" && invoice.vendor_address?.toLowerCase() === address?.toLowerCase() && (
                          <>
                            {/* PR-C step 3: shareable invoice link → public escrow page */}
                            <CopyInvoiceLink
                              chainId={activeChainId}
                              invoiceId={invoice.invoice_id}
                              variant="icon"
                            />
                            {/* PR-D: vendor preview — open the same link
                                the client sees, in a new tab. */}
                            <a
                              href={`/app/invoice/${activeChainId}/${invoice.invoice_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Preview public invoice page"
                              data-testid={`invoice-preview-${invoice.invoice_id}`}
                              className="h-9 w-9 rounded-lg flex items-center justify-center bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-[var(--text-primary)] transition-colors"
                            >
                              <ExternalLink size={14} />
                            </a>
                            <button
                              onClick={() => setConfirmCancelInvoiceId(invoice.invoice_id)}
                              disabled={isProcessing}
                              className="h-10 px-4 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-all active:scale-95 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        {(() => {
                          const me = address?.toLowerCase();
                          const isClientRow = invoice.client_address?.toLowerCase() === me;
                          const isVendorRow = invoice.vendor_address?.toLowerCase() === me;
                          const s = settlements[invoice.invoice_id];
                          if (invoice.status === "payment_pending") {
                            if (isClientRow) {
                              return (
                                <button
                                  onClick={() => handleFinalizeInvoice(invoice.invoice_id)}
                                  disabled={isProcessing}
                                  data-testid={`invoice-finalize-${invoice.invoice_id}`}
                                  className="h-10 px-4 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                                >
                                  {isProcessing && <Loader2 size={14} className="animate-spin" />}
                                  Finalize
                                </button>
                              );
                            }
                            if (!isVendorRow || !s) return null;
                            // Escrowed (or a pre-mode payment the vendor
                            // settles): the vendor may finalize once allowed.
                            const vendorCan =
                              s.mode === PAYMENT_MODE.Escrow
                                ? secondsUntilOpenRelease(s.paidAt, nowSeconds) === 0
                                : s.mode === PAYMENT_MODE.Legacy;
                            if (vendorCan) {
                              return (
                                <button
                                  onClick={() => handleFinalizeInvoice(invoice.invoice_id)}
                                  disabled={isProcessing}
                                  data-testid={`invoice-vendor-release-${invoice.invoice_id}`}
                                  className="h-10 px-4 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                                >
                                  {isProcessing && <Loader2 size={14} className="animate-spin" />}
                                  {s.mode === PAYMENT_MODE.Escrow ? "Release payment" : "Finalize"}
                                </button>
                              );
                            }
                            return (
                              <span className="text-xs text-[var(--text-primary)]/50 max-w-[12rem] text-right" data-testid={`invoice-wait-${invoice.invoice_id}`}>
                                {s.mode === PAYMENT_MODE.Escrow
                                  ? `Client finalizes. You can release in ${formatWait(secondsUntilOpenRelease(s.paidAt, nowSeconds))}.`
                                  : "Waiting for the client to finalize."}
                              </span>
                            );
                          }
                          if (invoice.status === "disputed") {
                            if (isVendorRow) {
                              return (
                                <button
                                  onClick={() => handleRefundDisputed(invoice.invoice_id)}
                                  disabled={isProcessing}
                                  data-testid={`invoice-refund-${invoice.invoice_id}`}
                                  className="h-10 px-4 rounded-xl bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                                >
                                  {isProcessing && <Loader2 size={14} className="animate-spin" />}
                                  {s?.refundPending ? "Confirm refund" : "Refund client"}
                                </button>
                              );
                            }
                            if (isClientRow) {
                              return (
                                <span className="text-xs text-[var(--text-primary)]/50 max-w-[12rem] text-right">
                                  Amount did not match. The vendor refunds what they received.
                                </span>
                              );
                            }
                          }
                          return null;
                        })()}
                      </div>
                    </div>
                  ))}
                  {visibleInvoiceCount < invoices.length && (
                    <button
                      onClick={() => setVisibleInvoiceCount((c) => c + INVOICE_PAGE_SIZE)}
                      className="w-full h-12 rounded-2xl bg-white/50 border border-black/5 text-sm font-medium text-[var(--text-secondary)] hover:bg-white/70 transition-all mt-3"
                    >
                      Load more ({invoices.length - visibleInvoiceCount} remaining)
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Payroll Tab */}
        {activeTab === "payroll" && (
          <div className="space-y-6">
            <div className="flex justify-end">
              <button
                onClick={() => setShowModal(true)}
                className="h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
              >
                <Plus size={20} />
                <span>Run Payroll</span>
              </button>
            </div>

            <div className="rounded-[2rem] glass-card p-4 sm:p-8">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">Payroll</h3>
              <EmptyState
                icon={DollarSign}
                tone="emerald"
                title="Run encrypted payroll"
                body="Send salaries to multiple employees in a single transaction. Each amount is FHE-encrypted client-side. Every employee only sees their own pay. Upload a CSV or paste a list."
                cta={{ label: "Run Payroll", onClick: () => setShowModal(true) }}
              />
            </div>
            <div className={cn("rounded-[2rem] glass-card p-4 sm:p-8", payrollActivities.length === 0 && "hidden")}>

              {/* Payroll History */}
              {payrollActivities.length > 0 && (
                <div className="mt-6">
                  <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-3">
                    Payroll History
                  </p>
                  {payrollActivities.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 mb-2"
                    >
                      <span className="text-sm text-[var(--text-primary)]">
                        {a.note || "Payroll"}
                      </span>
                      <span className="text-xs text-[var(--text-tertiary)]">
                        {new Date(a.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Escrow Tab */}
        {activeTab === "escrow" && (
          <div className="space-y-6">
            {/* #342 honesty banner: BusinessHub escrow deposits are plain
                ERC20 transfers. The encrypted path in the app is the
                conditional invoice on EncryptedEscrow. */}
            <div
              role="note"
              className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm"
            >
              <div className="font-medium text-amber-700">
                Heads up: escrow amounts here are public on chain.
              </div>
              <div className="mt-1 text-[var(--text-primary)]/70">
                The deposit is a plain token transfer anyone can read. For an
                encrypted amount, use a
                {" "}
                <a href="/app/conditional-invoices" className="underline decoration-amber-500/40 underline-offset-2 hover:decoration-amber-500">
                  conditional invoice
                </a>
                {" "}
                (Arbitrum Sepolia).
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-center justify-between">
              {/* Role filter: "All" / "Mine" / "Arbitrating" */}
              <div className="flex gap-2" role="tablist" aria-label="Escrow role filter">
                {(["all", "mine", "arbitrating"] as EscrowFilter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setEscrowFilter(f)}
                    role="tab"
                    aria-selected={escrowFilter === f}
                    className={cn(
                      "h-10 px-4 rounded-2xl text-sm font-medium transition-all whitespace-nowrap",
                      escrowFilter === f
                        ? "bg-[var(--text-primary)] text-white"
                        : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80",
                    )}
                  >
                    {f === "all" ? "All" : f === "mine" ? "Mine" : "Arbitrating"}
                    {f === "arbitrating" && arbitratingCount > 0 && (
                      <span className={cn(
                        "ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-xs font-semibold",
                        escrowFilter === f ? "bg-white/20 text-white" : "bg-purple-100 text-purple-700",
                      )}>
                        {arbitratingCount}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowModal(true)}
                className="h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
              >
                <Plus size={20} />
                <span>New Escrow</span>
              </button>
            </div>

            {isLoadingData ? (
              <div className="flex items-center justify-center py-8 gap-3">
                <Loader2 size={24} className="animate-spin text-[var(--text-primary)]/40" />
                <span className="text-[var(--text-primary)]/50">Loading escrows...</span>
              </div>
            ) : dataError && filteredEscrows.length === 0 ? (
              <div className="rounded-[2rem] glass-card p-4 sm:p-8">
                <button onClick={loadData} className="w-full text-center py-8 text-red-500 hover:bg-red-50/50 rounded-2xl transition-colors">
                  <AlertTriangle size={40} className="mx-auto mb-3 opacity-60" />
                  <p className="font-medium mb-1">{dataError}</p>
                </button>
              </div>
            ) : filteredEscrows.length === 0 ? (
              <div className="rounded-[2rem] glass-card p-4 sm:p-8">
                <div className="text-center py-8 text-[var(--text-primary)]/40">
                  <Lock size={40} className="mx-auto mb-3 opacity-30" />
                  <p className="font-medium mb-1">
                    {escrowFilter === "arbitrating"
                      ? "No escrows to arbitrate"
                      : escrowFilter === "mine"
                        ? "No escrows you created or are receiving"
                        : "No escrows yet"}
                  </p>
                  <p className="text-sm">
                    {escrowFilter === "arbitrating"
                      ? "You'll see escrows here when someone names you as their arbiter"
                      : "Create your first escrow to get started"}
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {filteredEscrows.slice(0, visibleEscrowCount).map((escrow) => {
                  const isArbiter =
                    !!address &&
                    !!escrow.arbiter_address &&
                    escrow.arbiter_address.toLowerCase() === address.toLowerCase();
                  return (
                  <div
                    key={escrow.id}
                    className="rounded-[2rem] glass-card p-4 sm:p-8 hover:-translate-y-1 transition-all duration-300"
                  >
                    <div className="flex items-start justify-between mb-6">
                      <div>
                        <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-1">{escrow.description}</h3>
                        <p className="text-sm text-[var(--text-primary)]/50">
                          Beneficiary: {truncateAddr(escrow.beneficiary_address)}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          <div className={cn("inline-flex px-2 py-1 rounded-full text-xs font-medium border", getStatusBadge(escrow.status))}>
                            {escrow.status}
                          </div>
                          {isArbiter && (
                            <div className="inline-flex px-2 py-1 rounded-full text-xs font-medium border bg-purple-50 text-purple-700 border-purple-100">
                              You are arbiter
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center">
                        <Lock size={24} className="text-purple-600" />
                      </div>
                    </div>

                    <div className="p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 mb-4">
                      <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-1">Escrow Amount</p>
                      <p className="text-2xl font-heading font-medium encrypted-text">
                        ${"\u2022\u2022\u2022\u2022\u2022\u2022.\u2022\u2022"}
                      </p>
                    </div>

                    <div className="text-sm text-[var(--text-primary)]/50">
                      <p>Deadline: {formatDeadline(escrow.deadline)}</p>
                      {escrow.arbiter_address && escrow.arbiter_address !== "" && (
                        <p>Arbiter: {truncateAddr(escrow.arbiter_address)}</p>
                      )}
                    </div>

                    {escrow.status === "active" && (
                      <div className="flex gap-2 mt-4">
                        <button
                          onClick={() => handleReleaseFunds(escrow.escrow_id)}
                          disabled={isProcessing}
                          className="h-10 px-4 rounded-xl bg-emerald-50 text-emerald-600 text-sm font-medium hover:bg-emerald-100 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                        >
                          {isProcessing && <Loader2 size={14} className="animate-spin" />}
                          Release Funds
                        </button>
                        {/* A dispute needs an arbiter to decide it. Without
                            one the deadline refund is the exit. */}
                        {hasArbiter(escrow.arbiter_address) && (
                          <button
                            onClick={() => setConfirmDisputeId(escrow.escrow_id)}
                            disabled={isProcessing}
                            className="h-10 px-4 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-all active:scale-95 disabled:opacity-50"
                          >
                            Dispute
                          </button>
                        )}
                      </div>
                    )}

                    {escrow.status === "disputed" && (() => {
                      const at = disputedAt[escrow.escrow_id];
                      const deadlineSec = escrow.deadline ? Math.floor(new Date(escrow.deadline).getTime() / 1000) : 0;
                      if (at === undefined || (!at && !deadlineSec)) return null;
                      const opensAt = disputeTimeoutAt(at, deadlineSec);
                      if (nowSeconds >= opensAt) {
                        return (
                          <button
                            onClick={() => handleClaimDisputeTimeout(escrow.escrow_id)}
                            disabled={isProcessing}
                            data-testid={`escrow-dispute-timeout-${escrow.escrow_id}`}
                            className="h-10 px-4 rounded-xl bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-all active:scale-95 disabled:opacity-50 mt-4 flex items-center gap-1"
                          >
                            {isProcessing && <Loader2 size={14} className="animate-spin" />}
                            Return to depositor (dispute timed out)
                          </button>
                        );
                      }
                      return (
                        <p className="text-xs text-[var(--text-primary)]/50 mt-4">
                          If the arbiter does not decide, the deposit returns to the depositor in{" "}
                          {formatWait(opensAt - nowSeconds)}.
                        </p>
                      );
                    })()}

                    {escrow.status === "released" && (
                      <div className="mt-4 flex items-center justify-center gap-2 text-emerald-600">
                        <CheckCircle2 size={20} />
                        <span className="text-sm font-medium">Released</span>
                      </div>
                    )}

                    {escrow.status === "disputed" && !!address && escrow.arbiter_address?.toLowerCase() === address.toLowerCase() && (
                      <div className="flex gap-2 mt-4">
                        <button
                          onClick={() => setConfirmArbiterEscrow({ id: escrow.escrow_id, release: true })}
                          disabled={isProcessing}
                          className="h-10 px-4 rounded-xl bg-emerald-50 text-emerald-600 text-sm font-medium hover:bg-emerald-100 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                        >
                          Release to Beneficiary
                        </button>
                        <button
                          onClick={() => setConfirmArbiterEscrow({ id: escrow.escrow_id, release: false })}
                          disabled={isProcessing}
                          className="h-10 px-4 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-all active:scale-95 disabled:opacity-50"
                        >
                          Return to Depositor
                        </button>
                      </div>
                    )}

                    {escrow.status === "active" && !!address && escrow.depositor_address?.toLowerCase() === address.toLowerCase() && escrow.deadline && new Date(escrow.deadline).getTime() < Date.now() && (
                      <button
                        onClick={() => setConfirmClaimExpiredId(escrow.escrow_id)}
                        disabled={isProcessing}
                        className="h-10 px-4 rounded-xl bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-all active:scale-95 disabled:opacity-50 mt-4 flex items-center gap-1"
                      >
                        Claim Expired
                      </button>
                    )}
                  </div>
                  );
                })}
                {visibleEscrowCount < filteredEscrows.length && (
                  <div className="col-span-full">
                    <button
                      onClick={() => setVisibleEscrowCount((c) => c + ESCROW_PAGE_SIZE)}
                      className="w-full h-12 rounded-2xl bg-white/50 border border-black/5 text-sm font-medium text-[var(--text-secondary)] hover:bg-white/70 transition-all mt-3"
                    >
                      Load more ({filteredEscrows.length - visibleEscrowCount} remaining)
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)]">
                {activeTab === "invoices" ? "New Invoice" : activeTab === "payroll" ? "Run Payroll" : "New Escrow"}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-2 hover:bg-black/5 rounded-xl" aria-label="Close">
                <X size={24} className="text-[var(--text-primary)]/50" />
              </button>
            </div>

            {activeTab === "invoices" && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Client Wallet Address</label>
                  <input type="text" value={invoiceClient} onChange={(e) => setInvoiceClient(e.target.value)} placeholder="0x..." className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Client Email (optional)</label>
                  <input type="email" value={invoiceClientEmail} onChange={(e) => setInvoiceClientEmail(e.target.value)} placeholder="client@company.com" className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none text-sm" />
                  <p className="text-xs text-[var(--text-primary)]/40 mt-2">Adds a PDF invoice to your client's inbox with a one-click pay link.</p>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Amount (USDC)</label>
                  <div className="relative">
                    <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
                    <input type="number" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} placeholder="0.00" className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none text-lg" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Description</label>
                  <input type="text" value={invoiceDesc} onChange={(e) => setInvoiceDesc(e.target.value)} placeholder="Services rendered" className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Due in (days)</label>
                  <select value={invoiceDueDays} onChange={(e) => setInvoiceDueDays(e.target.value)} className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none">
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="60">60 days</option>
                    <option value="90">90 days</option>
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setShowModal(false)} className="flex-1 h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium">Cancel</button>
                  <button
                    onClick={handleCreateInvoice}
                    disabled={!invoiceClient || !invoiceAmount || isProcessing}
                    className="flex-1 h-14 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} />}
                    {isProcessing ? "Creating..." : "Create Invoice"}
                  </button>
                </div>
              </div>
            )}

            {activeTab === "payroll" && (
              <div className="space-y-4">
                {/* Wave 4 #256 — drag-drop CSV upload that fills the comma-list
                    fields below. CSV format: one row per employee,
                    `address,amount` (header row optional). Comments OK. */}
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">
                    Upload CSV (optional)
                  </label>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => {
                        const text = String(reader.result ?? "");
                        const rows = text.split(/\r?\n/)
                          .map((l) => l.trim())
                          .filter((l) => l.length > 0 && !l.startsWith("#"));
                        // Skip header if first cell is non-hex/non-numeric
                        const firstFirstCell = rows[0]?.split(",")[0]?.trim() ?? "";
                        const startsWithHeader = !firstFirstCell.startsWith("0x") && !/^[0-9.]/.test(firstFirstCell);
                        const dataRows = startsWithHeader ? rows.slice(1) : rows;
                        const addrs: string[] = [];
                        const amts: string[] = [];
                        for (const row of dataRows) {
                          const [a, amt] = row.split(",").map((s) => s.trim());
                          if (a && amt) {
                            addrs.push(a);
                            amts.push(amt);
                          }
                        }
                        if (addrs.length === 0) {
                          toast.error("CSV had no valid rows");
                          return;
                        }
                        setPayAddresses(addrs.join(", "));
                        setPayAmounts(amts.join(", "));
                        toast.success(`Loaded ${addrs.length} row${addrs.length === 1 ? "" : "s"} from CSV`);
                      };
                      reader.readAsText(file);
                      // reset input so re-selecting the same file fires onChange
                      e.target.value = "";
                    }}
                    className="block w-full text-sm text-[var(--text-secondary)] file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-medium file:bg-[var(--surface-2)] file:text-[var(--text-primary)] hover:file:bg-[var(--surface-3)] cursor-pointer"
                  />
                  <p className="text-xs text-[var(--text-tertiary)] mt-2">
                    One row per employee: <code className="font-mono">address,amount</code>. Header row optional.
                  </p>
                </div>

                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Employee Addresses (comma-separated)</label>
                  <textarea
                    value={payAddresses}
                    onChange={(e) => setPayAddresses(e.target.value)}
                    placeholder="0xabc..., 0xdef..., 0x123..."
                    rows={3}
                    className="w-full px-5 py-4 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none font-mono text-sm resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Amounts in USDC (comma-separated, same order)</label>
                  <textarea
                    value={payAmounts}
                    onChange={(e) => setPayAmounts(e.target.value)}
                    placeholder="5000, 8000, 3500"
                    rows={2}
                    className="w-full px-5 py-4 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none resize-none"
                  />
                </div>
                {/* Live preview */}
                {(() => {
                  const addrs = payAddresses.split(",").map((s) => s.trim()).filter(Boolean);
                  const amts = payAmounts.split(",").map((s) => s.trim()).filter(Boolean);
                  const rows = Math.max(addrs.length, amts.length);
                  if (rows === 0) return null;
                  return (
                    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
                      <div className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)] border-b border-[var(--border)] flex justify-between">
                        <span>Preview ({rows} {rows === 1 ? "employee" : "employees"})</span>
                        <span>{addrs.length === amts.length ? "✓ counts match" : "✗ count mismatch"}</span>
                      </div>
                      <div className="max-h-48 overflow-y-auto divide-y divide-[var(--border)]">
                        {Array.from({ length: rows }).map((_, i) => {
                          const a = addrs[i] ?? "(missing)";
                          const amt = amts[i] ?? "(missing)";
                          const valid = !!addrs[i] && !!amts[i] && isAddress(addrs[i]);
                          return (
                            <div key={i} className="flex items-center justify-between px-4 py-2 text-xs font-mono">
                              <span className={cn("truncate", !valid && "text-amber-600")}>{a}</span>
                              <span className="ml-3 tabular-nums">{amt} USDC</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
                <div className="p-4 rounded-2xl bg-blue-50 border border-blue-100 text-sm text-blue-700">
                  Each amount will be individually encrypted with FHE before sending. Employees only see their own salary.
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setShowModal(false)} className="flex-1 h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium">Cancel</button>
                  <button
                    onClick={handleRunPayroll}
                    disabled={!payAddresses || !payAmounts || isProcessing}
                    className="flex-1 h-14 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <DollarSign size={20} />}
                    {isProcessing ? "Processing..." : "Run Payroll"}
                  </button>
                </div>
              </div>
            )}

            {activeTab === "escrow" && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Milestone template</label>
                  <select
                    value={escrowTemplateId}
                    onChange={(e) => applyEscrowTemplate(e.target.value)}
                    className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none"
                  >
                    {MILESTONE_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-[var(--text-primary)]/40 mt-2">
                    {MILESTONE_TEMPLATES.find((t) => t.id === escrowTemplateId)?.description}
                  </p>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Beneficiary Address</label>
                  <input type="text" value={escrowBeneficiary} onChange={(e) => setEscrowBeneficiary(e.target.value)} placeholder="0x..." className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Escrow Amount (USDC)</label>
                  <div className="relative">
                    <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
                    <input type="number" value={escrowAmount} onChange={(e) => setEscrowAmount(e.target.value)} placeholder="0.00" className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none text-lg" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Description</label>
                  <input type="text" value={escrowDesc} onChange={(e) => setEscrowDesc(e.target.value)} placeholder="Project milestone" className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Arbiter Address (optional)</label>
                  <input type="text" value={escrowArbiter} onChange={(e) => setEscrowArbiter(e.target.value)} placeholder="0x... (leave empty for no arbiter)" className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none font-mono text-sm" />
                  {(() => {
                    const err = isAddress(escrowArbiter.trim())
                      ? escrowArbiterError(escrowArbiter, address ?? "", escrowBeneficiary)
                      : null;
                    return err ? (
                      <p className="text-xs text-red-600 mt-2" data-testid="escrow-arbiter-error">{err}</p>
                    ) : (
                      <p className="text-xs text-[var(--text-primary)]/40 mt-2">
                        A third party who decides disputes. Without one, disputes are off and the deadline refund is the exit.
                      </p>
                    );
                  })()}
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Deadline (days from now)</label>
                  <select value={escrowDeadlineDays} onChange={(e) => setEscrowDeadlineDays(e.target.value)} className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none">
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="60">60 days</option>
                    <option value="90">90 days</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Attachment (optional)</label>
                  <input
                    type="file"
                    accept="application/pdf,image/*,.txt,.md,.docx"
                    onChange={(e) => setEscrowFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-[var(--text-primary)]/70 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:bg-black/5 file:text-[var(--text-primary)] file:font-medium hover:file:bg-black/10"
                  />
                  <p className="text-xs text-[var(--text-primary)]/40 mt-2">
                    Project brief, contract, or deliverable spec. Pinned to IPFS, anchored to this escrow.
                  </p>
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setShowModal(false)} className="flex-1 h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium">Cancel</button>
                  <button
                    onClick={handleCreateEscrow}
                    disabled={!escrowBeneficiary || !escrowAmount || isProcessing}
                    className="flex-1 h-14 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} />}
                    {isProcessing ? "Creating..." : "Create Escrow"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dispute Confirmation Dialog */}
      {confirmDisputeId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center">
                <AlertTriangle size={28} className="text-red-500" />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Dispute Escrow?</h3>
              <p className="text-sm text-[var(--text-primary)]/60">
                This cannot be undone. The arbiter decides who gets the funds. If they do not decide within 30 days, the deposit returns to the depositor.
              </p>
              <div className="flex gap-3 w-full pt-2">
                <button
                  onClick={() => setConfirmDisputeId(null)}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDisputeEscrow(confirmDisputeId)}
                  disabled={isProcessing}
                  className="flex-1 h-12 rounded-2xl bg-red-500 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Confirm Dispute
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pay Invoice Dialog */}
      {payInvoiceId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm overflow-y-auto">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-6 sm:p-8 my-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col gap-4">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Pay Invoice #{payInvoiceId}</h3>
              <div>
                <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Amount (USDC)</label>
                <div className="relative">
                  <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
                  <input
                    type="number"
                    value={payInvoiceAmount}
                    onChange={(e) => setPayInvoiceAmount(e.target.value)}
                    placeholder="0.00"
                    className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none text-lg"
                  />
                </div>
              </div>

              <p className="text-xs text-[var(--text-primary)]/50 leading-snug" data-testid="pay-direct-note">
                Pays the vendor directly from your private balance. Finalize after it
                lands. If the amount does not match the invoice, it is marked disputed
                and the vendor refunds you. To hold funds until the match is checked,
                pay from the invoice link instead.
              </p>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => {
                    setPayInvoiceId(null);
                    setPayInvoiceAmount("");
                  }}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePayInvoice}
                  disabled={!payInvoiceAmount || isProcessing}
                  className="flex-1 h-12 rounded-2xl bg-emerald-500 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Pay
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Invoice Confirmation */}
      {confirmCancelInvoiceId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center">
                <AlertTriangle size={28} className="text-red-500" />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Cancel Invoice?</h3>
              <p className="text-sm text-[var(--text-primary)]/60">
                This will permanently cancel the invoice. This action cannot be undone.
              </p>
              <div className="flex gap-3 w-full pt-2">
                <button
                  onClick={() => setConfirmCancelInvoiceId(null)}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Keep
                </button>
                <button
                  onClick={() => handleCancelInvoice(confirmCancelInvoiceId)}
                  disabled={isProcessing}
                  className="flex-1 h-12 rounded-2xl bg-red-500 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Cancel Invoice
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Arbiter Decision Confirmation */}
      {confirmArbiterEscrow !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col items-center text-center gap-4">
              <div className={cn("w-14 h-14 rounded-2xl flex items-center justify-center", confirmArbiterEscrow.release ? "bg-emerald-50" : "bg-red-50")}>
                <AlertTriangle size={28} className={confirmArbiterEscrow.release ? "text-emerald-500" : "text-red-500"} />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                {confirmArbiterEscrow.release ? "Release to Beneficiary?" : "Return to Depositor?"}
              </h3>
              <p className="text-sm text-[var(--text-primary)]/60">
                As arbiter, your decision is final and cannot be reversed.
              </p>
              <div className="flex gap-3 w-full pt-2">
                <button
                  onClick={() => setConfirmArbiterEscrow(null)}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleArbiterDecide(confirmArbiterEscrow.id, confirmArbiterEscrow.release)}
                  disabled={isProcessing}
                  className={cn(
                    "flex-1 h-12 rounded-2xl text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50",
                    confirmArbiterEscrow.release ? "bg-emerald-500" : "bg-red-500",
                  )}
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Claim Expired Escrow Confirmation */}
      {confirmClaimExpiredId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center">
                <AlertTriangle size={28} className="text-amber-500" />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Claim Expired Escrow?</h3>
              <p className="text-sm text-[var(--text-primary)]/60">
                The escrow deadline has passed. You can reclaim the deposited funds.
              </p>
              <div className="flex gap-3 w-full pt-2">
                <button
                  onClick={() => setConfirmClaimExpiredId(null)}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleClaimExpired(confirmClaimExpiredId)}
                  disabled={isProcessing}
                  className="flex-1 h-12 rounded-2xl bg-amber-500 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Claim Funds
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
