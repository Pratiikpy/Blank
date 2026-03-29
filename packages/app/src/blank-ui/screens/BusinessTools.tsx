import { useState, useEffect, useCallback } from "react";
import {
  Receipt,
  DollarSign,
  Lock,
  FileText,
  CheckCircle2,
  Plus,
  X,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useBusinessHub } from "@/hooks/useBusinessHub";
import { useAccount } from "wagmi";
import {
  fetchVendorInvoices,
  fetchClientInvoices,
  fetchUserEscrows,
  type InvoiceRow,
  type EscrowRow,
} from "@/lib/supabase";

type TabValue = "invoices" | "payroll" | "escrow";

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
  const { address } = useAccount();
  const { step, createInvoice, runPayroll, createEscrow, finalizeInvoice } = useBusinessHub();

  const [activeTab, setActiveTab] = useState<TabValue>("invoices");
  const [showModal, setShowModal] = useState(false);

  // Real data from Supabase
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [escrows, setEscrows] = useState<EscrowRow[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(false);

  // Invoice form
  const [invoiceClient, setInvoiceClient] = useState("");
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

  const isProcessing = step === "approving" || step === "encrypting" || step === "sending";

  // Load real data
  const loadData = useCallback(async () => {
    if (!address) return;
    setIsLoadingData(true);
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
      console.warn("Failed to load business data:", err);
    } finally {
      setIsLoadingData(false);
    }
  }, [address]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Reload data after successful operations
  useEffect(() => {
    if (step === "success") {
      loadData();
    }
  }, [step, loadData]);

  const handleCreateInvoice = async () => {
    if (!invoiceClient || !invoiceAmount) return;
    const dueDate = Math.floor(Date.now() / 1000) + parseInt(invoiceDueDays) * 86400;
    await createInvoice(invoiceClient, invoiceAmount, invoiceDesc || "Invoice", dueDate);
    setShowModal(false);
    setInvoiceClient("");
    setInvoiceAmount("");
    setInvoiceDesc("");
  };

  const handleRunPayroll = async () => {
    const addresses = payAddresses.split(",").map((a) => a.trim()).filter(Boolean);
    const amounts = payAmounts.split(",").map((a) => a.trim()).filter(Boolean);
    if (addresses.length === 0 || addresses.length !== amounts.length) return;
    await runPayroll(addresses, amounts);
    setShowModal(false);
    setPayAddresses("");
    setPayAmounts("");
  };

  const handleCreateEscrow = async () => {
    if (!escrowBeneficiary || !escrowAmount) return;
    const deadline = Math.floor(Date.now() / 1000) + parseInt(escrowDeadlineDays) * 86400;
    await createEscrow(escrowBeneficiary, escrowAmount, escrowDesc || "Escrow", escrowArbiter, deadline);
    setShowModal(false);
    setEscrowBeneficiary("");
    setEscrowAmount("");
    setEscrowDesc("");
    setEscrowArbiter("");
  };

  const handleFinalizeInvoice = async (invoiceId: number) => {
    await finalizeInvoice(invoiceId);
  };

  const tabs: { id: TabValue; label: string; icon: typeof Receipt }[] = [
    { id: "invoices", label: "Invoices", icon: Receipt },
    { id: "payroll", label: "Payroll", icon: DollarSign },
    { id: "escrow", label: "Escrow", icon: Lock },
  ];

  const formatDate = (iso: string | null) => {
    if (!iso) return "No date";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const truncateAddr = (addr: string) =>
    addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Business Tools
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
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
            </p>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex gap-3 mb-6 overflow-x-auto">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
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

            <div className="rounded-[2rem] glass-card p-8">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">Recent Invoices</h3>

              {isLoadingData ? (
                <div className="flex items-center justify-center py-8 gap-3">
                  <Loader2 size={24} className="animate-spin text-[var(--text-primary)]/40" />
                  <span className="text-[var(--text-primary)]/50">Loading invoices...</span>
                </div>
              ) : invoices.length === 0 ? (
                <div className="text-center py-8 text-[var(--text-primary)]/40">
                  <FileText size={40} className="mx-auto mb-3 opacity-30" />
                  <p className="font-medium mb-1">No invoices yet</p>
                  <p className="text-sm">Create your first invoice to get started</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {invoices.map((invoice) => (
                    <div
                      key={invoice.id}
                      className="flex items-center justify-between p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 hover:bg-white/70 transition-all"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-[#007AFF]/10 flex items-center justify-center">
                          <FileText size={24} className="text-[#007AFF]" />
                        </div>
                        <div>
                          <p className="font-medium text-[var(--text-primary)]">{truncateAddr(invoice.client_address)}</p>
                          <p className="text-sm text-[var(--text-primary)]/50">
                            {formatDate(invoice.created_at)} &middot; Due {formatDate(invoice.due_date)}
                          </p>
                          {invoice.description && <p className="text-xs text-[var(--text-primary)]/40">{invoice.description}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-lg font-heading font-medium encrypted-text">
                            ${"\u2588\u2588\u2588\u2588\u2588.\u2588\u2588"}
                          </p>
                          <div className={cn("inline-flex px-2 py-1 rounded-full text-xs font-medium border", getStatusBadge(invoice.status))}>
                            {invoice.status}
                          </div>
                        </div>
                        {invoice.status === "pending" && invoice.client_address === address?.toLowerCase() && (
                          <button
                            onClick={() => handleFinalizeInvoice(invoice.invoice_id)}
                            disabled={isProcessing}
                            className="h-10 px-4 rounded-xl bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                          >
                            {isProcessing && <Loader2 size={14} className="animate-spin" />}
                            Pay Invoice
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
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

            <div className="rounded-[2rem] glass-card p-8">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">Payroll</h3>
              <div className="text-center py-8 text-[var(--text-primary)]/40">
                <DollarSign size={40} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium mb-1">Run encrypted payroll</p>
                <p className="text-sm">Click "Run Payroll" to send encrypted salary payments to multiple employees at once</p>
              </div>
            </div>
          </div>
        )}

        {/* Escrow Tab */}
        {activeTab === "escrow" && (
          <div className="space-y-6">
            <div className="flex justify-end">
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
            ) : escrows.length === 0 ? (
              <div className="rounded-[2rem] glass-card p-8">
                <div className="text-center py-8 text-[var(--text-primary)]/40">
                  <Lock size={40} className="mx-auto mb-3 opacity-30" />
                  <p className="font-medium mb-1">No escrows yet</p>
                  <p className="text-sm">Create your first escrow to get started</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {escrows.map((escrow) => (
                  <div
                    key={escrow.id}
                    className="rounded-[2rem] glass-card p-8 hover:-translate-y-1 transition-all duration-300"
                  >
                    <div className="flex items-start justify-between mb-6">
                      <div>
                        <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-1">{escrow.description}</h3>
                        <p className="text-sm text-[var(--text-primary)]/50">
                          Beneficiary: {truncateAddr(escrow.beneficiary_address)}
                        </p>
                        <div className={cn("inline-flex mt-2 px-2 py-1 rounded-full text-xs font-medium border", getStatusBadge(escrow.status))}>
                          {escrow.status}
                        </div>
                      </div>
                      <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center">
                        <Lock size={24} className="text-purple-600" />
                      </div>
                    </div>

                    <div className="p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 mb-4">
                      <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-1">Escrow Amount</p>
                      <p className="text-2xl font-heading font-medium encrypted-text">
                        ${"\u2588\u2588\u2588\u2588\u2588\u2588.\u2588\u2588"}
                      </p>
                    </div>

                    <div className="text-sm text-[var(--text-primary)]/50">
                      <p>Deadline: {formatDate(escrow.deadline)}</p>
                      {escrow.arbiter_address && escrow.arbiter_address !== "" && (
                        <p>Arbiter: {truncateAddr(escrow.arbiter_address)}</p>
                      )}
                    </div>

                    {escrow.status === "released" && (
                      <div className="mt-4 flex items-center justify-center gap-2 text-emerald-600">
                        <CheckCircle2 size={20} />
                        <span className="text-sm font-medium">Released</span>
                      </div>
                    )}
                  </div>
                ))}
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
              <button onClick={() => setShowModal(false)} className="p-2 hover:bg-black/5 rounded-xl">
                <X size={24} className="text-[var(--text-primary)]/50" />
              </button>
            </div>

            {activeTab === "invoices" && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Client Wallet Address</label>
                  <input type="text" value={invoiceClient} onChange={(e) => setInvoiceClient(e.target.value)} placeholder="0x..." className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Amount (USDC)</label>
                  <div className="relative">
                    <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
                    <input type="number" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} placeholder="0.00" className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Description</label>
                  <input type="text" value={invoiceDesc} onChange={(e) => setInvoiceDesc(e.target.value)} placeholder="Services rendered" className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Due in (days)</label>
                  <select value={invoiceDueDays} onChange={(e) => setInvoiceDueDays(e.target.value)} className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none">
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
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Employee Addresses (comma-separated)</label>
                  <textarea
                    value={payAddresses}
                    onChange={(e) => setPayAddresses(e.target.value)}
                    placeholder="0xabc..., 0xdef..., 0x123..."
                    rows={3}
                    className="w-full px-5 py-4 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Amounts in USDC (comma-separated, same order)</label>
                  <textarea
                    value={payAmounts}
                    onChange={(e) => setPayAmounts(e.target.value)}
                    placeholder="5000, 8000, 3500"
                    rows={2}
                    className="w-full px-5 py-4 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none resize-none"
                  />
                </div>
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
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Beneficiary Address</label>
                  <input type="text" value={escrowBeneficiary} onChange={(e) => setEscrowBeneficiary(e.target.value)} placeholder="0x..." className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Escrow Amount (USDC)</label>
                  <div className="relative">
                    <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
                    <input type="number" value={escrowAmount} onChange={(e) => setEscrowAmount(e.target.value)} placeholder="0.00" className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Description</label>
                  <input type="text" value={escrowDesc} onChange={(e) => setEscrowDesc(e.target.value)} placeholder="Project milestone" className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Arbiter Address (optional)</label>
                  <input type="text" value={escrowArbiter} onChange={(e) => setEscrowArbiter(e.target.value)} placeholder="0x... (leave empty for no arbiter)" className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Deadline (days from now)</label>
                  <select value={escrowDeadlineDays} onChange={(e) => setEscrowDeadlineDays(e.target.value)} className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none">
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
    </div>
  );
}
