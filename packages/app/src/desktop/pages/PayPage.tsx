import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { Send, User, FileText, ArrowRight, Lock } from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { APP_NAME } from "@/lib/constants";

export function PayPage() {
  const { isConnected, address } = useAccount();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Read query params
  const toParam = searchParams.get("to") || "";
  const suggestedAmountParam = searchParams.get("suggestedAmount") || "";
  const noteParam = searchParams.get("note") || "";

  const [amount, setAmount] = useState(suggestedAmountParam);
  const [note, setNote] = useState(noteParam);

  // Sync from URL params on mount
  useEffect(() => {
    if (suggestedAmountParam) setAmount(suggestedAmountParam);
    if (noteParam) setNote(noteParam);
  }, [suggestedAmountParam, noteParam]);

  if (!isConnected) return <ConnectPrompt />;

  const isSelf = address?.toLowerCase() === toParam.toLowerCase();
  const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(toParam);
  const hasAmount = amount.length > 0 && parseFloat(amount) > 0;
  const canProceed = isValidAddress && !isSelf && hasAmount;

  const handleAmountChange = (value: string) => {
    if (value === "" || /^\d*\.?\d{0,6}$/.test(value)) {
      setAmount(value);
    }
  };

  const handleSend = () => {
    // Navigate to /send with pre-filled data via URL state
    navigate("/send", {
      state: {
        prefillRecipient: toParam,
        prefillAmount: amount,
        prefillNote: note,
      },
    });
  };

  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="max-w-lg mx-auto space-y-6"
    >
      {/* Header */}
      <div>
        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="text-display font-bold text-white"
        >
          Payment Request
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="text-body text-neutral-500 mt-1.5"
        >
          Someone has requested an encrypted payment from you
        </motion.p>
      </div>

      {/* Recipient card */}
      <GlassCard variant="elevated" className="relative overflow-hidden">
        {/* Decorative glow */}
        <div
          className="absolute -top-16 -right-16 w-48 h-48 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(16,185,129,0.06) 0%, transparent 70%)" }}
          aria-hidden="true"
        />

        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="relative space-y-5"
        >
          {/* Recipient */}
          <motion.div variants={fadeInUp}>
            <div className="flex items-center gap-3 mb-1.5">
              <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
                <User className="w-4 h-4 text-accent" />
              </div>
              <div>
                <p className="label text-neutral-500">Paying to</p>
                {isValidAddress ? (
                  <p className="text-sm font-mono text-neutral-300">
                    {toParam.slice(0, 10)}...{toParam.slice(-8)}
                  </p>
                ) : (
                  <p className="text-sm text-red-400">Invalid address</p>
                )}
              </div>
            </div>
            {isSelf && (
              <p className="text-caption text-red-400 mt-1 ml-11">
                You cannot pay yourself
              </p>
            )}
          </motion.div>

          {/* Note (if provided) */}
          {noteParam && (
            <motion.div variants={fadeInUp}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center shrink-0 mt-0.5">
                  <FileText className="w-4 h-4 text-purple-400" />
                </div>
                <div>
                  <p className="label text-neutral-500">Note</p>
                  <p className="text-sm text-neutral-300">{noteParam}</p>
                </div>
              </div>
            </motion.div>
          )}

          {/* Amount input */}
          <motion.div variants={fadeInUp}>
            <Input
              label="Amount (USDC)"
              placeholder={suggestedAmountParam || "0.00"}
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              hint={
                suggestedAmountParam
                  ? `Suggested: ${suggestedAmountParam} USDC -- you can change this`
                  : "Enter the amount to send"
              }
            />
          </motion.div>

          {/* Custom note override */}
          {!noteParam && (
            <motion.div variants={fadeInUp}>
              <Input
                label="Note (optional)"
                placeholder="What is this payment for?"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </motion.div>
          )}
        </motion.div>
      </GlassCard>

      {/* Send button */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!canProceed}
          onClick={handleSend}
          icon={canProceed ? <ArrowRight className="w-4 h-4" /> : <Send className="w-4 h-4" />}
        >
          {canProceed ? "Continue to Send" : "Enter amount to continue"}
        </Button>
      </motion.div>

      {/* Privacy note */}
      <div className="text-center pb-4">
        <div className="flex items-center justify-center gap-1.5 text-caption text-encrypted/50">
          <Lock className="w-3 h-3" />
          {APP_NAME} encrypts all payment amounts with FHE
        </div>
      </div>
    </motion.div>
  );
}
