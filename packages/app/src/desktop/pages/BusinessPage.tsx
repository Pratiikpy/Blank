import { motion } from "framer-motion";
import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useNavigate } from "react-router-dom";
import { FileText, Banknote, Shield, ArrowRight, Plus, RefreshCw } from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { useBusinessHub } from "@/hooks/useBusinessHub";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { fetchVendorInvoices, fetchUserEscrows, type InvoiceRow, type EscrowRow } from "@/lib/supabase";
import toast from "react-hot-toast";

type Tab = "invoices" | "payroll" | "escrow";

export function BusinessPage() {
  const { isConnected, address } = useAccount();
  const { hasBalance } = useEncryptedBalance();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("invoices");
  const [showForm, setShowForm] = useState(false);
  const { createInvoice, runPayroll, createEscrow, finalizeInvoice, step } = useBusinessHub();

  // Form states
  const [invClient, setInvClient] = useState("");
  const [invAmount, setInvAmount] = useState("");
  const [invDesc, setInvDesc] = useState("");
  const [invDueDate, setInvDueDate] = useState("");

  const [empAddresses, setEmpAddresses] = useState([""]);
  const [empSalaries, setEmpSalaries] = useState([""]);

  const [escBeneficiary, setEscBeneficiary] = useState("");
  const [escAmount, setEscAmount] = useState("");
  const [escDesc, setEscDesc] = useState("");
  const [escArbiter, setEscArbiter] = useState("");
  const [escDeadline, setEscDeadline] = useState("");

  // Data
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [escrows, setEscrows] = useState<EscrowRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshData = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    const [inv, esc] = await Promise.all([fetchVendorInvoices(address), fetchUserEscrows(address)]);
    setInvoices(inv);
    setEscrows(esc);
    setLoading(false);
  }, [address]);

  // Fetch on mount + poll every 30s
  useEffect(() => {
    refreshData();
    const interval = setInterval(() => refreshData(), 30000);
    return () => clearInterval(interval);
  }, [refreshData]);

  if (!isConnected) return <ConnectPrompt />;

  const handleCreateInvoice = async () => {
    if (!invClient || !invAmount) return;
    const due = invDueDate ? Math.floor(new Date(invDueDate).getTime() / 1000) : Math.floor(Date.now() / 1000) + 30 * 86400;
    await createInvoice(invClient, invAmount, invDesc, due);
    setInvClient(""); setInvAmount(""); setInvDesc(""); setInvDueDate("");
  };

  const handleRunPayroll = async () => {
    const validEmps = empAddresses.filter((a, i) => /^0x[a-fA-F0-9]{40}$/.test(a.trim()) && parseFloat(empSalaries[i] || "0") > 0);
    const validSals = empSalaries.filter((s, i) => parseFloat(s || "0") > 0 && /^0x[a-fA-F0-9]{40}$/.test(empAddresses[i]?.trim() || ""));
    if (validEmps.length === 0) {
      toast.error("Add at least one valid employee with salary");
      return;
    }
    await runPayroll(validEmps, validSals);
    setEmpAddresses([""]); setEmpSalaries([""]);
  };

  const handleCreateEscrow = async () => {
    if (!escBeneficiary || !escAmount) return;
    const deadline = escDeadline ? Math.floor(new Date(escDeadline).getTime() / 1000) : Math.floor(Date.now() / 1000) + 30 * 86400;
    await createEscrow(escBeneficiary, escAmount, escDesc, escArbiter, deadline);
    setEscBeneficiary(""); setEscAmount(""); setEscDesc(""); setEscArbiter(""); setEscDeadline("");
  };

  const addEmployee = () => { setEmpAddresses([...empAddresses, ""]); setEmpSalaries([...empSalaries, ""]); };

  const isLoading = step === "encrypting" || step === "sending";

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="space-y-6">
      {!hasBalance && (
        <GlassCard className="!rounded-[2rem] !bg-warning/5 !border-warning/20">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-warning">Shield tokens first</p>
              <p className="text-xs text-warning/70 mt-1">You need to shield USDC into your encrypted vault before using business features. Go to Dashboard and click &ldquo;Shield Tokens&rdquo;.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate("/")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        </GlassCard>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Business</h1>
          <p className="text-base text-apple-secondary font-medium mt-1">Invoicing, payroll, and escrow — all encrypted</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refreshData} className="text-xs text-apple-secondary hover:text-white transition-colors flex items-center gap-1">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => setShowForm(!showForm)}>
            {tab === "invoices" ? "New Invoice" : tab === "payroll" ? "Run Payroll" : "New Escrow"}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-glass-surface border border-glass-border rounded-xl p-1">
        {([
          { key: "invoices" as Tab, label: "Invoices", icon: FileText },
          { key: "payroll" as Tab, label: "Payroll", icon: Banknote },
          { key: "escrow" as Tab, label: "Escrow", icon: Shield },
        ]).map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => { setTab(key); setShowForm(false); }}
            className="relative flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium rounded-lg transition-colors">
            {tab === key && (
              <motion.div layoutId="business-tab" className="absolute inset-0 bg-glass-hover border border-glass-border-hover rounded-lg"
                transition={{ type: "spring", stiffness: 400, damping: 30 }} />
            )}
            <Icon className={`w-4 h-4 relative z-10 ${tab === key ? "text-white" : "text-apple-secondary"}`} />
            <span className={`relative z-10 ${tab === key ? "text-white" : "text-sm font-medium text-apple-secondary"}`}>{label}</span>
          </button>
        ))}
      </div>

      {/* Forms */}
      {showForm && (
        <GlassCard variant="elevated" className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
          {tab === "invoices" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-subheading font-semibold">Create Invoice</h3>
                  <p className="text-caption text-apple-secondary">Only you and the client see the amount</p>
                </div>
              </div>
              <Input label="Client Address" placeholder="0x..." value={invClient} onChange={(e) => setInvClient(e.target.value)} />
              <Input label="Amount" placeholder="0.00" value={invAmount} onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setInvAmount(v); }} />
              <Input label="Description" placeholder="Website redesign — March 2026" value={invDesc} onChange={(e) => setInvDesc(e.target.value)} />
              <Input label="Due Date" type="date" value={invDueDate} onChange={(e) => setInvDueDate(e.target.value)} />
              <Button variant="primary" size="lg" className="w-full" icon={<ArrowRight className="w-4 h-4" />}
                onClick={handleCreateInvoice} loading={isLoading} disabled={!invClient || !invAmount}>
                Send Invoice
              </Button>
            </div>
          )}

          {tab === "payroll" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                  <Banknote className="w-5 h-5 text-green-400" />
                </div>
                <div>
                  <h3 className="text-subheading font-semibold">Run Payroll</h3>
                  <p className="text-caption text-apple-secondary">Each employee sees only their own salary</p>
                </div>
              </div>
              {empAddresses.map((addr, i) => (
                <div key={i} className="grid grid-cols-2 gap-3">
                  <Input label={`Employee ${i + 1} Address`} placeholder="0x..." value={addr}
                    onChange={(e) => { const a = [...empAddresses]; a[i] = e.target.value; setEmpAddresses(a); }}
                    error={addr && !/^0x[a-fA-F0-9]{40}$/.test(addr) ? "Invalid address" : undefined} />
                  <Input label={`Salary`} placeholder="0.00" value={empSalaries[i] || ""}
                    onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") { const s = [...empSalaries]; s[i] = v; setEmpSalaries(s); } }} />
                </div>
              ))}
              <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} onClick={addEmployee}>Add Employee</Button>
              <Button variant="primary" size="lg" className="w-full" icon={<ArrowRight className="w-4 h-4" />}
                onClick={handleRunPayroll} loading={isLoading}>
                Execute Payroll
              </Button>
            </div>
          )}

          {tab === "escrow" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                  <Shield className="w-5 h-5 text-purple-400" />
                </div>
                <div>
                  <h3 className="text-subheading font-semibold">Create Escrow</h3>
                  <p className="text-caption text-apple-secondary">Funds locked until both parties agree</p>
                </div>
              </div>
              <Input label="Beneficiary Address" placeholder="0x..." value={escBeneficiary} onChange={(e) => setEscBeneficiary(e.target.value)} />
              <Input label="Amount" placeholder="0.00" value={escAmount} onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setEscAmount(v); }} />
              <Input label="Description" placeholder="Logo design project" value={escDesc} onChange={(e) => setEscDesc(e.target.value)} />
              <Input label="Arbiter (optional)" placeholder="0x..." value={escArbiter} onChange={(e) => setEscArbiter(e.target.value)} />
              <Input label="Deadline" type="date" value={escDeadline} onChange={(e) => setEscDeadline(e.target.value)} />
              <Button variant="primary" size="lg" className="w-full" icon={<ArrowRight className="w-4 h-4" />}
                onClick={handleCreateEscrow} loading={isLoading} disabled={!escBeneficiary || !escAmount}>
                Lock Funds in Escrow
              </Button>
            </div>
          )}
        </GlassCard>
      )}

      {/* Data lists */}
      <motion.div variants={staggerContainer} initial="initial" animate="animate">
        {loading ? (
          <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="shimmer h-16 rounded-xl" style={{ animationDelay: `${i * 0.15}s` }} />)}</div>
        ) : tab === "invoices" && invoices.length > 0 ? (
          invoices.map((inv) => (
            <motion.div key={inv.id} variants={fadeInUp} className="mb-2">
              <GlassCard variant="interactive" className="flex items-center justify-between !rounded-[2rem]">
                <div>
                  <p className="text-sm font-medium text-white">{inv.description}</p>
                  <p className="text-caption text-apple-secondary">To: {inv.client_address.slice(0, 8)}...</p>
                </div>
                <div className="flex items-center gap-2">
                  {inv.status === "payment_pending" && (
                    <Button variant="primary" size="sm" onClick={() => finalizeInvoice(inv.invoice_id)} loading={step === "sending"}>
                      Finalize
                    </Button>
                  )}
                  {inv.status === "disputed" ? (
                    <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">Disputed</span>
                  ) : (
                    <span className={`badge-${
                      inv.status === "pending" ? "warning" :
                      inv.status === "paid" ? "success" :
                      inv.status === "payment_pending" ? "info" :
                      "error"
                    }`}>{inv.status === "payment_pending" ? "Payment Pending" : inv.status}</span>
                  )}
                </div>
              </GlassCard>
            </motion.div>
          ))
        ) : tab === "escrow" && escrows.length > 0 ? (
          escrows.map((esc) => (
            <motion.div key={esc.id} variants={fadeInUp} className="mb-2">
              <GlassCard variant="interactive" className="flex items-center justify-between !rounded-[2rem]">
                <div>
                  <p className="text-sm font-medium text-white">{esc.description}</p>
                  <p className="text-caption text-apple-secondary">With: {esc.beneficiary_address.slice(0, 8)}...</p>
                </div>
                <span className={`badge-${esc.status === "active" ? "info" : esc.status === "released" ? "success" : "warning"}`}>{esc.status}</span>
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
                      {tab === "invoices" && <FileText className="w-8 h-8 text-text-muted" />}
                      {tab === "payroll" && <Banknote className="w-8 h-8 text-text-muted" />}
                      {tab === "escrow" && <Shield className="w-8 h-8 text-text-muted" />}
                    </motion.div>
                  </div>
                </div>
                <p className="text-heading-3 font-semibold text-text-secondary mb-1.5">
                  {tab === "invoices" ? "No invoices yet" : tab === "payroll" ? "No payroll history" : "No escrows yet"}
                </p>
                <p className="text-body text-text-muted text-center max-w-xs mb-6">
                  {tab === "invoices" ? "Send your first encrypted invoice to a client" : tab === "payroll" ? "Run your first encrypted payroll batch" : "Create an escrow to lock funds securely"}
                </p>
                <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => setShowForm(true)}>
                  {tab === "invoices" ? "Create Your First Invoice" : tab === "payroll" ? "Run Your First Payroll" : "Create Your First Escrow"}
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}
