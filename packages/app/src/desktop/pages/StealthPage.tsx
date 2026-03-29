import { motion, AnimatePresence } from "framer-motion";
import { useState, useCallback } from "react";
import { useAccount } from "wagmi";
import {
  EyeOff,
  Send,
  Copy,
  Check,
  Download,
  AlertTriangle,
  ArrowRight,
  Lock,
  Loader2,
  Info,
  Hash,
  Shield,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { useStealthPayments } from "@/hooks/useStealthPayments";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { CONTRACTS } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";

// ─── QR Code SVG Generator (minimal, no external dependency) ─────────
// Generates a simple visual representation of a hex string as a grid pattern.
// For production, swap in `qrcode.react` or similar.

function HexGridVisual({ data, size = 160 }: { data: string; size?: number }) {
  const hex = data.replace(/^0x/, "");
  const cells = 8;
  const cellSize = size / cells;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rounded-xl">
      <rect width={size} height={size} fill="#0a0a0c" rx={12} />
      {Array.from({ length: cells * cells }, (_, i) => {
        const charCode = parseInt(hex[i % hex.length] || "0", 16);
        const row = Math.floor(i / cells);
        const col = i % cells;
        const opacity = (charCode / 15) * 0.8 + 0.1;
        return (
          <rect
            key={i}
            x={col * cellSize + 2}
            y={row * cellSize + 2}
            width={cellSize - 4}
            height={cellSize - 4}
            rx={3}
            fill={`rgba(139, 92, 246, ${opacity})`}
          />
        );
      })}
    </svg>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function isValidBytes32(val: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(val);
}

// ─── How It Works Step ──────────────────────────────────────────────

function StepRow({
  step,
  title,
  description,
}: {
  step: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-4 items-start">
      <div className="w-8 h-8 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
        <span className="text-sm font-semibold text-violet-400">{step}</span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="text-xs text-neutral-500 mt-0.5">{description}</p>
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────

export function StealthPage() {
  const { isConnected } = useAccount();
  const { hasBalance } = useEncryptedBalance();
  const navigate = useNavigate();
  const {
    step: txStep,
    error: txError,
    sendStealth,
    claimStealth,
    finalizeClaim,
    reset,
  } = useStealthPayments();

  // Send form
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  // Success state
  const [lastClaimCode, setLastClaimCode] = useState<string | null>(null);
  const [lastTransferId, setLastTransferId] = useState<number | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Claim form
  const [claimTransferId, setClaimTransferId] = useState("");
  const [claimCode, setClaimCode] = useState("");

  // Finalize form
  const [finalizeId, setFinalizeId] = useState("");

  if (!isConnected) return <ConnectPrompt />;

  const isSending =
    txStep === "approving" || txStep === "encrypting" || txStep === "sending";

  const handleSend = async () => {
    if (!recipient.trim() || !amount.trim()) return;
    const result = await sendStealth(
      amount,
      recipient.trim(),
      CONTRACTS.FHERC20Vault_USDC,
      note.trim()
    );
    if (result) {
      setLastClaimCode(result.claimCode);
      setLastTransferId(result.transferId);
      setRecipient("");
      setAmount("");
      setNote("");
    }
  };

  const handleCopyCode = useCallback(async () => {
    if (!lastClaimCode) return;
    await copyToClipboard(lastClaimCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  }, [lastClaimCode]);

  const handleClaim = async () => {
    if (!claimTransferId.trim() || !claimCode.trim()) return;
    const hash = await claimStealth(
      parseInt(claimTransferId, 10),
      claimCode.trim()
    );
    if (hash) {
      setClaimTransferId("");
      setClaimCode("");
    }
  };

  const handleFinalize = async () => {
    if (!finalizeId.trim()) return;
    await finalizeClaim(parseInt(finalizeId, 10));
  };

  const sendButtonLabel =
    txStep === "approving"
      ? "Approving..."
      : txStep === "encrypting"
        ? "Encrypting recipient..."
        : txStep === "sending"
          ? "Sending..."
          : "Send Anonymously";

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
              <p className="text-xs text-warning/70 mt-1">You need to shield USDC into your encrypted vault before sending stealth payments. Go to Dashboard and click &ldquo;Shield Tokens&rdquo;.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate("/")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        </GlassCard>
      )}

      {/* ── Header ── */}
      <div>
        <h1 className="text-heading-1 font-semibold tracking-tight text-white">
          Stealth Payments
        </h1>
        <p className="text-base text-apple-secondary font-medium mt-1">
          Anonymous transfers — nobody sees the recipient
        </p>
      </div>

      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6"
      >
        {/* ── Send Stealth Card ── */}
        <motion.div variants={fadeInUp} className="space-y-6">
          <GlassCard
            variant="elevated"
            className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
          >
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                <EyeOff className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <h3 className="text-subheading font-semibold">
                  Send Stealth Payment
                </h3>
                <p className="text-caption text-apple-secondary">
                  Recipient identity is encrypted on-chain
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <Input
                label="Recipient Address"
                placeholder="0x..."
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                error={
                  recipient && !isValidAddress(recipient)
                    ? "Invalid Ethereum address"
                    : undefined
                }
              />
              <Input
                label="Amount (USDC)"
                placeholder="100.00"
                isAmount
                value={amount}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "" || /^\d*\.?\d{0,6}$/.test(val)) {
                    setAmount(val);
                  }
                }}
              />
              <Input
                label="Note"
                placeholder="Optional message (public on-chain)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />

              {txError && txStep === "error" && (
                <div className="rounded-xl bg-error/10 border border-error/20 px-4 py-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                  <p className="text-xs text-error">{txError}</p>
                </div>
              )}

              {/* Step progress during send */}
              {isSending && (
                <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
                  <div className="flex items-center justify-center gap-2 mb-2">
                    {["Approving", "Encrypting", "Sending"].map((label, i) => {
                      const stepIndex = txStep === "approving" ? 0 : txStep === "encrypting" ? 1 : txStep === "sending" ? 2 : -1;
                      const isComplete = i < stepIndex;
                      const isActive = i === stepIndex;
                      return (
                        <div key={label} className="flex items-center gap-2">
                          <div
                            className={`w-2 h-2 rounded-full transition-all duration-500 ${
                              isComplete
                                ? "bg-accent shadow-[0_0_8px_rgba(52,211,153,0.4)]"
                                : isActive
                                ? "bg-violet-400 shadow-[0_0_8px_rgba(139,92,246,0.4)] animate-pulse"
                                : "bg-white/10"
                            }`}
                          />
                          {i < 2 && (
                            <div className={`w-6 h-px ${isComplete ? "bg-accent" : "bg-white/10"}`} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-neutral-400 text-center">
                    {txStep === "approving" && "Approving vault access..."}
                    {txStep === "encrypting" && "Encrypting recipient address with FHE..."}
                    {txStep === "sending" && "Submitting to Base Sepolia..."}
                  </p>
                </div>
              )}

              <Button
                variant="primary"
                size="lg"
                className="w-full"
                icon={
                  isSending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )
                }
                onClick={handleSend}
                loading={isSending}
                disabled={
                  !isValidAddress(recipient) ||
                  !amount ||
                  parseFloat(amount) <= 0
                }
              >
                {sendButtonLabel}
              </Button>
            </div>
          </GlassCard>

          {/* ── Claim Code Display (appears after success) ── */}
          <AnimatePresence>
            {lastClaimCode && (
              <motion.div
                initial={{ opacity: 0, y: 16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.97 }}
                transition={{ type: "spring", stiffness: 300, damping: 25 }}
              >
                <GlassCard className="!border-violet-500/20 !bg-violet-500/[0.04] !rounded-[2rem]">
                  <div className="flex items-center gap-2 mb-4">
                    <Lock className="w-5 h-5 text-violet-400" />
                    <h3 className="text-subheading font-semibold text-violet-300">
                      Claim Code Generated
                    </h3>
                  </div>

                  <div className="flex flex-col items-center gap-4 mb-4">
                    {/* QR-like visual */}
                    <HexGridVisual data={lastClaimCode} size={140} />

                    {/* Claim code */}
                    <div className="w-full rounded-xl bg-black/40 border border-violet-500/15 p-3">
                      <code className="text-xs font-mono text-violet-300 break-all select-all block leading-relaxed">
                        {lastClaimCode}
                      </code>
                    </div>

                    {/* Transfer ID */}
                    {lastTransferId !== null && (
                      <div className="flex items-center gap-2 text-sm">
                        <Hash className="w-3.5 h-3.5 text-neutral-500" />
                        <span className="text-neutral-500">Transfer ID:</span>
                        <span className="font-mono tabular-nums text-white font-semibold">
                          {lastTransferId}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Warning */}
                  <div className="rounded-xl bg-warning/10 border border-warning/20 px-4 py-3 mb-4">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                      <p className="text-xs text-warning/80">
                        Share this code ONLY with the intended recipient. Anyone
                        with the code and the correct address can claim the
                        payment.
                      </p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      size="md"
                      className="flex-1"
                      icon={
                        copiedCode ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )
                      }
                      onClick={handleCopyCode}
                    >
                      {copiedCode ? "Copied!" : "Copy Code"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      onClick={() => {
                        setLastClaimCode(null);
                        setLastTransferId(null);
                        reset();
                      }}
                    >
                      Dismiss
                    </Button>
                  </div>
                </GlassCard>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* ── Right Column: Claim + Finalize + How It Works ── */}
        <motion.div variants={fadeInUp} className="space-y-6">
          {/* Claim Stealth Card */}
          <GlassCard
            variant="elevated"
            className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
          >
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                <Download className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <h3 className="text-subheading font-semibold">
                  Claim Stealth Payment
                </h3>
                <p className="text-caption text-apple-secondary">
                  Enter the transfer ID and claim code from the sender
                </p>
              </div>
            </div>

            <div className="space-y-4">
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
                className="font-mono text-sm"
                error={
                  claimCode && !isValidBytes32(claimCode)
                    ? "Must be a 32-byte hex string (0x + 64 hex chars)"
                    : undefined
                }
              />
              <Button
                variant="secondary"
                size="lg"
                className="w-full"
                icon={<ArrowRight className="w-4 h-4" />}
                onClick={handleClaim}
                loading={txStep === "claiming"}
                disabled={
                  !claimTransferId || !isValidBytes32(claimCode)
                }
              >
                {txStep === "claiming" ? "Claiming..." : "Claim Payment"}
              </Button>
            </div>

            {/* Finalize section */}
            <div className="border-t border-white/[0.06] pt-5 mt-5 space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-white mb-1">
                  Finalize Claim
                </h4>
                <p className="text-caption text-apple-secondary">
                  After claiming, wait for FHE decryption to resolve, then
                  finalize to release funds.
                </p>
              </div>
              <Input
                label="Transfer ID"
                placeholder="0"
                type="number"
                value={finalizeId}
                onChange={(e) => setFinalizeId(e.target.value)}
              />
              <Button
                variant="secondary"
                size="lg"
                className="w-full"
                icon={<Check className="w-4 h-4" />}
                onClick={handleFinalize}
                loading={txStep === "finalizing"}
                disabled={!finalizeId}
              >
                {txStep === "finalizing" ? "Finalizing..." : "Finalize"}
              </Button>

              {/* Empty state for no pending claims */}
              <div className="flex flex-col items-center justify-center py-8 border-t border-white/[0.06] mt-5">
                <div className="relative mb-4">
                  <motion.div
                    animate={{ scale: [1, 1.3, 1], opacity: [0.15, 0.05, 0.15] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute inset-0 rounded-2xl bg-violet-400/20"
                    style={{ filter: "blur(16px)" }}
                    aria-hidden="true"
                  />
                  <div className="relative w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}>
                      <Download className="w-6 h-6 text-neutral-600" />
                    </motion.div>
                  </div>
                </div>
                <p className="text-sm font-semibold text-neutral-400 mb-1">No pending claims</p>
                <p className="text-xs text-neutral-600 text-center max-w-[200px]">
                  Claims will appear here when someone sends you a stealth payment
                </p>
              </div>
            </div>
          </GlassCard>

          {/* How It Works */}
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <div className="flex items-center gap-2 mb-5">
              <Info className="w-4 h-4 text-violet-400" />
              <h3 className="text-subheading font-semibold">How It Works</h3>
            </div>
            <div className="space-y-5">
              <StepRow
                step={1}
                title="Sender deposits with encrypted recipient"
                description="The deposit amount is public (like shield/unshield), but the recipient address is FHE-encrypted. Nobody on-chain can see who the payment is for."
              />
              <StepRow
                step={2}
                title="Recipient claims with secret code"
                description="The sender shares the claim code off-chain. The code is bound to the recipient's address, preventing front-running."
              />
              <StepRow
                step={3}
                title="FHE verifies identity"
                description="The contract uses FHE.eq() to check if the claimer matches the encrypted recipient. Wrong claimer gets zero tokens (no revert, privacy preserved)."
              />
            </div>
          </GlassCard>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
