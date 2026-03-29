import { motion } from "framer-motion";
import { useState } from "react";
import toast from "react-hot-toast";
import { useAccount } from "wagmi";
import { ShieldCheck, Key, Share2, Eye, Clock, Lock, Trash2, AlertTriangle } from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { usePrivacy } from "@/hooks/usePrivacy";

export function PrivacyPage() {
  const { isConnected } = useAccount();
  const {
    hasPermit,
    permitCreatedAt,
    permitExpiresAt,
    isCreating,
    isExpiringSoon,
    isExpired,
    sharedPermits,
    createPermit,
    sharePermit,
    revokePermit,
  } = usePrivacy();

  const [shareAddress, setShareAddress] = useState("");
  const [accessLevel, setAccessLevel] = useState<"full" | "balance-proof">("full");
  const [expiryHours, setExpiryHours] = useState("24");
  const [proveAddress, setProveAddress] = useState("");
  const [proveMinBalance, setProveMinBalance] = useState("");

  if (!isConnected) return <ConnectPrompt />;

  const formatDate = (ts: number | null) =>
    ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "---";

  const handleShare = async () => {
    if (!shareAddress || !expiryHours) return;
    await sharePermit(shareAddress, accessLevel, parseInt(expiryHours) || 24);
    setShareAddress("");
  };

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">Privacy Controls</h1>
        <p className="text-base text-apple-secondary font-medium mt-1">Manage who can see your encrypted data</p>
      </div>

      {/* Expiry Warning */}
      {(isExpiringSoon || isExpired) && (
        <GlassCard className="!border-warning/20 !bg-warning/5">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
            <div>
              <p className="text-sm font-medium text-warning">
                {isExpired ? "Your permit has expired" : "Your permit expires in less than 1 hour"}
              </p>
              <p className="text-xs text-warning/60 mt-0.5">Renew to continue viewing encrypted balances</p>
            </div>
            <Button variant="primary" size="sm" className="ml-auto shrink-0" onClick={createPermit} loading={isCreating}>
              Renew Now
            </Button>
          </div>
        </GlassCard>
      )}

      {/* Active Permit */}
      <GlassCard variant="elevated" className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
            <Key className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h3 className="text-subheading font-semibold">Your Active Permit</h3>
            <p className="text-caption text-apple-secondary">Required to view your encrypted balances</p>
          </div>
        </div>
        <div className="rounded-xl bg-glass-surface border border-glass-border divide-y divide-glass-border">
          <div className="flex justify-between items-center px-4 py-3">
            <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Type</span>
            <span className="text-xs font-medium text-accent bg-accent/10 px-2 py-0.5 rounded-full">Self Permit</span>
          </div>
          <div className="flex justify-between items-center px-4 py-3">
            <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Status</span>
            {hasPermit && !isExpired ? (
              <span className="text-sm text-accent flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" /> Active
              </span>
            ) : (
              <span className="text-sm text-neutral-500">Not created</span>
            )}
          </div>
          <div className="flex justify-between items-center px-4 py-3">
            <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Created</span>
            <span className="text-sm text-neutral-300">{formatDate(permitCreatedAt)}</span>
          </div>
          <div className="flex justify-between items-center px-4 py-3">
            <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Expires</span>
            <span className="text-sm text-neutral-300 flex items-center gap-1">
              <Clock className="w-3 h-3" /> {formatDate(permitExpiresAt)}
            </span>
          </div>
        </div>
        <Button
          variant={hasPermit && !isExpired ? "secondary" : "primary"}
          size="md"
          className="mt-4"
          icon={<Key className="w-4 h-4" />}
          onClick={createPermit}
          loading={isCreating}
        >
          {hasPermit && !isExpired ? "Renew Permit" : "Create Permit"}
        </Button>
      </GlassCard>

      {/* Shared Permits */}
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-4">
        <h2 className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">Shared Access</h2>

        {sharedPermits.length > 0 ? (
          sharedPermits.map((permit) => (
            <motion.div key={permit.address} variants={fadeInUp}>
              <GlassCard className="flex items-center gap-3 !bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  permit.accessLevel === "full" ? "bg-accent/10" : "bg-encrypted/10"
                }`}>
                  {permit.accessLevel === "full" ? (
                    <Eye className="w-4 h-4 text-accent" />
                  ) : (
                    <Lock className="w-4 h-4 text-encrypted" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-white truncate">
                    {permit.address.slice(0, 10)}...{permit.address.slice(-6)}
                  </p>
                  <p className="text-xs text-apple-secondary">
                    {permit.accessLevel === "full" ? "Full Access" : "Balance Proof"} · Expires {formatDate(permit.expiresAt)}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => revokePermit(permit.address)}>
                  <Trash2 className="w-4 h-4 text-error" />
                </Button>
              </GlassCard>
            </motion.div>
          ))
        ) : (
          <motion.div variants={fadeInUp}>
            <GlassCard className="py-8 text-center">
              <Share2 className="w-8 h-8 text-neutral-600 mx-auto mb-3" />
              <p className="text-body text-neutral-400">No shared permits</p>
              <p className="text-caption text-neutral-600 mt-1">Share data with accountants, lenders, or auditors</p>
            </GlassCard>
          </motion.div>
        )}

        {/* Share data form */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <h3 className="text-subheading font-semibold mb-4">Share Data</h3>
            <div className="space-y-4">
              <Input
                label="Share with (address)"
                placeholder="0x... accountant or auditor"
                value={shareAddress}
                onChange={(e) => setShareAddress(e.target.value)}
              />
              <div>
                <label className="label mb-2 block">Access Level</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setAccessLevel("full")}
                    className={`rounded-2xl p-3 text-left transition-all duration-200 ${
                      accessLevel === "full"
                        ? "bg-accent/10 border border-accent/30 ring-1 ring-accent/20"
                        : "bg-glass-surface border border-glass-border hover:bg-glass-hover"
                    }`}
                  >
                    <Eye className={`w-4 h-4 mb-1 ${accessLevel === "full" ? "text-accent" : "text-apple-secondary"}`} />
                    <p className="text-sm font-medium">Full Access</p>
                    <p className="text-caption text-apple-secondary">See all balances and transactions</p>
                  </button>
                  <button
                    onClick={() => setAccessLevel("balance-proof")}
                    className={`rounded-2xl p-3 text-left transition-all duration-200 ${
                      accessLevel === "balance-proof"
                        ? "bg-encrypted/10 border border-encrypted/30 ring-1 ring-encrypted/20"
                        : "bg-glass-surface border border-glass-border hover:bg-glass-hover"
                    }`}
                  >
                    <Lock className={`w-4 h-4 mb-1 ${accessLevel === "balance-proof" ? "text-encrypted" : "text-apple-secondary"}`} />
                    <p className="text-sm font-medium">Balance Proof Only</p>
                    <p className="text-caption text-apple-secondary">Prove balance above threshold</p>
                  </button>
                </div>
              </div>
              <Input
                label="Expires After (hours)"
                placeholder="24"
                type="number"
                value={expiryHours}
                onChange={(e) => setExpiryHours(e.target.value)}
              />
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                icon={<Share2 className="w-4 h-4" />}
                onClick={handleShare}
                disabled={!shareAddress}
              >
                Generate Sharing Permit
              </Button>
            </div>
          </GlassCard>
        </motion.div>

        {/* Prove Balance */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <h3 className="text-subheading font-semibold mb-4">Prove Minimum Balance</h3>
            <p className="text-body text-apple-secondary mb-4">
              Prove your balance exceeds a threshold without revealing the exact amount
            </p>
            <div className="space-y-4">
              <Input
                label="Prove to (address)"
                placeholder="0x... lender or verifier"
                value={proveAddress}
                onChange={(e) => setProveAddress(e.target.value)}
              />
              <Input
                label="Minimum balance to prove"
                placeholder="10000"
                hint="They will know you have at least this much, nothing more"
                value={proveMinBalance}
                onChange={(e) => setProveMinBalance(e.target.value)}
                isAmount
              />
              <Button
                variant="secondary"
                size="lg"
                className="w-full"
                icon={<ShieldCheck className="w-4 h-4" />}
                disabled={!proveAddress || !proveMinBalance}
                onClick={() => toast("Balance proofs coming soon — requires on-chain FHE.gte() verification")}
              >
                Generate Balance Proof
              </Button>
            </div>
          </GlassCard>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
