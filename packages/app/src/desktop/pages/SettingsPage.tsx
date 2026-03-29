import { motion } from "framer-motion";
import { useAccount } from "wagmi";
import {
  Settings, Shield, ShieldCheck, Users, Download, Heart, Copy, Check,
  Plus, Trash2, Activity, AlertTriangle, X, Calendar, Lock, FileText, Printer,
  EyeOff,
} from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { GradientAvatar } from "@/components/common/GradientAvatar";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { useContacts } from "@/hooks/useContacts";
import { useInheritance } from "@/hooks/useInheritance";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useStealthPayments } from "@/hooks/useStealthPayments";
import { CONTRACTS } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { ReceiptVerifyModal } from "@/components/payment/ReceiptVerifyModal";

export function SettingsPage() {
  const { isConnected, address } = useAccount();
  const { contacts, addContact, removeContact } = useContacts();
  const { plan, isProcessing, setHeir, heartbeat, removeHeir } = useInheritance();
  const { activities } = useActivityFeed();
  const {
    step: stealthStep,
    error: stealthError,
    sendStealth,
    claimStealth,
    finalizeClaim,
    reset: resetStealth,
  } = useStealthPayments();

  const [copied, setCopied] = useState(false);
  const [newNickname, setNewNickname] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [heirAddress, setHeirAddress] = useState("");
  const [inactivityDays, setInactivityDays] = useState("365");
  const [isExporting, setIsExporting] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [exportDateFrom, setExportDateFrom] = useState("");
  const [exportDateTo, setExportDateTo] = useState("");

  // Stealth payment state
  const [stealthRecipient, setStealthRecipient] = useState("");
  const [stealthAmount, setStealthAmount] = useState("");
  const [stealthNote, setStealthNote] = useState("");
  const [lastClaimCode, setLastClaimCode] = useState<string | null>(null);
  const [lastTransferId, setLastTransferId] = useState<number | null>(null);
  const [claimTransferId, setClaimTransferId] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [finalizeTransferId, setFinalizeTransferId] = useState("");
  const [copiedClaimCode, setCopiedClaimCode] = useState(false);

  if (!isConnected || !address) return <ConnectPrompt />;

  // Filter activities by date range for export

  const copyAddress = async () => {
    await copyToClipboard(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSendStealth = async () => {
    if (!stealthRecipient.trim() || !stealthAmount.trim()) return;
    const result = await sendStealth(
      stealthAmount,
      stealthRecipient.trim(),
      CONTRACTS.FHERC20Vault_USDC,
      stealthNote.trim()
    );
    if (result) {
      setLastClaimCode(result.claimCode);
      setLastTransferId(result.transferId);
      setStealthRecipient("");
      setStealthAmount("");
      setStealthNote("");
    }
  };

  const handleClaimStealth = async () => {
    if (!claimTransferId.trim() || !claimCode.trim()) return;
    const hash = await claimStealth(parseInt(claimTransferId, 10), claimCode.trim());
    if (hash) {
      setClaimTransferId("");
      setClaimCode("");
    }
  };

  const handleFinalizeClaim = async () => {
    if (!finalizeTransferId.trim()) return;
    await finalizeClaim(parseInt(finalizeTransferId, 10));
  };

  const copyClaimCode = async () => {
    if (!lastClaimCode) return;
    await copyToClipboard(lastClaimCode);
    setCopiedClaimCode(true);
    setTimeout(() => setCopiedClaimCode(false), 2000);
  };

  const handleAddContact = async () => {
    if (!newNickname.trim() || !newAddress.trim()) return;
    await addContact(newAddress.trim(), newNickname.trim());
    setNewNickname("");
    setNewAddress("");
  };

  const handleSetHeir = async () => {
    if (!heirAddress.trim() || !inactivityDays) return;
    await setHeir(heirAddress.trim(), parseInt(inactivityDays));
  };

  const filteredActivities = useMemo(() => {
    return activities.filter((a) => {
      const actDate = new Date(a.created_at);
      if (exportDateFrom) {
        const from = new Date(exportDateFrom);
        from.setHours(0, 0, 0, 0);
        if (actDate < from) return false;
      }
      if (exportDateTo) {
        const to = new Date(exportDateTo);
        to.setHours(23, 59, 59, 999);
        if (actDate > to) return false;
      }
      return true;
    });
  }, [activities, exportDateFrom, exportDateTo]);

  const formatCSVField = useCallback((value: string) => {
    // Prevent CSV formula injection
    let sanitized = value;
    if (/^[=+\-@\t\r]/.test(sanitized)) {
      sanitized = "'" + sanitized;
    }
    // Escape quotes and wrap in quotes if contains comma/newline/quote
    if (sanitized.includes(",") || sanitized.includes('"') || sanitized.includes("\n")) {
      return `"${sanitized.replace(/"/g, '""')}"`;
    }
    return sanitized;
  }, []);

  const exportCSV = () => {
    setIsExporting(true);
    try {
      const headers = "Date,Time,Type,From,To,Amount (Encrypted),Token,Note,TxHash,Block\n";
      const rows = filteredActivities.map((a) => {
        const dt = new Date(a.created_at);
        const date = dt.toISOString().slice(0, 10);
        const time = dt.toISOString().slice(11, 19);
        return [
          formatCSVField(date),
          formatCSVField(time),
          formatCSVField(a.activity_type),
          formatCSVField(a.user_from),
          formatCSVField(a.user_to || ""),
          formatCSVField("ENCRYPTED"),
          formatCSVField(a.token_address || ""),
          formatCSVField(a.note || ""),
          formatCSVField(a.tx_hash),
          formatCSVField(String(a.block_number || 0)),
        ].join(",");
      }).join("\n");
      const blob = new Blob([headers + rows], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const fromSuffix = exportDateFrom ? `_from-${exportDateFrom}` : "";
      const toSuffix = exportDateTo ? `_to-${exportDateTo}` : "";
      link.download = `blank-transactions${fromSuffix}${toSuffix}_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  const exportPDF = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const doc = printWindow.document;

    // Build styles
    const style = doc.createElement("style");
    style.textContent = [
      "body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; color: #222; }",
      "h1 { font-size: 20px; margin-bottom: 4px; }",
      "h2 { font-size: 14px; color: #666; font-weight: normal; margin-bottom: 20px; }",
      "table { width: 100%; border-collapse: collapse; font-size: 12px; }",
      "th { text-align: left; border-bottom: 2px solid #333; padding: 8px 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }",
      "td { padding: 6px; border-bottom: 1px solid #eee; }",
      ".mono { font-family: monospace; font-size: 11px; }",
      ".muted { color: #888; }",
      ".footer { margin-top: 24px; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 12px; }",
      ".meta { font-size: 12px; color: #666; margin-bottom: 4px; }",
      "@media print { body { padding: 16px; } }",
    ].join("\n");
    doc.head.appendChild(style);

    const title = doc.createElement("title");
    title.textContent = "Blank - Transaction Statement";
    doc.head.appendChild(title);

    // Build body content
    const h1 = doc.createElement("h1");
    h1.textContent = "Transaction Statement";
    doc.body.appendChild(h1);

    const h2 = doc.createElement("h2");
    h2.textContent = "Blank Encrypted Payment App";
    doc.body.appendChild(h2);

    if (exportDateFrom || exportDateTo) {
      const range = doc.createElement("p");
      range.className = "meta";
      range.textContent = `Date range: ${exportDateFrom || "start"} to ${exportDateTo || "present"}`;
      doc.body.appendChild(range);
    }

    const acctP = doc.createElement("p");
    acctP.className = "meta";
    const acctLabel = doc.createTextNode("Account: ");
    const acctSpan = doc.createElement("span");
    acctSpan.className = "mono";
    acctSpan.textContent = address;
    acctP.appendChild(acctLabel);
    acctP.appendChild(acctSpan);
    doc.body.appendChild(acctP);

    const genP = doc.createElement("p");
    genP.className = "meta";
    genP.style.marginBottom = "16px";
    genP.textContent = `Generated: ${new Date().toISOString()}`;
    doc.body.appendChild(genP);

    // Build table
    const table = doc.createElement("table");
    const thead = doc.createElement("thead");
    const headerRow = doc.createElement("tr");
    ["Date", "Time", "Type", "From", "To", "Amount", "Note"].forEach((h) => {
      const th = doc.createElement("th");
      th.textContent = h;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = doc.createElement("tbody");
    filteredActivities.forEach((a) => {
      const dt = new Date(a.created_at);
      const tr = doc.createElement("tr");

      const vals = [
        { text: dt.toISOString().slice(0, 10), cls: "" },
        { text: dt.toISOString().slice(11, 19), cls: "" },
        { text: a.activity_type, cls: "" },
        { text: a.user_from ? `${a.user_from.slice(0, 8)}...${a.user_from.slice(-6)}` : "", cls: "mono" },
        { text: a.user_to ? `${a.user_to.slice(0, 8)}...${a.user_to.slice(-6)}` : "", cls: "mono" },
        { text: "ENCRYPTED", cls: "muted" },
        { text: a.note || "", cls: "" },
      ];

      vals.forEach((v) => {
        const td = doc.createElement("td");
        td.textContent = v.text;
        if (v.cls) td.className = v.cls;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    doc.body.appendChild(table);

    // Footer
    const footer = doc.createElement("div");
    footer.className = "footer";
    const fp1 = doc.createElement("p");
    fp1.textContent = "All amounts are FHE-encrypted on Base Sepolia. Decrypt with an active permit in the Blank app.";
    const fp2 = doc.createElement("p");
    fp2.textContent = `${filteredActivities.length} transactions total.`;
    footer.appendChild(fp1);
    footer.appendChild(fp2);
    doc.body.appendChild(footer);

    doc.close();
    printWindow.print();
  };

  const lastHeartbeatDate = plan?.lastHeartbeat
    ? new Date(plan.lastHeartbeat * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">Settings</h1>
        <p className="text-base text-apple-secondary font-medium mt-1">Account, contacts, inheritance, and more</p>
      </div>

      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-4">
        {/* Account */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <h3 className="text-subheading font-semibold mb-4 flex items-center gap-2">
              <Settings className="w-4 h-4 text-accent" /> Account
            </h3>
            <div className="rounded-xl bg-glass-surface border border-glass-border divide-y divide-glass-border">
              <div className="flex justify-between items-center px-4 py-3">
                <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Address</span>
                <button onClick={copyAddress} className="flex items-center gap-2 text-sm font-mono text-neutral-300 hover:text-white transition-colors">
                  {address.slice(0, 8)}...{address.slice(-6)}
                  {copied ? <Check className="w-3 h-3 text-accent" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
              <div className="flex justify-between items-center px-4 py-3">
                <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Network</span>
                <span className="text-sm text-neutral-300 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-apple-green animate-pulse" />Base Sepolia</span>
              </div>
              <div className="flex justify-between items-center px-4 py-3">
                <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Profile Type</span>
                <span className="text-sm text-neutral-300">Personal</span>
              </div>
            </div>
          </GlassCard>
        </motion.div>

        {/* Verify Receipt */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <h3 className="text-subheading font-semibold mb-4 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-accent" /> Verify Receipt
            </h3>
            <p className="text-body text-apple-secondary mb-4">
              Verify any payment by pasting the receipt hash
            </p>
            <Button
              variant="secondary"
              size="md"
              icon={<ShieldCheck className="w-4 h-4" />}
              onClick={() => setShowVerifyModal(true)}
            >
              Open Verifier
            </Button>
          </GlassCard>
        </motion.div>

        {/* Stealth Payments */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <h3 className="text-subheading font-semibold mb-4 flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-encrypted" /> Stealth Payments
            </h3>
            <p className="text-body text-apple-secondary mb-4">
              Send payments where nobody can see the recipient on-chain. The recipient claims using a secret code you share off-chain.
            </p>

            {/* Send Stealth Payment */}
            <div className="space-y-3 mb-6">
              <Input
                label="Recipient Address"
                placeholder="0x..."
                value={stealthRecipient}
                onChange={(e) => setStealthRecipient(e.target.value)}
                error={
                  stealthRecipient && !stealthRecipient.match(/^0x[a-fA-F0-9]{40}$/)
                    ? "Invalid Ethereum address"
                    : undefined
                }
              />
              <Input
                label="Amount (USDC)"
                placeholder="100"
                isAmount
                value={stealthAmount}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "" || /^\d*\.?\d{0,6}$/.test(val)) {
                    setStealthAmount(val);
                  }
                }}
              />
              <Input
                label="Note"
                placeholder="Optional message (public on-chain)"
                value={stealthNote}
                onChange={(e) => setStealthNote(e.target.value)}
              />
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                icon={<EyeOff className="w-4 h-4" />}
                onClick={handleSendStealth}
                loading={
                  stealthStep === "approving" ||
                  stealthStep === "encrypting" ||
                  stealthStep === "sending"
                }
                disabled={
                  !stealthRecipient.match(/^0x[a-fA-F0-9]{40}$/) ||
                  !stealthAmount ||
                  parseFloat(stealthAmount) <= 0
                }
              >
                {stealthStep === "approving"
                  ? "Approving..."
                  : stealthStep === "encrypting"
                  ? "Encrypting recipient..."
                  : stealthStep === "sending"
                  ? "Sending..."
                  : "Send Stealth Payment"}
              </Button>
            </div>

            {/* Show claim code after success */}
            {lastClaimCode && (
              <div className="rounded-xl bg-encrypted/5 border border-encrypted/20 p-4 mb-6">
                <p className="text-xs text-encrypted font-semibold mb-2">
                  Share this claim code with the recipient (keep it secret):
                </p>
                <code className="text-xs font-mono text-white break-all select-all block mb-2">
                  {lastClaimCode}
                </code>
                {lastTransferId !== null && (
                  <p className="text-xs text-apple-secondary mb-2">
                    Transfer ID: <span className="font-mono text-white">{lastTransferId}</span>
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={copiedClaimCode ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    onClick={copyClaimCode}
                  >
                    {copiedClaimCode ? "Copied!" : "Copy Code"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<X className="w-3 h-3" />}
                    onClick={() => {
                      setLastClaimCode(null);
                      setLastTransferId(null);
                      resetStealth();
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {/* Claim Stealth Payment */}
            <div className="border-t border-white/[0.06] pt-4 mt-4 space-y-3">
              <h4 className="text-sm font-semibold text-white">Claim a Stealth Payment</h4>
              <p className="text-caption text-apple-secondary">
                Enter the transfer ID and claim code shared by the sender.
              </p>
              <Input
                label="Transfer ID"
                placeholder="0"
                type="number"
                value={claimTransferId}
                onChange={(e) => setClaimTransferId(e.target.value)}
              />
              <Input
                label="Claim Code"
                placeholder="0x..."
                value={claimCode}
                onChange={(e) => setClaimCode(e.target.value)}
                error={
                  claimCode && !claimCode.match(/^0x[a-fA-F0-9]{64}$/)
                    ? "Must be a 32-byte hex string (0x + 64 hex chars)"
                    : undefined
                }
              />
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                onClick={handleClaimStealth}
                loading={stealthStep === "claiming"}
                disabled={
                  !claimTransferId ||
                  !claimCode.match(/^0x[a-fA-F0-9]{64}$/)
                }
              >
                {stealthStep === "claiming" ? "Claiming..." : "Claim Payment"}
              </Button>
            </div>

            {/* Finalize Claim (after async decryption) */}
            <div className="border-t border-white/[0.06] pt-4 mt-4 space-y-3">
              <h4 className="text-sm font-semibold text-white">Finalize Claim</h4>
              <p className="text-caption text-apple-secondary">
                After claiming, wait for FHE decryption to complete, then finalize to receive funds.
              </p>
              <Input
                label="Transfer ID"
                placeholder="0"
                type="number"
                value={finalizeTransferId}
                onChange={(e) => setFinalizeTransferId(e.target.value)}
              />
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                onClick={handleFinalizeClaim}
                loading={stealthStep === "finalizing"}
                disabled={!finalizeTransferId}
              >
                {stealthStep === "finalizing" ? "Finalizing..." : "Finalize Claim"}
              </Button>
            </div>

            {/* Error display */}
            {stealthError && stealthStep === "error" && (
              <div className="mt-4 rounded-xl bg-error/10 border border-error/20 px-4 py-3">
                <p className="text-caption text-error">{stealthError}</p>
              </div>
            )}
          </GlassCard>
        </motion.div>

        {/* Contacts */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <h3 className="text-subheading font-semibold mb-4 flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-400" /> Contacts
            </h3>

            {/* Existing contacts */}
            {contacts.length > 0 && (
              <div className="space-y-2 mb-4">
                {contacts.map((c) => (
                  <div key={c.address} className="flex items-center gap-3 p-2 rounded-xl bg-glass-surface border border-glass-border">
                    <GradientAvatar address={c.address} name={c.nickname} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{c.nickname}</p>
                      <p className="text-xs font-mono text-neutral-500 truncate">{c.address}</p>
                    </div>
                    <button
                      onClick={() => { if (window.confirm("Remove this contact?")) removeContact(c.address); }}
                      className="p-1.5 rounded-lg hover:bg-error/10 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-neutral-600 hover:text-error" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add contact form */}
            <div className="flex gap-2">
              <Input
                placeholder="Nickname"
                className="flex-1"
                value={newNickname}
                onChange={(e) => setNewNickname(e.target.value)}
              />
              <Input
                placeholder="0x... address"
                className="flex-[2]"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                error={newAddress && !newAddress.match(/^0x[a-fA-F0-9]{40}$/) ? "Invalid Ethereum address" : undefined}
              />
              <Button
                variant="secondary"
                size="md"
                onClick={handleAddContact}
                disabled={!newNickname.trim() || !newAddress.trim()}
                icon={<Plus className="w-4 h-4" />}
              >
                Save
              </Button>
            </div>
            <p className="text-caption text-apple-secondary mt-3">Contacts sync locally and to Supabase when connected</p>
          </GlassCard>
        </motion.div>

        {/* Inheritance */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <h3 className="text-subheading font-semibold mb-4 flex items-center gap-2">
              <Heart className="w-4 h-4 text-red-400" /> Inheritance (Dead Man's Switch)
            </h3>

            {plan?.active ? (
              <>
                {/* Active plan display */}
                <div className="rounded-xl bg-glass-surface border border-glass-border divide-y divide-glass-border mb-4">
                  <div className="flex justify-between items-center px-4 py-3">
                    <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Heir</span>
                    <span className="text-sm font-mono text-white">
                      {plan.heir.slice(0, 8)}...{plan.heir.slice(-6)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center px-4 py-3">
                    <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Inactivity Period</span>
                    <span className="text-sm text-neutral-300">{Math.floor(plan.inactivityPeriod / 86400)} days</span>
                  </div>
                  <div className="flex justify-between items-center px-4 py-3">
                    <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Last Heartbeat</span>
                    <span className="text-sm text-neutral-300 flex items-center gap-1">
                      <Activity className="w-3 h-3 text-accent" /> {lastHeartbeatDate || "Never"}
                    </span>
                  </div>
                  {plan.claimStartedAt > 0 && (
                    <div className="flex justify-between items-center px-4 py-3">
                      <span className="text-caption text-error">Claim Started</span>
                      <span className="text-sm text-error flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {new Date(plan.claimStartedAt * 1000).toLocaleDateString()}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="primary"
                    size="md"
                    icon={<Activity className="w-4 h-4" />}
                    onClick={heartbeat}
                    loading={isProcessing}
                  >
                    Send Heartbeat
                  </Button>
                  <Button
                    variant="danger"
                    size="md"
                    icon={<X className="w-4 h-4" />}
                    onClick={() => { if (window.confirm("Remove your inheritance plan? This is an on-chain transaction.")) removeHeir(); }}
                    loading={isProcessing}
                  >
                    Remove Plan
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-body text-apple-secondary mb-4">
                  If you are inactive for a set period, your designated heir can claim your encrypted funds after a 7-day challenge window.
                </p>
                <div className="space-y-4">
                  <Input
                    label="Heir Address"
                    placeholder="0x... who receives your funds"
                    value={heirAddress}
                    onChange={(e) => setHeirAddress(e.target.value)}
                    error={heirAddress && !heirAddress.match(/^0x[a-fA-F0-9]{40}$/) ? "Invalid Ethereum address" : undefined}
                  />
                  <Input
                    label="Inactivity Period"
                    placeholder="365"
                    type="number"
                    hint="Days of inactivity before claim is possible (minimum 30)"
                    value={inactivityDays}
                    onChange={(e) => setInactivityDays(e.target.value)}
                  />
                  <div className="rounded-xl bg-warning/10 border border-warning/20 px-4 py-3">
                    <p className="text-caption text-warning/80">
                      You must send a heartbeat transaction at least once per inactivity period to keep your funds safe.
                      If a claim is started, you have 7 days to respond and cancel it.
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="lg"
                    className="w-full"
                    icon={<Shield className="w-4 h-4" />}
                    onClick={handleSetHeir}
                    loading={isProcessing}
                    disabled={!heirAddress.trim() || parseInt(inactivityDays) < 30}
                  >
                    Set Up Inheritance
                  </Button>
                </div>
              </>
            )}
          </GlassCard>
        </motion.div>

        {/* Export */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <h3 className="text-subheading font-semibold mb-4 flex items-center gap-2">
              <Download className="w-4 h-4 text-neutral-400" /> Export Data
            </h3>
            <p className="text-body text-apple-secondary mb-4">
              Download your transaction history. Amounts show as "ENCRYPTED" in the export.
              Use Full Decrypt Export (coming soon) to include decrypted amounts.
            </p>

            {/* Date Range Picker */}
            <div className="flex gap-3 mb-4">
              <div className="flex-1">
                <label
                  htmlFor="export-date-from"
                  className="block mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500"
                >
                  <Calendar className="w-3 h-3 inline mr-1" />
                  From Date
                </label>
                <input
                  id="export-date-from"
                  type="date"
                  value={exportDateFrom}
                  onChange={(e) => setExportDateFrom(e.target.value)}
                  className="w-full h-10 px-3 text-sm text-white bg-gradient-to-b from-white/[0.04] to-white/[0.02] border border-white/[0.08] rounded-xl focus:border-accent/40 focus:outline-none transition-all duration-200 [color-scheme:dark]"
                  aria-label="Export from date"
                />
              </div>
              <div className="flex-1">
                <label
                  htmlFor="export-date-to"
                  className="block mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500"
                >
                  <Calendar className="w-3 h-3 inline mr-1" />
                  To Date
                </label>
                <input
                  id="export-date-to"
                  type="date"
                  value={exportDateTo}
                  onChange={(e) => setExportDateTo(e.target.value)}
                  className="w-full h-10 px-3 text-sm text-white bg-gradient-to-b from-white/[0.04] to-white/[0.02] border border-white/[0.08] rounded-xl focus:border-accent/40 focus:outline-none transition-all duration-200 [color-scheme:dark]"
                  aria-label="Export to date"
                />
              </div>
            </div>

            {/* Filtered count */}
            {(exportDateFrom || exportDateTo) && (
              <p className="text-caption text-apple-secondary mb-3">
                {filteredActivities.length} of {activities.length} transactions in selected range
              </p>
            )}

            {/* Export format info */}
            <div className="rounded-xl bg-glass-surface border border-glass-border px-4 py-3 mb-4">
              <p className="text-caption text-neutral-400">
                <FileText className="w-3 h-3 inline mr-1" />
                CSV columns: Date, Time, Type, From, To, Amount (Encrypted), Token, Note, TxHash, Block
              </p>
            </div>

            {/* Export Buttons */}
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                size="md"
                icon={<Download className="w-4 h-4" />}
                onClick={exportCSV}
                loading={isExporting}
                disabled={filteredActivities.length === 0}
              >
                Export CSV ({filteredActivities.length})
              </Button>
              <Button
                variant="secondary"
                size="md"
                icon={<Printer className="w-4 h-4" />}
                onClick={exportPDF}
                disabled={filteredActivities.length === 0}
              >
                Print / PDF
              </Button>
              <Button
                variant="outline"
                size="md"
                icon={<Lock className="w-4 h-4" />}
                disabled
                title="Requires an active FHE permit to batch-decrypt all amounts"
              >
                Full Decrypt Export
              </Button>
            </div>
            <p className="text-caption text-neutral-500 mt-3">
              <Lock className="w-3 h-3 inline mr-1" />
              Full Decrypt Export requires an active permit to batch-unseal encrypted amounts
            </p>
          </GlassCard>
        </motion.div>
      </motion.div>

      <ReceiptVerifyModal isOpen={showVerifyModal} onClose={() => setShowVerifyModal(false)} />
    </motion.div>
  );
}
