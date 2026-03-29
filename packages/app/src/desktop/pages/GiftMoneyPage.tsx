import { motion, AnimatePresence, type Variants } from "framer-motion";
import { useState } from "react";
import { useAccount } from "wagmi";
import {
  Gift,
  Plus,
  X,
  Loader2,
  Check,
  PackageOpen,
  Send,
  Users,
  Shuffle,
  Equal,
  ChevronLeft,
  AlertTriangle,
  RotateCcw,
  Shield,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { pageVariants } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PillTabs } from "@/components/ui/PillTabs";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { useGiftMoney, computeEqualSplits, computeRandomSplits } from "@/hooks/useGiftMoney";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { CONTRACTS, BASE_SEPOLIA } from "@/lib/constants";

// ─── Types ──────────────────────────────────────────────────────────

type Tab = "create" | "claim" | "history";
type SplitType = "equal" | "random";

const tabs = [
  { id: "create" as Tab, label: "Create Gift" },
  { id: "claim" as Tab, label: "Open Envelope" },
  { id: "history" as Tab, label: "My Gifts" },
];

// ─── Framer Motion Variants ─────────────────────────────────────────

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

// ─── Component ──────────────────────────────────────────────────────

export function GiftMoneyPage() {
  const { isConnected } = useAccount();
  const gift = useGiftMoney();
  const { hasBalance } = useEncryptedBalance();
  const navigate = useNavigate();

  // ── Tab state ──
  const [tab, setTab] = useState<Tab>("create");

  // ── Create Gift state ──
  const [recipients, setRecipients] = useState<string[]>([""]);
  const [totalAmount, setTotalAmount] = useState("");
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [note, setNote] = useState("");

  // ── Claim Gift state ──
  const [envelopeId, setEnvelopeId] = useState("");
  const [claimSuccess, setClaimSuccess] = useState(false);

  // ── History state ──
  const [lastCreatedTx, setLastCreatedTx] = useState<string | null>(null);

  if (!isConnected) return <ConnectPrompt />;

  // ── Recipients management ──
  const addRecipient = () => setRecipients([...recipients, ""]);
  const removeRecipient = (i: number) => {
    if (recipients.length <= 1) return;
    setRecipients(recipients.filter((_, idx) => idx !== i));
  };
  const updateRecipient = (i: number, val: string) => {
    const updated = [...recipients];
    updated[i] = val;
    setRecipients(updated);
  };

  // ── Compute preview shares whenever inputs change ──
  const validRecipients = recipients.filter((r) => r.trim().length > 0);
  const recipientCount = validRecipients.length;

  const perPersonAmount =
    recipientCount > 0 && parseFloat(totalAmount) > 0
      ? (parseFloat(totalAmount) / recipientCount).toFixed(2)
      : "0.00";

  const canCreate =
    validRecipients.length > 0 &&
    parseFloat(totalAmount) > 0 &&
    !gift.isProcessing;

  // ── Handlers ──
  const handleCreateGift = async () => {
    if (!canCreate) return;

    const shares =
      splitType === "equal"
        ? computeEqualSplits(totalAmount, validRecipients.length)
        : computeRandomSplits(totalAmount, validRecipients.length);

    const hash = await gift.createGift(
      CONTRACTS.FHERC20Vault_USDC,
      shares,
      validRecipients,
      note
    );

    if (hash) {
      setLastCreatedTx(hash);
    }
  };

  const handleClaimGift = async () => {
    const id = parseInt(envelopeId, 10);
    if (isNaN(id) || id < 0) return;
    setClaimSuccess(false);
    const hash = await gift.claimGift(id);
    if (hash) {
      setClaimSuccess(true);
    }
  };

  const handleReset = () => {
    gift.reset();
    setRecipients([""]);
    setTotalAmount("");
    setNote("");
    setClaimSuccess(false);
    setEnvelopeId("");
  };

  // ── Map step to progress index ──
  function getStepIndex(step: string): number {
    switch (step) {
      case "approving":
        return 0;
      case "encrypting":
        return 1;
      case "confirming":
        return 2;
      case "sending":
        return 3;
      case "success":
        return 4;
      default:
        return -1;
    }
  }

  const stepLabels = ["Approving", "Encrypting", "Confirming", "Sending", "Complete"];
  const currentStepIndex = getStepIndex(gift.step);

  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="space-y-6"
    >
      {/* Shield-first warning */}
      {!hasBalance && (
        <GlassCard className="!rounded-[2rem] !bg-warning/5 !border-warning/20">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-warning">Shield tokens first</p>
              <p className="text-xs text-warning/70 mt-1">You need to shield USDC into your encrypted vault before creating gifts. Go to Dashboard and click &ldquo;Shield Tokens&rdquo;.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate("/")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        </GlassCard>
      )}

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
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
              className="text-3xl font-semibold tracking-tight text-white"
            >
              Gift Money
            </motion.h1>
            <p className="text-base text-apple-secondary font-medium mt-1">
              Encrypted red envelopes
            </p>
          </div>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <PillTabs
        tabs={tabs}
        activeTab={tab}
        onTabChange={(t) => {
          setTab(t as Tab);
          if (gift.step !== "input") handleReset();
        }}
        layoutId="gift-tab"
      />

      {/* ── Content ──────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {/* ════════════════════ CREATE TAB ════════════════════════════ */}
        {tab === "create" && gift.step === "input" && (
          <motion.div key="create-input" variants={riseIn} initial="initial" animate="animate" exit="exit">
            <GlassCard
              variant="elevated"
              className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
            >
              {/* Section icon + title */}
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <Gift className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white">Create Gift Envelope</h3>
                  <p className="text-caption text-apple-secondary">
                    Send encrypted gifts to multiple recipients
                  </p>
                </div>
              </div>

              <div className="space-y-5">
                {/* ── Recipients ── */}
                <div>
                  <span className="block mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                    Recipients
                  </span>
                  <div className="space-y-2">
                    <AnimatePresence initial={false}>
                      {recipients.map((addr, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2 }}
                          className="flex items-center gap-2"
                        >
                          <div className="flex-1">
                            <Input
                              placeholder={`0x... recipient ${i + 1}`}
                              value={addr}
                              onChange={(e) => updateRecipient(i, e.target.value)}
                            />
                          </div>
                          {recipients.length > 1 && (
                            <button
                              onClick={() => removeRecipient(i)}
                              className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center hover:bg-red-500/10 hover:border-red-500/20 transition-colors shrink-0"
                              aria-label={`Remove recipient ${i + 1}`}
                            >
                              <X className="w-4 h-4 text-neutral-500 hover:text-red-400" />
                            </button>
                          )}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Plus className="w-3.5 h-3.5" />}
                      onClick={addRecipient}
                    >
                      Add Recipient
                    </Button>
                  </div>
                </div>

                {/* ── Total Amount ── */}
                <Input
                  label="Total Amount (USDC)"
                  placeholder="100.00"
                  type="number"
                  step="0.01"
                  min="0"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                  isAmount
                  rightElement={
                    <span className="text-xs font-semibold text-neutral-500 tracking-wider">
                      USDC
                    </span>
                  }
                />

                {/* ── Split Type Selector ── */}
                <div>
                  <span className="block mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                    Split Type
                  </span>
                  <div className="grid grid-cols-2 gap-3">
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setSplitType("equal")}
                      className={`
                        relative flex items-center gap-3 p-4 rounded-xl border transition-all duration-200
                        ${
                          splitType === "equal"
                            ? "bg-accent/10 border-accent/30 shadow-[0_0_20px_rgba(52,211,153,0.1)]"
                            : "bg-white/[0.03] border-white/[0.08] hover:border-white/[0.14]"
                        }
                      `}
                    >
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                          splitType === "equal"
                            ? "bg-accent/20"
                            : "bg-white/[0.06]"
                        }`}
                      >
                        <Equal
                          className={`w-4.5 h-4.5 ${
                            splitType === "equal" ? "text-accent" : "text-neutral-500"
                          }`}
                        />
                      </div>
                      <div className="text-left">
                        <p
                          className={`text-sm font-semibold ${
                            splitType === "equal" ? "text-white" : "text-neutral-300"
                          }`}
                        >
                          Equal
                        </p>
                        <p className="text-[11px] text-neutral-500">Same for everyone</p>
                      </div>
                    </motion.button>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setSplitType("random")}
                      className={`
                        relative flex items-center gap-3 p-4 rounded-xl border transition-all duration-200
                        ${
                          splitType === "random"
                            ? "bg-encrypted/10 border-encrypted/30 shadow-[0_0_20px_rgba(167,139,250,0.1)]"
                            : "bg-white/[0.03] border-white/[0.08] hover:border-white/[0.14]"
                        }
                      `}
                    >
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                          splitType === "random"
                            ? "bg-encrypted/20"
                            : "bg-white/[0.06]"
                        }`}
                      >
                        <Shuffle
                          className={`w-4.5 h-4.5 ${
                            splitType === "random" ? "text-encrypted" : "text-neutral-500"
                          }`}
                        />
                      </div>
                      <div className="text-left">
                        <p
                          className={`text-sm font-semibold ${
                            splitType === "random" ? "text-white" : "text-neutral-300"
                          }`}
                        >
                          Random
                        </p>
                        <p className="text-[11px] text-neutral-500">Surprise amounts</p>
                      </div>
                    </motion.button>
                  </div>
                </div>

                {/* ── Split Preview ── */}
                {recipientCount > 0 && parseFloat(totalAmount) > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <Users className="w-3.5 h-3.5 text-neutral-500" />
                      <span className="text-caption font-medium text-neutral-400">
                        {recipientCount} recipient{recipientCount > 1 ? "s" : ""}
                      </span>
                    </div>
                    {splitType === "equal" ? (
                      <p className="text-sm text-accent font-mono tabular-nums">
                        {perPersonAmount} USDC each
                      </p>
                    ) : (
                      <p className="text-sm text-encrypted font-medium font-mono tabular-nums">
                        ~{perPersonAmount} USDC avg (randomized)
                      </p>
                    )}
                  </motion.div>
                )}

                {/* ── Note ── */}
                <Input
                  label="Note (optional)"
                  placeholder="Happy birthday! / Congrats! / ..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />

                {/* ── Error ── */}
                {gift.error && (
                  <p className="text-sm text-error flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {gift.error}
                  </p>
                )}

                {/* ── Submit ── */}
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  icon={<Gift className="w-4.5 h-4.5" />}
                  onClick={handleCreateGift}
                  loading={gift.isProcessing}
                  disabled={!canCreate}
                >
                  Create Gift Envelope
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}

        {/* ════════════════════ PROCESSING STATES ═══════════════════ */}
        {tab === "create" &&
          (gift.step === "approving" ||
            gift.step === "encrypting" ||
            gift.step === "confirming" ||
            gift.step === "sending") && (
            <motion.div key="processing" variants={scaleCenter} initial="initial" animate="animate" exit="exit">
              <GlassCard variant="elevated" className="text-center py-12">
                {/* Animated spinner */}
                <div className="relative w-16 h-16 mx-auto mb-6">
                  <div className="absolute inset-0 rounded-full border-2 border-white/[0.06]" />
                  <div className="absolute inset-0 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
                  <div className="absolute inset-2 rounded-full bg-amber-400/5 flex items-center justify-center">
                    <Gift className="w-6 h-6 text-amber-400" />
                  </div>
                </div>

                <h3 className="text-lg font-semibold text-white mb-2">
                  Creating Gift Envelope
                </h3>

                {/* Step progress */}
                <div className="flex items-center justify-center gap-2 mb-4">
                  {stepLabels.slice(0, 4).map((label, i) => (
                    <div key={label} className="flex items-center gap-2">
                      <div
                        className={`w-2 h-2 rounded-full transition-all duration-500 ${
                          i < currentStepIndex
                            ? "bg-accent shadow-[0_0_8px_rgba(52,211,153,0.4)]"
                            : i === currentStepIndex
                            ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.4)] animate-pulse"
                            : "bg-white/10"
                        }`}
                      />
                      {i < 3 && (
                        <div
                          className={`w-6 h-px ${
                            i < currentStepIndex ? "bg-accent" : "bg-white/10"
                          }`}
                        />
                      )}
                    </div>
                  ))}
                </div>

                <p className="text-sm text-neutral-400">
                  {gift.step === "approving" && "Approving vault access..."}
                  {gift.step === "encrypting" && "Encrypting gift amounts with FHE..."}
                  {gift.step === "confirming" && "Confirming encryption..."}
                  {gift.step === "sending" && "Submitting to Base Sepolia..."}
                </p>

                {gift.step === "encrypting" && (
                  <div className="mt-4 w-48 h-1.5 mx-auto rounded-full bg-white/[0.06] overflow-hidden">
                    <motion.div
                      className="h-full rounded-full bg-gradient-to-r from-encrypted to-accent"
                      initial={{ width: "0%" }}
                      animate={{ width: `${gift.encryptionProgress}%` }}
                      transition={{ duration: 0.3, ease: "easeOut" }}
                    />
                  </div>
                )}
              </GlassCard>
            </motion.div>
          )}

        {/* ════════════════════ SUCCESS STATE ═══════════════════════ */}
        {tab === "create" && gift.step === "success" && (
          <motion.div key="success" variants={springIn} initial="initial" animate="animate" exit="exit">
            <GlassCard variant="elevated" className="text-center py-12">
              {/* Success animation */}
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 400, damping: 15, delay: 0.1 }}
                className="w-20 h-20 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-6"
              >
                <motion.div
                  initial={{ scale: 0, rotate: -45 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 20, delay: 0.3 }}
                >
                  <Check className="w-10 h-10 text-accent" strokeWidth={3} />
                </motion.div>
              </motion.div>

              <h3 className="text-xl font-semibold text-white mb-2">
                Gift Envelope Created!
              </h3>
              <p className="text-sm text-neutral-400 mb-2">
                Your encrypted gifts have been sent to {validRecipients.length} recipient
                {validRecipients.length > 1 ? "s" : ""}.
              </p>

              {gift.txHash && (
                <a
                  href={`${BASE_SEPOLIA.explorerUrl}/tx/${gift.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono text-accent/70 hover:text-accent transition-colors underline underline-offset-2"
                >
                  View on BaseScan
                </a>
              )}

              <div className="flex items-center justify-center gap-3 mt-8">
                <Button
                  variant="secondary"
                  size="md"
                  icon={<RotateCcw className="w-4 h-4" />}
                  onClick={handleReset}
                >
                  Create Another
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}

        {/* ════════════════════ ERROR STATE ═════════════════════════ */}
        {tab === "create" && gift.step === "error" && (
          <motion.div key="error" variants={riseIn} initial="initial" animate="animate" exit="exit">
            <GlassCard variant="elevated" className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-5">
                <AlertTriangle className="w-8 h-8 text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-red-400">Gift Creation Failed</h3>
              <p className="text-sm text-neutral-400 mt-2 max-w-sm mx-auto leading-relaxed">
                {gift.error || "Something went wrong. Please try again."}
              </p>
              <Button
                variant="secondary"
                size="md"
                className="mt-6"
                onClick={handleReset}
                icon={<RotateCcw className="w-4 h-4" />}
              >
                Try Again
              </Button>
            </GlassCard>
          </motion.div>
        )}

        {/* ════════════════════ CLAIM TAB ════════════════════════════ */}
        {tab === "claim" && (
          <motion.div key="claim" variants={riseIn} initial="initial" animate="animate" exit="exit">
            <GlassCard
              variant="elevated"
              className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
            >
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center">
                  <PackageOpen className="w-5 h-5 text-rose-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white">Open Gift Envelope</h3>
                  <p className="text-caption text-apple-secondary">
                    Enter your envelope ID to claim your gift
                  </p>
                </div>
              </div>

              <div className="space-y-5">
                <Input
                  label="Envelope ID"
                  placeholder="0"
                  type="number"
                  min="0"
                  value={envelopeId}
                  onChange={(e) => {
                    setEnvelopeId(e.target.value);
                    setClaimSuccess(false);
                  }}
                />

                {gift.error && gift.step === "error" && (
                  <p className="text-sm text-error flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {gift.error}
                  </p>
                )}

                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  icon={
                    gift.isProcessing ? (
                      <Loader2 className="w-4.5 h-4.5 animate-spin" />
                    ) : (
                      <PackageOpen className="w-4.5 h-4.5" />
                    )
                  }
                  onClick={handleClaimGift}
                  loading={gift.isProcessing}
                  disabled={!envelopeId || gift.isProcessing}
                >
                  {gift.isProcessing ? "Opening..." : "Open Envelope"}
                </Button>

                {/* Claim success */}
                <AnimatePresence>
                  {claimSuccess && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9, y: 8 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.9, y: 8 }}
                      transition={{ type: "spring", stiffness: 400, damping: 20 }}
                      className="rounded-xl bg-accent/10 border border-accent/20 p-5 text-center"
                    >
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", stiffness: 500, damping: 15, delay: 0.15 }}
                        className="w-14 h-14 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-3"
                      >
                        <Check className="w-7 h-7 text-accent" strokeWidth={3} />
                      </motion.div>
                      <h4 className="text-lg font-semibold text-white mb-1">
                        Gift Opened!
                      </h4>
                      <p className="text-sm text-accent">
                        The encrypted amount has been added to your vault.
                      </p>
                      {gift.txHash && (
                        <a
                          href={`${BASE_SEPOLIA.explorerUrl}/tx/${gift.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-accent/60 hover:text-accent transition-colors mt-2 inline-block underline underline-offset-2"
                        >
                          View on BaseScan
                        </a>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </GlassCard>
          </motion.div>
        )}

        {/* ════════════════════ HISTORY TAB ══════════════════════════ */}
        {tab === "history" && (
          <motion.div key="history" variants={riseIn} initial="initial" animate="animate" exit="exit" className="space-y-4">
            {/* Last created gift */}
            {lastCreatedTx ? (
              <GlassCard
                variant="elevated"
                className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
                    <Send className="w-5 h-5 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-white">Last Gift Sent</h4>
                    <p className="text-xs font-mono text-neutral-500 truncate">
                      {lastCreatedTx}
                    </p>
                  </div>
                  <a
                    href={`${BASE_SEPOLIA.explorerUrl}/tx/${lastCreatedTx}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent hover:text-accent/80 transition-colors font-medium"
                  >
                    View
                  </a>
                </div>
              </GlassCard>
            ) : (
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
                        <Gift className="w-8 h-8 text-neutral-600" />
                      </motion.div>
                    </div>
                  </div>
                  <p className="text-lg font-semibold text-neutral-300 mb-1.5">No gifts yet</p>
                  <p className="text-sm text-neutral-500 text-center max-w-xs mb-6">
                    Create your first encrypted red envelope
                  </p>
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => setTab("create")}
                    icon={<Plus className="w-3.5 h-3.5" />}
                  >
                    Create First Gift
                  </Button>
                </div>
              </GlassCard>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
