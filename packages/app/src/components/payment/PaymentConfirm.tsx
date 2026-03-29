import { motion } from "framer-motion";
import { Eye, Lock, ArrowRight, ArrowLeft, Globe, Shield, AlertTriangle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { BASE_SEPOLIA } from "@/lib/constants";
import { Button } from "@/components/ui/Button";

interface PaymentConfirmProps {
  recipient: string;
  amount: string;
  token: string;
  note: string;
  onConfirm: () => void;
  onBack: () => void;
  loading?: boolean;
}

export function PaymentConfirm({
  recipient,
  amount,
  token,
  note,
  onConfirm,
  onBack,
  loading = false,
}: PaymentConfirmProps) {
  return (
    <GlassCard variant="elevated">
      <div className="space-y-0">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-4 shadow-accent-glow">
            <Shield className="w-7 h-7 text-accent" />
          </div>
          <h3 className="text-heading font-semibold text-white">Confirm Payment</h3>
          <p className="text-body text-neutral-500 mt-1">Review before sending</p>
        </div>

        {/* ─── PUBLIC SECTION: Visible to Everyone ────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-xl bg-glass-surface border border-glass-border overflow-hidden"
        >
          {/* Section header */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-white/[0.02] border-b border-glass-border">
            <Eye className="w-3.5 h-3.5 text-neutral-400" />
            <span className="text-label font-semibold uppercase text-neutral-400 tracking-widest">
              Visible to everyone
            </span>
            <Globe className="w-3 h-3 text-neutral-600 ml-auto" />
          </div>

          {/* Public fields */}
          <div className="divide-y divide-glass-border">
            <div className="flex justify-between items-center px-4 py-3">
              <span className="text-caption text-neutral-500">To</span>
              <span className="text-sm font-mono text-white">
                {recipient.slice(0, 8)}...{recipient.slice(-6)}
              </span>
            </div>
            {note && (
              <div className="flex justify-between items-center px-4 py-3">
                <span className="text-caption text-neutral-500">Note</span>
                <span className="text-sm text-neutral-300">{note}</span>
              </div>
            )}
            <div className="flex justify-between items-center px-4 py-3">
              <span className="text-caption text-neutral-500">Network</span>
              <span className="text-sm text-neutral-300">{BASE_SEPOLIA.name}</span>
            </div>
            <div className="flex justify-between items-center px-4 py-3">
              <span className="text-caption text-neutral-500">Token</span>
              <span className="text-sm text-neutral-300">{token}</span>
            </div>
          </div>
        </motion.div>

        {/* ─── Dashed border divider ───────────────────────────────── */}
        <div className="relative py-4">
          <div className="border-t-2 border-dashed border-encrypted/20 w-full" />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-void-elevated px-3 py-1 rounded-full border border-encrypted/20">
            <Lock className="w-3 h-3 text-encrypted" />
          </div>
        </div>

        {/* ─── ENCRYPTED SECTION: Hidden from public ─────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-xl border border-encrypted/15 overflow-hidden"
          style={{
            background:
              "linear-gradient(135deg, rgba(139, 92, 246, 0.03), rgba(139, 92, 246, 0.06))",
          }}
        >
          {/* Section header */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-encrypted/[0.04] border-b border-encrypted/10">
            <Lock className="w-3.5 h-3.5 text-encrypted" />
            <span className="text-label font-semibold uppercase text-encrypted/80 tracking-widest">
              Encrypted
            </span>
            <span className="ml-auto text-[10px] text-encrypted/40 font-mono">FHE</span>
          </div>

          {/* Encrypted amount */}
          <div className="px-4 py-5 flex flex-col items-center gap-1">
            <span className="text-caption text-encrypted/50 uppercase tracking-wider">
              Amount
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-mono font-bold text-white tracking-tight">
                ${amount}
              </span>
              <span className="text-sm text-encrypted/60 font-medium">{token}</span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 px-3 py-1 rounded-full bg-encrypted/[0.06] border border-encrypted/10">
              <Lock className="w-2.5 h-2.5 text-encrypted/60" />
              <span className="text-[10px] text-encrypted/50 font-medium tracking-wide">
                Only you and recipient can see this
              </span>
            </div>
          </div>
        </motion.div>

        {/* Irreversible action warning */}
        <div className="flex items-start gap-2 mt-4 p-3 rounded-xl bg-warning/5 border border-warning/10">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <p className="text-xs text-warning/80">
            Encrypted transfers are final and cannot be reversed. Please verify the recipient address.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-6">
          <Button
            variant="ghost"
            size="lg"
            onClick={onBack}
            disabled={loading}
            icon={<ArrowLeft className="w-4 h-4" />}
            className="flex-1"
          >
            Back
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={onConfirm}
            loading={loading}
            icon={<ArrowRight className="w-4 h-4" />}
            className="flex-1"
          >
            Send Payment
          </Button>
        </div>
      </div>
    </GlassCard>
  );
}
