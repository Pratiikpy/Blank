import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Send, Lock, CheckCircle, AlertTriangle, RotateCcw } from "lucide-react";
import { NumericKeypad } from "@/components/mobile/NumericKeypad";
import { AmountDisplay } from "@/components/mobile/AmountDisplay";
import { BottomSheet } from "@/components/mobile/BottomSheet";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { GradientAvatar } from "@/components/common/GradientAvatar";
import { EncryptionProgress } from "@/components/payment/EncryptionProgress";
import { useSendPayment } from "@/hooks/useSendPayment";

type MobileStep = "amount" | "details" | "encrypting" | "confirming" | "sending" | "success" | "error";

export function MobileSendPage() {
  useAccount();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const payment = useSendPayment();
  const [mobileStep, setMobileStep] = useState<MobileStep>("amount");
  const [showDetails, setShowDetails] = useState(false);

  // Pre-fill from URL params (payment links)
  const prefillTo = searchParams.get("to") || "";
  if (prefillTo && !payment.recipient) {
    payment.setRecipient(prefillTo);
  }

  const handleKey = (key: string) => {
    const current = payment.amount;
    // Prevent multiple decimals
    if (key === "." && current.includes(".")) return;
    // Limit to 6 decimal places
    if (current.includes(".") && current.split(".")[1].length >= 6) return;
    // Limit total length
    if (current.length >= 12) return;
    payment.setAmount(current + key);
  };

  const handleBackspace = () => {
    payment.setAmount(payment.amount.slice(0, -1));
  };

  const handleNextFromAmount = () => {
    if (!payment.amount || parseFloat(payment.amount) <= 0) return;
    setMobileStep("details");
    setShowDetails(true);
  };

  const handleSend = async () => {
    setShowDetails(false);
    setMobileStep("encrypting");
    await payment.send();
  };

  const handleConfirmSend = async () => {
    setMobileStep("sending");
    await payment.confirmSend();
  };

  // Sync payment step to mobile step
  useEffect(() => {
    if (payment.step === "confirming" && mobileStep === "encrypting") {
      setMobileStep("confirming");
    }
    if (payment.step === "success" && mobileStep !== "success") {
      setMobileStep("success");
      navigator.vibrate?.([10, 30, 10, 30, 40]);
    }
    if (payment.step === "error" && mobileStep !== "error") {
      setMobileStep("error");
    }
  }, [payment.step, mobileStep]);

  return (
    <div className="flex flex-col min-h-[calc(100dvh-96px)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => {
            if (mobileStep === "amount") navigate(-1);
            else {
              setMobileStep("amount");
              payment.reset();
            }
          }}
          className="w-10 h-10 rounded-full bg-glass-surface border border-glass-border flex items-center justify-center"
        >
          <ArrowLeft className="w-5 h-5 text-neutral-400" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-white">Send Money</h1>
          <p className="text-xs text-neutral-500">Encrypted payment</p>
        </div>
        <Lock className="w-4 h-4 text-encrypted" />
      </div>

      <AnimatePresence mode="wait">
        {/* AMOUNT ENTRY */}
        {mobileStep === "amount" && (
          <motion.div
            key="amount"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col flex-1"
          >
            {/* Recipient quick display */}
            {payment.recipient && (
              <div className="flex items-center gap-2 px-4 py-2">
                <GradientAvatar address={payment.recipient} size="sm" />
                <span className="text-sm font-mono text-neutral-400">
                  {payment.recipient.slice(0, 8)}...{payment.recipient.slice(-6)}
                </span>
              </div>
            )}

            {/* Amount display */}
            <div className="flex-1 flex items-center justify-center px-4">
              <AmountDisplay amount={payment.amount} />
            </div>

            {/* Numeric Keypad */}
            <div className="px-4 pb-2">
              <NumericKeypad onKey={handleKey} onBackspace={handleBackspace} />
            </div>

            {/* Next button */}
            <div className="px-4 pb-4">
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={handleNextFromAmount}
                disabled={!payment.amount || parseFloat(payment.amount) <= 0}
                icon={<Send className="w-4 h-4" />}
              >
                Continue
              </Button>
            </div>
          </motion.div>
        )}

        {/* ENCRYPTING */}
        {mobileStep === "encrypting" && (
          <motion.div
            key="encrypting"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex items-center justify-center px-4"
          >
            <EncryptionProgress progress={payment.encryptionProgress} />
          </motion.div>
        )}

        {/* CONFIRMING */}
        {mobileStep === "confirming" && (
          <motion.div
            key="confirming"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex-1 px-4 space-y-4"
          >
            <GlassCard variant="elevated">
              <div className="text-center mb-4">
                <p className="text-caption text-neutral-500">Sending</p>
                <p className="text-3xl font-mono font-bold text-accent tabular-nums mt-1">
                  ${payment.amount}
                </p>
                <p className="text-xs text-neutral-600 mt-1">USDC (encrypted)</p>
              </div>
              <div className="space-y-2 rounded-xl bg-glass-surface border border-glass-border p-3">
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-500">To</span>
                  <span className="font-mono text-white">{payment.recipient.slice(0, 10)}...{payment.recipient.slice(-6)}</span>
                </div>
                {payment.note && (
                  <div className="flex justify-between text-sm">
                    <span className="text-neutral-500">Note</span>
                    <span className="text-white">{payment.note}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-500">Network</span>
                  <span className="text-white">Base Sepolia</span>
                </div>
              </div>
            </GlassCard>
            <div className="flex gap-3">
              <Button variant="secondary" size="lg" className="flex-1" onClick={() => { setMobileStep("amount"); payment.goBack(); }}>
                Back
              </Button>
              <Button variant="primary" size="lg" className="flex-1" onClick={handleConfirmSend} icon={<Send className="w-4 h-4" />}>
                Confirm Send
              </Button>
            </div>
          </motion.div>
        )}

        {/* SENDING */}
        {mobileStep === "sending" && (
          <motion.div
            key="sending"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center px-4"
          >
            <div className="relative w-16 h-16 mb-6">
              <div className="absolute inset-0 rounded-full border-2 border-white/[0.06]" />
              <div className="absolute inset-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            </div>
            <p className="text-lg font-semibold text-white">Sending Payment</p>
            <p className="text-sm text-neutral-500 mt-1">Submitting to Base Sepolia...</p>
          </motion.div>
        )}

        {/* SUCCESS */}
        {mobileStep === "success" && (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="flex-1 flex flex-col items-center justify-center px-4"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.1 }}
              className="w-20 h-20 rounded-full bg-accent/10 flex items-center justify-center mb-6"
            >
              <CheckCircle className="w-10 h-10 text-accent" />
            </motion.div>
            <p className="text-xl font-bold text-white">Payment Sent!</p>
            <p className="text-sm text-neutral-500 mt-1">${payment.amount} USDC (encrypted)</p>
            <Button
              variant="primary"
              size="lg"
              className="mt-8 w-full"
              onClick={() => { payment.reset(); setMobileStep("amount"); }}
            >
              Send Another
            </Button>
          </motion.div>
        )}

        {/* ERROR */}
        {mobileStep === "error" && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center px-4"
          >
            <div className="w-20 h-20 rounded-full bg-error/10 flex items-center justify-center mb-6">
              <AlertTriangle className="w-10 h-10 text-error" />
            </div>
            <p className="text-xl font-bold text-error">Payment Failed</p>
            <p className="text-sm text-neutral-400 mt-2 text-center">{payment.error}</p>
            <Button
              variant="secondary"
              size="lg"
              className="mt-8 w-full"
              onClick={() => { payment.goBack(); setMobileStep("amount"); }}
              icon={<RotateCcw className="w-4 h-4" />}
            >
              Try Again
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Details Bottom Sheet */}
      <BottomSheet
        isOpen={showDetails}
        onClose={() => setShowDetails(false)}
        title="Payment Details"
      >
        <div className="space-y-4 px-1">
          <Input
            label="Recipient"
            placeholder="0x... address"
            value={payment.recipient}
            onChange={(e) => payment.setRecipient(e.target.value)}
          />
          <Input
            label="Note (optional)"
            placeholder="What is this for?"
            value={payment.note}
            onChange={(e) => payment.setNote(e.target.value)}
          />
          <div className="rounded-xl bg-glass-surface border border-glass-border p-3">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-500">Amount</span>
              <span className="font-mono text-accent font-semibold">${payment.amount} USDC</span>
            </div>
            <div className="flex justify-between text-sm mt-2">
              <span className="text-neutral-500">Privacy</span>
              <span className="text-encrypted text-xs">FHE Encrypted</span>
            </div>
          </div>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleSend}
            disabled={!payment.canProceed}
            icon={<Lock className="w-4 h-4" />}
          >
            Encrypt & Send
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
