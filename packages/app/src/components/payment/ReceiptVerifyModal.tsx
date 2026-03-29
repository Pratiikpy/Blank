import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Shield,
  Check,
  Lock,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Hash,
  FileText,
} from "lucide-react";
import { useAccount, useReadContract } from "wagmi";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CONTRACTS, ENCRYPTED_PLACEHOLDER } from "@/lib/constants";
import { PaymentReceiptsAbi } from "@/lib/abis";

// ─── Props ──────────────────────────────────────────────────────────

interface ReceiptVerifyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Inline ABI for verifyReceipt ───────────────────────────────────

const verifyReceiptAbi = [
  {
    type: "function",
    name: "verifyReceipt",
    inputs: [{ name: "receiptHash", type: "bytes32" }],
    outputs: [
      { name: "exists", type: "bool" },
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "token", type: "address" },
      { name: "timestamp", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

// ─── Types ──────────────────────────────────────────────────────────

interface ReceiptResult {
  exists: boolean;
  payer: `0x${string}`;
  payee: `0x${string}`;
  token: `0x${string}`;
  timestamp: bigint;
}

// ─── Animation Variants ─────────────────────────────────────────────

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 12 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: "spring" as const,
      stiffness: 300,
      damping: 25,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 12,
    transition: { duration: 0.2 },
  },
};

const resultVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: "spring" as const,
      stiffness: 260,
      damping: 22,
      delay: 0.1,
    },
  },
  exit: {
    opacity: 0,
    y: 8,
    transition: { duration: 0.15 },
  },
};

// ─── Helpers ────────────────────────────────────────────────────────

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function formatTimestamp(ts: bigint): string {
  const date = new Date(Number(ts) * 1000);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isValidBytes32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

// ─── My Receipts List ───────────────────────────────────────────────

function MyReceiptsList({
  receipts,
  isLoading,
  onSelect,
}: {
  receipts: readonly `0x${string}`[] | undefined;
  isLoading: boolean;
  onSelect: (hash: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4 gap-2">
        <Loader2 className="w-4 h-4 text-neutral-500 animate-spin" />
        <span className="text-xs text-neutral-500">Loading receipts...</span>
      </div>
    );
  }

  if (!receipts || receipts.length === 0) {
    return (
      <div className="py-4 text-center">
        <FileText className="w-6 h-6 text-neutral-700 mx-auto mb-2" />
        <p className="text-xs text-neutral-600">No receipts found</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin">
      {receipts.map((hash, index) => (
        <button
          key={hash}
          onClick={() => onSelect(hash)}
          className={cn(
            "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left",
            "bg-white/[0.02] border border-white/[0.04]",
            "hover:bg-white/[0.05] hover:border-white/[0.08]",
            "transition-all duration-150",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          )}
        >
          <div className="w-6 h-6 rounded-md bg-accent/10 flex items-center justify-center shrink-0">
            <Hash className="w-3 h-3 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="block font-mono text-[11px] text-neutral-300 truncate">
              {hash}
            </span>
            <span className="text-[10px] text-neutral-600">
              Receipt #{receipts.length - index}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────

export function ReceiptVerifyModal({ isOpen, onClose }: ReceiptVerifyModalProps) {
  const { address } = useAccount();
  const [receiptHash, setReceiptHash] = useState("");
  const [submittedHash, setSubmittedHash] = useState<`0x${string}` | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showMyReceipts, setShowMyReceipts] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // ── Contract read — verify receipt ──
  const {
    data: rawResult,
    isLoading: isVerifying,
    isError: isContractError,
    error: contractError,
    refetch,
  } = useReadContract({
    address: CONTRACTS.PaymentReceipts,
    abi: verifyReceiptAbi,
    functionName: "verifyReceipt",
    args: submittedHash ? [submittedHash] : undefined,
    query: {
      enabled: !!submittedHash,
    },
  });

  // ── Fetch user's receipt hashes ──
  const {
    data: userReceipts,
    isLoading: isLoadingReceipts,
  } = useReadContract({
    address: CONTRACTS.PaymentReceipts,
    abi: PaymentReceiptsAbi,
    functionName: "getUserReceipts",
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && isOpen,
    },
  });

  // Parse the contract result into a typed object
  const result: ReceiptResult | null =
    rawResult && Array.isArray(rawResult)
      ? {
          exists: rawResult[0] as boolean,
          payer: rawResult[1] as `0x${string}`,
          payee: rawResult[2] as `0x${string}`,
          token: rawResult[3] as `0x${string}`,
          timestamp: rawResult[4] as bigint,
        }
      : null;

  const hasResult = submittedHash !== null && !isVerifying && !isContractError;
  const receiptFound = hasResult && result?.exists === true;
  const receiptNotFound = hasResult && result?.exists === false;

  // ── Reset state when modal closes ──
  useEffect(() => {
    if (!isOpen) {
      const timer = setTimeout(() => {
        setReceiptHash("");
        setSubmittedHash(null);
        setValidationError(null);
        setShowMyReceipts(false);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // ── Focus input on open ──
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // ── Handlers ──
  const handleVerify = useCallback(() => {
    setValidationError(null);

    const trimmed = receiptHash.trim();

    if (!trimmed) {
      setValidationError("Please enter a receipt hash");
      return;
    }

    if (!isValidBytes32(trimmed)) {
      setValidationError("Invalid hash format. Must be a 32-byte hex string (0x followed by 64 hex characters)");
      return;
    }

    setSubmittedHash(trimmed as `0x${string}`);
  }, [receiptHash]);

  const handleRetry = useCallback(() => {
    setSubmittedHash(null);
    setValidationError(null);
    refetch();
  }, [refetch]);

  const handleSelectReceipt = useCallback((hash: string) => {
    setReceiptHash(hash);
    setSubmittedHash(hash as `0x${string}`);
    setShowMyReceipts(false);
    setValidationError(null);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isVerifying) {
        handleVerify();
      }
    },
    [handleVerify, isVerifying]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // ── Escape key to close ──
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={{ duration: 0.2 }}
          aria-modal="true"
          role="dialog"
          aria-labelledby="receipt-verify-title"
        >
          {/* ── Backdrop ── */}
          <motion.div
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={handleBackdropClick}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />

          {/* ── Modal Card ── */}
          <motion.div
            ref={modalRef}
            tabIndex={-1}
            className={cn(
              "relative w-full max-w-md max-h-[90vh] overflow-y-auto",
              "bg-[#0a0a0c] border border-white/[0.06] rounded-3xl p-8",
              "shadow-[0_0_80px_rgba(0,0,0,0.8)]",
              "scrollbar-thin",
              "focus:outline-none"
            )}
            variants={modalVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onAnimationComplete={() => modalRef.current?.focus()}
          >
            {/* ── Close Button ── */}
            <button
              onClick={onClose}
              className={cn(
                "absolute top-4 right-4 p-1.5 rounded-lg",
                "text-neutral-600 hover:text-white hover:bg-white/[0.06]",
                "transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              )}
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>

            {/* ── Header ── */}
            <div className="text-center mb-8">
              <div
                className={cn(
                  "w-14 h-14 rounded-full mx-auto mb-4",
                  "bg-white/[0.04] border border-white/[0.08]",
                  "flex items-center justify-center"
                )}
              >
                <Shield className="w-7 h-7 text-accent" />
              </div>
              <h2
                id="receipt-verify-title"
                className="text-2xl font-semibold text-white"
              >
                Verify Receipt
              </h2>
              <p className="text-sm text-neutral-500 mt-2">
                Paste a receipt hash to verify payment details on-chain
              </p>
            </div>

            {/* ── Input Section ── */}
            <div className="space-y-2" onKeyDown={handleKeyDown}>
              <Input
                ref={inputRef}
                label="Receipt Hash"
                placeholder="0x..."
                value={receiptHash}
                onChange={(e) => {
                  setReceiptHash(e.target.value);
                  if (validationError) setValidationError(null);
                  if (submittedHash) setSubmittedHash(null);
                }}
                error={validationError ?? undefined}
                className="font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {/* ── Verify Button ── */}
            <div className="mt-6">
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={handleVerify}
                loading={isVerifying}
                disabled={isVerifying || !receiptHash.trim()}
                icon={
                  isVerifying ? undefined : <Shield className="w-4 h-4" />
                }
              >
                {isVerifying ? "Verifying..." : "Verify Receipt"}
              </Button>
            </div>

            {/* ── Results Section ── */}
            <AnimatePresence mode="wait">
              {/* Loading state */}
              {isVerifying && (
                <motion.div
                  key="loading"
                  variants={resultVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="mt-6 flex flex-col items-center gap-3 py-6"
                >
                  <Loader2 className="w-6 h-6 text-accent animate-spin" />
                  <p className="text-sm text-neutral-500">
                    Querying on-chain receipt data...
                  </p>
                </motion.div>
              )}

              {/* Contract error */}
              {isContractError && !isVerifying && (
                <motion.div
                  key="error"
                  variants={resultVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="mt-6"
                >
                  <div
                    className={cn(
                      "rounded-xl border border-red-500/20 p-4",
                      "bg-red-500/[0.04]"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-red-400">
                          Verification failed
                        </p>
                        <p className="text-xs text-red-400/60 mt-1 break-words">
                          {contractError?.message
                            ? contractError.message.length > 120
                              ? `${contractError.message.slice(0, 120)}...`
                              : contractError.message
                            : "Unable to query the contract. Please check the hash and try again."}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-3 w-full text-red-400 hover:text-red-300"
                      onClick={handleRetry}
                    >
                      Try Again
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* Receipt not found */}
              {receiptNotFound && (
                <motion.div
                  key="not-found"
                  variants={resultVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="mt-6"
                >
                  <div
                    className={cn(
                      "rounded-xl border border-red-500/20 p-5",
                      "bg-red-500/[0.04] text-center"
                    )}
                  >
                    <AlertTriangle className="w-6 h-6 text-red-400 mx-auto mb-2" />
                    <p className="text-sm font-medium text-red-400">
                      Receipt not found on-chain
                    </p>
                    <p className="text-xs text-neutral-600 mt-1">
                      The hash does not match any recorded payment receipt
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Receipt found — verified result with enhanced details */}
              {receiptFound && result && (
                <motion.div
                  key="found"
                  variants={resultVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="mt-6 space-y-4"
                >
                  {/* Verified badge */}
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      type: "spring",
                      stiffness: 300,
                      damping: 20,
                      delay: 0.15,
                    }}
                    className={cn(
                      "flex items-center justify-center gap-2 py-3 px-4",
                      "rounded-xl border border-emerald-500/20",
                      "bg-emerald-500/[0.06]"
                    )}
                  >
                    <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <Check className="w-3 h-3 text-emerald-400" />
                    </div>
                    <span className="text-sm font-medium text-emerald-400">
                      Verified On-Chain
                    </span>
                  </motion.div>

                  {/* Receipt Details Card */}
                  <div
                    className={cn(
                      "rounded-xl border border-white/[0.06] overflow-hidden",
                      "bg-gradient-to-b from-white/[0.03] to-white/[0.01]"
                    )}
                  >
                    {/* Receipt Hash */}
                    <div className="bg-[#0a0a0c] border-b border-white/[0.04] px-4 py-3.5">
                      <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 mb-1.5">
                        Receipt Hash
                      </span>
                      <span className="block font-mono text-[11px] text-accent break-all select-all leading-relaxed">
                        {submittedHash}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-px bg-white/[0.04]">
                      {/* Payer */}
                      <div className="bg-[#0a0a0c] p-4">
                        <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 mb-1.5">
                          Payer
                        </span>
                        <span className="block font-mono text-sm text-white truncate">
                          {truncateAddress(result.payer)}
                        </span>
                      </div>

                      {/* Payee */}
                      <div className="bg-[#0a0a0c] p-4">
                        <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 mb-1.5">
                          Payee
                        </span>
                        <span className="block font-mono text-sm text-white truncate">
                          {truncateAddress(result.payee)}
                        </span>
                      </div>

                      {/* Token */}
                      <div className="bg-[#0a0a0c] p-4">
                        <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 mb-1.5">
                          Token
                        </span>
                        <span className="block font-mono text-sm text-white truncate">
                          {truncateAddress(result.token)}
                        </span>
                      </div>

                      {/* Timestamp */}
                      <div className="bg-[#0a0a0c] p-4">
                        <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 mb-1.5">
                          Timestamp
                        </span>
                        <span className="block font-mono text-sm text-white">
                          {formatTimestamp(result.timestamp)}
                        </span>
                      </div>
                    </div>

                    {/* Amount — encrypted */}
                    <div className="bg-[#0a0a0c] border-t border-white/[0.04] px-4 py-4">
                      <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 mb-1.5">
                        Amount
                      </span>
                      <div className="flex items-center gap-2">
                        <Lock className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                        <span className="font-mono text-sm text-violet-400 tracking-wide">
                          {ENCRYPTED_PLACEHOLDER} (Encrypted — decrypt with permit)
                        </span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── My Receipts Section ── */}
            {address && (
              <div className="mt-8 border-t border-white/[0.06] pt-6">
                <button
                  onClick={() => setShowMyReceipts(!showMyReceipts)}
                  className={cn(
                    "w-full flex items-center justify-between py-2 group",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-lg px-1"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-neutral-500" />
                    <span className="text-sm font-medium text-neutral-300 group-hover:text-white transition-colors">
                      My Receipts
                    </span>
                    {userReceipts && (userReceipts as readonly `0x${string}`[]).length > 0 && (
                      <span className="text-[10px] font-medium text-neutral-500 bg-white/[0.06] px-1.5 py-0.5 rounded-full">
                        {(userReceipts as readonly `0x${string}`[]).length}
                      </span>
                    )}
                  </div>
                  {showMyReceipts ? (
                    <ChevronUp className="w-4 h-4 text-neutral-600" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-neutral-600" />
                  )}
                </button>

                <AnimatePresence>
                  {showMyReceipts && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="pt-3">
                        <MyReceiptsList
                          receipts={userReceipts as readonly `0x${string}`[] | undefined}
                          isLoading={isLoadingReceipts}
                          onSelect={handleSelectReceipt}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
