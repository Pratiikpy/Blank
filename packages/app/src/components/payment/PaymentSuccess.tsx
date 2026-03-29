import { motion } from "framer-motion";
import { CheckCircle, ExternalLink, Send, Copy, Check } from "lucide-react";
import { useState } from "react";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { BASE_SEPOLIA } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";

interface PaymentSuccessProps {
  recipient: string;
  amount: string;
  token: string;
  note: string;
  txHash: string | null;
  onSendAnother: () => void;
}

const RIPPLE_COUNT = 3;
const RIPPLE_STAGGER = 0.3;

export function PaymentSuccess({
  recipient,
  amount,
  token,
  note,
  txHash,
  onSendAnother,
}: PaymentSuccessProps) {
  const [copied, setCopied] = useState(false);

  const copyTxHash = async () => {
    if (!txHash) return;
    await copyToClipboard(txHash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <GlassCard variant="elevated" className="text-center">
      {/* Success animation with expanding ripple rings */}
      <div className="relative mx-auto mb-8 flex items-center justify-center" style={{ width: 120, height: 120 }}>
        {/* Expanding ring ripples */}
        {Array.from({ length: RIPPLE_COUNT }).map((_, i) => (
          <motion.div
            key={i}
            className="absolute inset-0 rounded-full border border-apple-green/40"
            initial={{ scale: 0.5, opacity: 0.6 }}
            animate={{ scale: 3, opacity: 0 }}
            transition={{
              duration: 2,
              delay: 0.2 + i * RIPPLE_STAGGER,
              repeat: Infinity,
              repeatDelay: 1,
              ease: "easeOut",
            }}
          />
        ))}

        {/* Static glow behind the icon */}
        <motion.div
          className="absolute w-20 h-20 rounded-full bg-apple-green/10"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.05 }}
          style={{
            boxShadow:
              "0 0 50px rgba(52, 199, 89, 0.4), 0 0 80px rgba(52, 199, 89, 0.15)",
          }}
        />

        {/* CheckCircle icon — springs in */}
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 24, delay: 0.1 }}
          className="relative w-20 h-20 rounded-full bg-gradient-to-br from-apple-green to-[#28A745] flex items-center justify-center"
          style={{
            boxShadow: "0 0 50px rgba(52, 199, 89, 0.4)",
          }}
        >
          <CheckCircle className="w-10 h-10 text-white" />
        </motion.div>
      </div>

      {/* Text */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
      >
        <h3 className="text-heading font-bold text-white">Transfer Encrypted</h3>
        <p className="text-body text-neutral-400 mt-1">
          Encrypted payment delivered successfully
        </p>
      </motion.div>

      {/* Details */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35 }}
        className="mt-6 rounded-xl bg-glass-surface border border-glass-border p-4 text-left space-y-3"
      >
        <div className="flex justify-between">
          <span className="text-caption text-neutral-500">To</span>
          <span className="text-sm font-mono text-neutral-300">
            {recipient.slice(0, 8)}...{recipient.slice(-6)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-caption text-neutral-500">Amount</span>
          <span className="text-sm font-mono text-accent font-semibold">
            ${amount} {token}
          </span>
        </div>
        {note && (
          <div className="flex justify-between">
            <span className="text-caption text-neutral-500">Note</span>
            <span className="text-sm text-neutral-300">{note}</span>
          </div>
        )}
      </motion.div>

      {/* Tx hash */}
      {txHash && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.45 }}
          className="mt-4"
        >
          <button
            onClick={copyTxHash}
            className="inline-flex items-center gap-2 text-xs font-mono text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            {txHash.slice(0, 12)}...{txHash.slice(-8)}
            {copied ? (
              <Check className="w-3 h-3 text-accent" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>

          <a
            href={`${BASE_SEPOLIA.explorerUrl}/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1 text-caption text-accent/70 hover:text-accent mt-2 transition-colors"
          >
            View on Explorer <ExternalLink className="w-3 h-3" />
          </a>
        </motion.div>
      )}

      {/* Actions */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.55 }}
        className="mt-6"
      >
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={onSendAnother}
          icon={<Send className="w-4 h-4" />}
        >
          Send Another Payment
        </Button>
      </motion.div>
    </GlassCard>
  );
}
