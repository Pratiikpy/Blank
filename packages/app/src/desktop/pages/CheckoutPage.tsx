import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSearchParams, Link } from "react-router-dom";
import { useAccount, useConnect } from "wagmi";
import {
  Lock,
  Shield,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  ExternalLink,
  ArrowRight,
  Store,
  FileText,
  Loader2,
  Wallet,
} from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { useSendPayment } from "@/hooks/useSendPayment";
import { APP_NAME, BASE_SEPOLIA } from "@/lib/constants";

// ─── Animation Variants ──────────────────────────────────────────────

const scaleCenter = {
  initial: { opacity: 0, scale: 0.92 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.4 },
  },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.25 } },
};

const springIn = {
  initial: { opacity: 0, scale: 0.88 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { type: "spring" as const, stiffness: 300, damping: 25 },
  },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.2 } },
};

const riseIn = {
  initial: { opacity: 0, y: 16 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35 },
  },
  exit: { opacity: 0, y: -12, transition: { duration: 0.25 } },
};

// ─── Helpers ─────────────────────────────────────────────────────────

function formatAmount(raw: string): string {
  const num = parseFloat(raw);
  if (isNaN(num)) return "0.00";
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function shortenAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function isValidEthAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

// ─── Component ───────────────────────────────────────────────────────

export function CheckoutPage() {
  const [searchParams] = useSearchParams();
  const { isConnected, address } = useAccount();
  const { connect, connectors, isPending: isConnectPending } = useConnect();

  // Parse URL params
  const toParam = searchParams.get("to") || "";
  const amountParam = searchParams.get("amount") || "";
  const tokenParam = searchParams.get("token") || "USDC";
  const orderIdParam = searchParams.get("orderId") || "";
  const merchantParam = searchParams.get("merchant") || "";
  const callbackParam = searchParams.get("callback") || "";

  // Payment hook
  const payment = useSendPayment();

  // Pre-fill payment data when wallet connects
  const hasInitialized = useState(false);
  useEffect(() => {
    if (isConnected && !hasInitialized[0]) {
      if (toParam) payment.setRecipient(toParam);
      if (amountParam) payment.setAmount(amountParam);
      if (tokenParam) payment.setToken(tokenParam);
      if (orderIdParam || merchantParam) {
        const noteParts: string[] = [];
        if (merchantParam) noteParts.push(`Payment to ${merchantParam}`);
        if (orderIdParam) noteParts.push(`Order: ${orderIdParam}`);
        payment.setNote(noteParts.join(" | "));
      }
      hasInitialized[1](true);
    }
  }, [isConnected, toParam, amountParam, tokenParam, orderIdParam, merchantParam, payment, hasInitialized]);

  // Validation
  const isValidAddress = isValidEthAddress(toParam);
  const isSelf = address?.toLowerCase() === toParam.toLowerCase();
  const hasAmount = amountParam.length > 0 && parseFloat(amountParam) > 0;
  const canPay = isConnected && isValidAddress && !isSelf && hasAmount;

  // Early return: missing required params
  if (!toParam) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8">
        <h1 className="text-2xl font-semibold text-white mb-4">Invalid Checkout Link</h1>
        <p className="text-apple-secondary mb-6">
          This checkout link is missing required parameters (to, amount).
        </p>
        <Link to="/" className="text-accent hover:underline">
          Go to Dashboard
        </Link>
      </div>
    );
  }

  // Initiate payment: encrypt then auto-confirm
  const handlePay = useCallback(async () => {
    if (!canPay) return;
    await payment.send();
  }, [canPay, payment]);

  // Auto-confirm after encryption completes
  useEffect(() => {
    if (payment.step === "confirming") {
      payment.confirmSend();
    }
  }, [payment.step, payment.confirmSend]);

  // Return to merchant
  const handleReturnToMerchant = useCallback(() => {
    if (callbackParam) {
      // Build callback URL with tx hash
      const url = new URL(callbackParam);
      if (payment.txHash) url.searchParams.set("txHash", payment.txHash);
      if (orderIdParam) url.searchParams.set("orderId", orderIdParam);
      url.searchParams.set("status", "success");
      window.location.href = url.toString();
    }
  }, [callbackParam, payment.txHash, orderIdParam]);

  // Formatted display values
  const displayAmount = useMemo(() => formatAmount(amountParam), [amountParam]);

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-black relative overflow-hidden">
      {/* Background gradient */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse 60% 40% at 50% 0%, rgba(52,211,153,0.04) 0%, transparent 60%),
            radial-gradient(ellipse 40% 30% at 80% 100%, rgba(139,92,246,0.03) 0%, transparent 50%)
          `,
        }}
        aria-hidden="true"
      />

      {/* Grid pattern */}
      <div
        className="absolute inset-0 grid-pattern opacity-20 pointer-events-none"
        aria-hidden="true"
      />

      {/* Content */}
      <div className="relative z-10 flex items-center justify-center min-h-dvh px-4 py-8">
        <motion.div
          variants={pageVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="w-full max-w-md space-y-5"
        >
          {/* ─── Header ─────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="text-center"
          >
            <div className="flex items-center justify-center gap-2.5 mb-3">
              <div className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/[0.08] flex items-center justify-center">
                <Lock className="w-[18px] h-[18px] text-accent/70" strokeWidth={1.5} />
              </div>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              Payment Request
            </h1>
            <p className="text-sm text-neutral-500 mt-1.5">
              Encrypted payment via {APP_NAME}
            </p>
          </motion.div>

          {/* ─── Step-based rendering ────────────────────────────── */}
          <AnimatePresence mode="wait">
            {/* ═══ PAYMENT FORM (input / not connected) ═══ */}
            {(payment.step === "input" || !isConnected) && (
              <motion.div
                key="checkout-form"
                variants={scaleCenter}
                initial="initial"
                animate="animate"
                exit="exit"
                className="space-y-5"
              >
                {/* Merchant Card */}
                <GlassCard
                  variant="elevated"
                  className="relative overflow-hidden !bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
                >
                  {/* Decorative glow */}
                  <div
                    className="absolute -top-16 -right-16 w-48 h-48 rounded-full pointer-events-none"
                    style={{
                      background:
                        "radial-gradient(circle, rgba(52,211,153,0.06) 0%, transparent 70%)",
                    }}
                    aria-hidden="true"
                  />

                  <motion.div
                    variants={staggerContainer}
                    initial="initial"
                    animate="animate"
                    className="relative space-y-5"
                  >
                    {/* Merchant info */}
                    {merchantParam && (
                      <motion.div variants={fadeInUp}>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
                            <Store className="w-5 h-5 text-accent" />
                          </div>
                          <div>
                            <p className="label text-neutral-500">Merchant</p>
                            <p className="text-base font-semibold text-white">
                              {merchantParam}
                            </p>
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {/* Order ID */}
                    {orderIdParam && (
                      <motion.div variants={fadeInUp}>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                            <FileText className="w-5 h-5 text-purple-400" />
                          </div>
                          <div>
                            <p className="label text-neutral-500">Order ID</p>
                            <p className="text-sm font-mono text-neutral-300">
                              {orderIdParam}
                            </p>
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {/* Recipient address */}
                    <motion.div variants={fadeInUp}>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                          <Wallet className="w-5 h-5 text-blue-400" />
                        </div>
                        <div>
                          <p className="label text-neutral-500">Paying to</p>
                          {isValidAddress ? (
                            <p className="text-sm font-mono text-neutral-300">
                              {shortenAddress(toParam)}
                            </p>
                          ) : (
                            <p className="text-sm text-red-400">
                              {toParam ? "Invalid address" : "No address specified"}
                            </p>
                          )}
                        </div>
                      </div>
                      {isSelf && (
                        <p className="text-xs text-red-400 mt-1.5 ml-[52px]">
                          You cannot pay yourself
                        </p>
                      )}
                    </motion.div>

                    {/* Amount display */}
                    <motion.div variants={fadeInUp}>
                      <div className="rounded-2xl bg-void-surface border border-glass-border p-5 text-center">
                        <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                          Amount
                        </p>
                        <div className="flex items-baseline justify-center gap-2">
                          <span className="text-4xl font-mono font-bold text-white tabular-nums tracking-tight">
                            {hasAmount ? displayAmount : "0.00"}
                          </span>
                          <span className="text-lg font-semibold text-neutral-500">
                            {tokenParam}
                          </span>
                        </div>
                      </div>
                    </motion.div>

                    {/* Privacy notice */}
                    <motion.div variants={fadeInUp}>
                      <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-accent/[0.04] border border-accent/10">
                        <Shield
                          className="w-4 h-4 text-accent/60 mt-0.5 shrink-0"
                          strokeWidth={1.5}
                        />
                        <p className="text-xs text-neutral-400 leading-relaxed">
                          This payment will be encrypted with FHE. Only you and the
                          merchant can see the amount.
                        </p>
                      </div>
                    </motion.div>
                  </motion.div>
                </GlassCard>

                {/* Action button */}
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    delay: 0.2,
                    duration: 0.4,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                >
                  {!isConnected ? (
                    <div className="space-y-3">
                      {connectors.slice(0, 2).map((connector, idx) => (
                        <Button
                          key={connector.uid}
                          variant={idx === 0 ? "primary" : "secondary"}
                          size="lg"
                          className="w-full"
                          onClick={() => connect({ connector })}
                          loading={isConnectPending}
                          icon={
                            idx === 0 ? (
                              <Wallet className="w-4 h-4" />
                            ) : undefined
                          }
                        >
                          {idx === 0
                            ? "Connect Wallet to Pay"
                            : `Connect ${connector.name}`}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <Button
                      variant="primary"
                      size="lg"
                      className="w-full"
                      disabled={!canPay}
                      onClick={handlePay}
                      icon={<ArrowRight className="w-4 h-4" />}
                    >
                      {!isValidAddress
                        ? "Invalid payment address"
                        : isSelf
                          ? "Cannot pay yourself"
                          : !hasAmount
                            ? "No amount specified"
                            : `Pay ${displayAmount} ${tokenParam}`}
                    </Button>
                  )}
                </motion.div>
              </motion.div>
            )}

            {/* ═══ ENCRYPTING ═══ */}
            {isConnected &&
              (payment.step === "encrypting" ||
                payment.step === "approving") && (
                <motion.div
                  key="checkout-encrypting"
                  variants={scaleCenter}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  <GlassCard
                    variant="elevated"
                    className="text-center py-12 !bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
                  >
                    <div className="relative w-14 h-14 mx-auto mb-5">
                      <div className="absolute inset-0 rounded-full border-2 border-white/[0.06]" />
                      <div className="absolute inset-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                      <div className="absolute inset-2 rounded-full bg-accent/5 flex items-center justify-center">
                        <Lock className="w-4 h-4 text-accent/70" />
                      </div>
                    </div>
                    <h3 className="text-lg font-semibold text-white">
                      Encrypting Payment
                    </h3>
                    <p className="text-sm text-neutral-500 mt-1.5 max-w-xs mx-auto">
                      Generating zero-knowledge proof for your encrypted amount...
                    </p>
                    <p className="text-xs text-neutral-600 mt-3 font-mono tabular-nums">
                      This may take a few seconds
                    </p>
                  </GlassCard>
                </motion.div>
              )}

            {/* ═══ SENDING (on-chain tx) ═══ */}
            {isConnected && payment.step === "sending" && (
              <motion.div
                key="checkout-sending"
                variants={scaleCenter}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <GlassCard
                  variant="elevated"
                  className="text-center py-12 !bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
                >
                  <div className="relative w-14 h-14 mx-auto mb-5">
                    <div className="absolute inset-0 rounded-full border-2 border-white/[0.06]" />
                    <div className="absolute inset-0 rounded-full border-2 border-apple-green border-t-transparent animate-spin" />
                    <div className="absolute inset-2 rounded-full bg-apple-green/5 flex items-center justify-center">
                      <div className="w-1.5 h-1.5 rounded-full bg-apple-green animate-pulse" />
                    </div>
                  </div>
                  <h3 className="text-lg font-semibold text-white">
                    Sending Payment
                  </h3>
                  <p className="text-sm text-neutral-500 mt-1.5 max-w-xs mx-auto">
                    Submitting encrypted transaction to Base Sepolia...
                  </p>
                  <p className="text-xs text-neutral-600 mt-3 font-mono tabular-nums">
                    Typically 5-15 seconds
                  </p>
                </GlassCard>
              </motion.div>
            )}

            {/* ═══ CONFIRMING (auto-handled, show sending state) ═══ */}
            {isConnected && payment.step === "confirming" && (
              <motion.div
                key="checkout-confirming"
                variants={scaleCenter}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <GlassCard
                  variant="elevated"
                  className="text-center py-12 !bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
                >
                  <div className="relative w-14 h-14 mx-auto mb-5">
                    <div className="absolute inset-0 rounded-full border-2 border-white/[0.06]" />
                    <div className="absolute inset-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                    <div className="absolute inset-2 rounded-full bg-accent/5 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-accent/70 animate-spin" />
                    </div>
                  </div>
                  <h3 className="text-lg font-semibold text-white">
                    Confirming Transaction
                  </h3>
                  <p className="text-sm text-neutral-500 mt-1.5 max-w-xs mx-auto">
                    Please confirm the transaction in your wallet...
                  </p>
                </GlassCard>
              </motion.div>
            )}

            {/* ═══ SUCCESS ═══ */}
            {isConnected && payment.step === "success" && (
              <motion.div
                key="checkout-success"
                variants={springIn}
                initial="initial"
                animate="animate"
                exit="exit"
                className="space-y-5"
              >
                <GlassCard
                  variant="elevated"
                  className="text-center !bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
                >
                  {/* Success checkmark */}
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{
                      type: "spring",
                      stiffness: 300,
                      damping: 20,
                      delay: 0.1,
                    }}
                    className="w-16 h-16 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-5"
                  >
                    <CheckCircle2 className="w-8 h-8 text-accent" />
                  </motion.div>

                  <h3 className="text-xl font-semibold text-white">
                    Payment Confirmed
                  </h3>
                  <p className="text-sm text-neutral-500 mt-1.5 max-w-xs mx-auto">
                    Your encrypted payment has been sent successfully.
                  </p>

                  {/* Transaction details */}
                  <div className="mt-6 space-y-3">
                    <div className="rounded-xl bg-void-surface border border-glass-border p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                          Amount Paid
                        </span>
                        <span className="text-sm font-mono font-semibold text-white tabular-nums">
                          {displayAmount} {tokenParam}
                        </span>
                      </div>
                      {merchantParam && (
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                            Merchant
                          </span>
                          <span className="text-sm font-medium text-neutral-300">
                            {merchantParam}
                          </span>
                        </div>
                      )}
                      {orderIdParam && (
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                            Order ID
                          </span>
                          <span className="text-sm font-mono text-neutral-300">
                            {orderIdParam}
                          </span>
                        </div>
                      )}
                      {payment.txHash && (
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                            Tx Hash
                          </span>
                          <a
                            href={`${BASE_SEPOLIA.explorerUrl}/tx/${payment.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs font-mono text-accent hover:text-accent/80 transition-colors"
                          >
                            {payment.txHash.slice(0, 10)}...
                            {payment.txHash.slice(-6)}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Privacy confirmation */}
                  <div className="flex items-center justify-center gap-1.5 mt-5 text-xs text-encrypted/50">
                    <Lock className="w-3 h-3" />
                    Amount encrypted with FHE on-chain
                  </div>
                </GlassCard>

                {/* Return to merchant / Done */}
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3, duration: 0.4 }}
                  className="space-y-3"
                >
                  {callbackParam && (
                    <Button
                      variant="primary"
                      size="lg"
                      className="w-full"
                      onClick={handleReturnToMerchant}
                      icon={<ExternalLink className="w-4 h-4" />}
                    >
                      Return to {merchantParam || "Merchant"}
                    </Button>
                  )}

                  {payment.txHash && (
                    <Button
                      variant="secondary"
                      size="lg"
                      className="w-full"
                      onClick={() =>
                        window.open(
                          `${BASE_SEPOLIA.explorerUrl}/tx/${payment.txHash}`,
                          "_blank"
                        )
                      }
                      icon={<ExternalLink className="w-4 h-4" />}
                    >
                      View on Explorer
                    </Button>
                  )}
                </motion.div>
              </motion.div>
            )}

            {/* ═══ ERROR ═══ */}
            {isConnected && payment.step === "error" && (
              <motion.div
                key="checkout-error"
                variants={riseIn}
                initial="initial"
                animate="animate"
                exit="exit"
                className="space-y-5"
              >
                <GlassCard
                  variant="elevated"
                  className="text-center !bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
                >
                  <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-5">
                    <AlertTriangle className="w-8 h-8 text-red-400" />
                  </div>

                  <h3 className="text-xl font-semibold text-red-400">
                    Payment Failed
                  </h3>
                  <p className="text-sm text-neutral-400 mt-2 max-w-sm mx-auto leading-relaxed">
                    {payment.error || "Something went wrong. Please try again."}
                  </p>
                </GlassCard>

                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full"
                  onClick={payment.goBack}
                  icon={<RotateCcw className="w-4 h-4" />}
                >
                  Try Again
                </Button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.6 }}
            className="text-center pt-2 pb-6"
          >
            <p className="text-[10px] text-neutral-700 tracking-[0.12em] uppercase">
              Powered by {APP_NAME} + Fhenix CoFHE
            </p>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
