import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { useLocation, useSearchParams, useNavigate } from "react-router-dom";
import { pageVariants } from "@/lib/animations";
import { useSendPayment } from "@/hooks/useSendPayment";
import { useContacts } from "@/hooks/useContacts";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { SendForm } from "@/components/payment/SendForm";
import { EncryptionProgress } from "@/components/payment/EncryptionProgress";
import { PaymentConfirm } from "@/components/payment/PaymentConfirm";
import { PaymentSuccess } from "@/components/payment/PaymentSuccess";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { StepProgressBar } from "@/components/payment/StepProgressBar";
import { QRScannerModal } from "@/components/payment/QRScannerModal";
import { AlertTriangle, RotateCcw, ScanLine, ChevronLeft, Shield } from "lucide-react";

// Map payment step to progress bar step index
function getProgressStep(step: string): number {
  if (step === "input" || step === "approving" || step === "encrypting") return 0;
  if (step === "confirming") return 1;
  if (step === "sending" || step === "success") return 2;
  return 0;
}

// ─── Directional slide variants ──────────────────────────────────────
// Input slides LEFT on exit; confirm slides in from RIGHT.
// Reverse when going back.

import type { Variants } from "framer-motion";

const slideLeft: Variants = {
  initial: { opacity: 0, x: 40 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, x: -40, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } },
};

const slideRight: Variants = {
  initial: { opacity: 0, x: -40 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, x: 40, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } },
};

const scaleCenter: Variants = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.25 } },
};

const springIn: Variants = {
  initial: { opacity: 0, scale: 0.88 },
  animate: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 300, damping: 25 } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.2 } },
};

const riseIn: Variants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -12, transition: { duration: 0.25 } },
};

// ─── Component ───────────────────────────────────────────────────────

export function SendPage() {
  const { isConnected } = useAccount();
  const payment = useSendPayment();
  const { contacts } = useContacts();
  const { hasBalance, formatted: encBalance, isDecrypted } = useEncryptedBalance();
  const navigate = useNavigate();
  const [showScanner, setShowScanner] = useState(false);

  // Pre-fill from navigation state (PayPage passes prefillRecipient/Amount/Note)
  const location = useLocation();
  const prefillState = location.state as {
    prefillRecipient?: string;
    prefillAmount?: string;
    prefillNote?: string;
    // Legacy keys (in case other pages use to/amount/note)
    to?: string;
    amount?: string;
    note?: string;
  } | null;

  // Pre-fill from URL search params (?to=0x...&amount=10&note=hello)
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const recipient =
      prefillState?.prefillRecipient ||
      prefillState?.to ||
      searchParams.get("to") ||
      "";
    const amount =
      prefillState?.prefillAmount ||
      prefillState?.amount ||
      searchParams.get("amount") ||
      "";
    const note =
      prefillState?.prefillNote ||
      prefillState?.note ||
      searchParams.get("note") ||
      "";

    if (recipient) payment.setRecipient(recipient);
    if (amount) payment.setAmount(amount);
    if (note) payment.setNote(note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset payment state when navigating away (handles back button)
  useEffect(() => {
    return () => {
      if (payment.step !== "input" && payment.step !== "success") {
        payment.reset();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (!isConnected) return <ConnectPrompt />;

  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="max-w-lg mx-auto"
    >
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between">
        <div className="flex items-start gap-4">
          <button
            onClick={() => window.history.back()}
            className="w-10 h-10 rounded-full bg-apple-gray6 hover:bg-apple-gray5 flex items-center justify-center transition-colors mt-0.5 shrink-0"
            aria-label="Go back"
          >
            <ChevronLeft className="w-5 h-5 text-white" />
          </button>
          <div>
            <motion.p
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="text-sm text-apple-secondary font-semibold uppercase tracking-widest mb-1"
            >
              FHE ENCRYPTED
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.04, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="text-heading-1 font-semibold tracking-tight text-white"
            >
              Send Money
            </motion.h1>
          </div>
        </div>
        <button
          onClick={() => setShowScanner(true)}
          className="w-10 h-10 rounded-full bg-apple-gray6 hover:bg-apple-gray5 flex items-center justify-center transition-colors"
          aria-label="Scan QR code"
        >
          <ScanLine className="w-5 h-5 text-white" />
        </button>
      </div>

      {/* Shield-first warning */}
      {!hasBalance && (
        <GlassCard className="!rounded-[2rem] !bg-warning/5 !border-warning/20 mb-6">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-warning">Shield tokens first</p>
              <p className="text-xs text-warning/70 mt-1">You need to shield USDC into your encrypted vault before sending. Go to Dashboard and click &ldquo;Shield Tokens&rdquo;.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate("/")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        </GlassCard>
      )}

      {/* Step progress bar */}
      <div className="mb-8">
        <StepProgressBar currentStep={getProgressStep(payment.step)} />
      </div>

      {/* Step-based rendering with directional transitions */}
      <AnimatePresence mode="wait">
        {/* ── INPUT ────────────────────────────────────────────────── */}
        {payment.step === "input" && (
          <motion.div key="input" variants={slideRight} initial="initial" animate="animate" exit="exit">
            <SendForm
              recipient={payment.recipient}
              amount={payment.amount}
              note={payment.note}
              token={payment.token}
              canProceed={payment.canProceed}
              cofheConnected={payment.cofheConnected}
              contacts={contacts.map((c) => ({ address: c.address, nickname: c.nickname }))}
              availableBalance={isDecrypted && encBalance ? encBalance : hasBalance ? "***.**" : undefined}
              onRecipientChange={payment.setRecipient}
              onAmountChange={payment.setAmount}
              onNoteChange={payment.setNote}
              onSend={payment.send}
            />
          </motion.div>
        )}

        {/* ── ENCRYPTING / APPROVING ──────────────────────────────── */}
        {(payment.step === "approving" || payment.step === "encrypting") && (
          <motion.div key="encrypting" variants={scaleCenter} initial="initial" animate="animate" exit="exit">
            <EncryptionProgress progress={payment.encryptionProgress} />
          </motion.div>
        )}

        {/* ── CONFIRMING ──────────────────────────────────────────── */}
        {payment.step === "confirming" && (
          <motion.div key="confirming" variants={slideLeft} initial="initial" animate="animate" exit="exit">
            <PaymentConfirm
              recipient={payment.recipient}
              amount={payment.amount}
              token={payment.token}
              note={payment.note}
              onConfirm={payment.confirmSend}
              onBack={payment.goBack}
            />
          </motion.div>
        )}

        {/* ── SENDING ─────────────────────────────────────────────── */}
        {payment.step === "sending" && (
          <motion.div key="sending" variants={scaleCenter} initial="initial" animate="animate" exit="exit">
            <GlassCard variant="elevated" className="text-center py-12">
              {/* Spinner ring */}
              <div className="relative w-14 h-14 mx-auto mb-5">
                <div className="absolute inset-0 rounded-full border-2 border-white/[0.06]" />
                <div className="absolute inset-0 rounded-full border-2 border-apple-green border-t-transparent animate-spin" />
                <div className="absolute inset-2 rounded-full bg-apple-green/5 flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-apple-green animate-pulse" />
                </div>
              </div>
              <h3 className="text-heading font-semibold text-white">
                Sending Payment
              </h3>
              <p className="text-body text-neutral-500 mt-1.5 max-w-xs mx-auto">
                Submitting encrypted transaction to Base Sepolia...
              </p>
              <p className="text-xs text-neutral-600 mt-3 font-mono tabular-nums">Typically 5-15 seconds</p>
            </GlassCard>
          </motion.div>
        )}

        {/* ── SUCCESS ─────────────────────────────────────────────── */}
        {payment.step === "success" && (
          <motion.div key="success" variants={springIn} initial="initial" animate="animate" exit="exit">
            <PaymentSuccess
              recipient={payment.recipient}
              amount={payment.amount}
              token={payment.token}
              note={payment.note}
              txHash={payment.txHash}
              onSendAnother={payment.reset}
            />
          </motion.div>
        )}

        {/* ── ERROR ───────────────────────────────────────────────── */}
        {payment.step === "error" && (
          <motion.div key="error" variants={riseIn} initial="initial" animate="animate" exit="exit">
            <GlassCard variant="elevated" className="text-center">
              {/* Error icon */}
              <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-5">
                <AlertTriangle className="w-8 h-8 text-red-400" />
              </div>

              <h3 className="text-heading font-semibold text-red-400">
                Payment Failed
              </h3>
              <p className="text-body text-neutral-400 mt-2 max-w-sm mx-auto leading-relaxed">
                {payment.error || "Something went wrong. Please try again."}
              </p>

              <Button
                variant="secondary"
                size="md"
                className="mt-6"
                onClick={payment.goBack}
                icon={<RotateCcw className="w-4 h-4" />}
              >
                Try Again
              </Button>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* QR Scanner Modal */}
      <QRScannerModal
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(address) => {
          payment.setRecipient(address);
          setShowScanner(false);
        }}
      />
    </motion.div>
  );
}
