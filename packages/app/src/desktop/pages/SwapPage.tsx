import { motion, AnimatePresence, type Variants } from "framer-motion";
import { useState, useEffect, useRef } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import {
  ArrowDownUp,
  ChevronLeft,
  ShieldAlert,
  Check,
  ArrowRight,
  Lock,
  Cpu,
  ShieldCheck,
  Zap,
  AlertTriangle,
  RotateCcw,
  Info,
} from "lucide-react";
import { pageVariants } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { CONTRACTS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, BASE_SEPOLIA, MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { PrivacyRouterAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity } from "@/lib/supabase";

// ─── Swap step machine ──────────────────────────────────────────────

type SwapStep =
  | "input"
  | "approving"
  | "encrypting"
  | "initiating"
  | "waiting_decrypt"
  | "executing"
  | "success"
  | "error";

interface SwapState {
  step: SwapStep;
  isProcessing: boolean;
  error: string | null;
  txHash: string | null;
  swapId: bigint | null;
}

const initialState: SwapState = {
  step: "input",
  isProcessing: false,
  error: null,
  txHash: null,
  swapId: null,
};

// Mock DEX rate: 1:1 for same-token swaps (USDC to USDC vault)
// In production this would query the MockDEX contract
const MOCK_RATE = 1.0;

// ─── Step progress definitions ──────────────────────────────────────

interface StepDef {
  label: string;
  sublabel: string;
  icon: typeof Lock;
}

const swapSteps: StepDef[] = [
  { label: "Encrypt", sublabel: "Encrypting amount", icon: Lock },
  { label: "Initiate", sublabel: "Submitting to chain", icon: Zap },
  { label: "Decrypt", sublabel: "Waiting for decryption", icon: Cpu },
  { label: "Execute", sublabel: "Executing DEX swap", icon: ShieldCheck },
];

function getStepIndex(step: SwapStep): number {
  switch (step) {
    case "approving":
    case "encrypting":
      return 0;
    case "initiating":
      return 1;
    case "waiting_decrypt":
      return 2;
    case "executing":
      return 3;
    case "success":
      return 4;
    default:
      return -1;
  }
}

// ─── Framer Motion Variants ─────────────────────────────────────────

const riseIn: Variants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -12, transition: { duration: 0.25 } },
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

// ─── Component ──────────────────────────────────────────────────────

export function SwapPage() {
  const { isConnected, address } = useAccount();
  const publicClient = usePublicClient();
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<SwapState>(initialState);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef(false);

  if (!isConnected) return <ConnectPrompt />;

  const estimatedOutput =
    parseFloat(amount) > 0
      ? (parseFloat(amount) * MOCK_RATE * (1 - parseFloat(slippage || "0") / 100)).toFixed(2)
      : "0.00";

  const minAmountOut =
    parseFloat(amount) > 0
      ? parseUnits(
          (parseFloat(amount) * MOCK_RATE * (1 - parseFloat(slippage || "1") / 100)).toFixed(6),
          6
        )
      : BigInt(0);

  const canSwap = /^\d+\.?\d*$/.test(amount) && parseFloat(amount) > 0 && !state.isProcessing && connected;

  // ── Cleanup polling on unmount ──
  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  // ── Ensure vault approval ──
  const ensureApproval = async () => {
    setState((s) => ({ ...s, step: "approving", isProcessing: true, error: null }));
    const toastId = toast.loading("First time! Approving encrypted transfers...");
    try {
      await writeContractAsync({
        address: CONTRACTS.FHERC20Vault_USDC,
        abi: FHERC20VaultAbi,
        functionName: "approvePlaintext",
        args: [CONTRACTS.PrivacyRouter, MAX_UINT64],
      });
      toast.success("Approval granted!", { id: toastId });
    } catch (err) {
      toast.error("Approval failed", { id: toastId });
      throw err;
    }
  };

  // ── Poll for decryption readiness ──
  const pollDecryption = (swapId: bigint): Promise<void> => {
    return new Promise((resolve, reject) => {
      // Timeout after POLL_TIMEOUT_MS
      pollTimeoutRef.current = setTimeout(() => {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        reject(new Error("Decryption timed out. You may need to retry."));
      }, POLL_TIMEOUT_MS);

      pollTimerRef.current = setInterval(async () => {
        if (abortRef.current) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
          reject(new Error("Swap cancelled \u2014 navigated away"));
          return;
        }

        try {
          const isReady = await publicClient?.readContract({
            address: CONTRACTS.PrivacyRouter,
            abi: PrivacyRouterAbi,
            functionName: "isDecryptionReady",
            args: [swapId],
          });

          if (isReady) {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
            resolve();
          }
        } catch {
          // Ignore read errors during polling
        }
      }, POLL_INTERVAL_MS);
    });
  };

  // ── Initiate swap flow ──
  const handleSwap = async () => {
    if (!canSwap || !address || !publicClient) return;
    abortRef.current = false;

    try {
      // Step 1: Approve
      await ensureApproval();

      // Step 2: Encrypt
      setState((s) => ({ ...s, step: "encrypting" }));
      const encrypted = await encryptInputsAsync([
        Encryptable.uint64(parseUnits(amount, 6)),
      ]);

      // Step 3: Initiate swap
      setState((s) => ({ ...s, step: "initiating" }));
      const initiateHash = await writeContractAsync({
        address: CONTRACTS.PrivacyRouter,
        abi: PrivacyRouterAbi,
        functionName: "initiateSwap",
        args: [
          CONTRACTS.FHERC20Vault_USDC, // vaultIn
          CONTRACTS.FHERC20Vault_USDC, // vaultOut (same for now)
          // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
          encrypted[0] as unknown as EncryptedInput,
          minAmountOut,                 // min amount out
        ],
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: initiateHash,
        confirmations: 1,
      });

      // Extract swapId from logs (SwapInitiated event - first indexed param after topic0)
      let swapId = BigInt(0);
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === CONTRACTS.PrivacyRouter.toLowerCase() && log.topics[1]) {
          swapId = BigInt(log.topics[1]);
          break;
        }
      }

      setState((s) => ({ ...s, swapId, step: "waiting_decrypt" }));

      // Step 4: Poll for decryption
      await pollDecryption(swapId);

      // Step 5: Execute swap
      setState((s) => ({ ...s, step: "executing" }));
      const executeHash = await writeContractAsync({
        address: CONTRACTS.PrivacyRouter,
        abi: PrivacyRouterAbi,
        functionName: "executeSwap",
        args: [swapId],
      });

      await publicClient.waitForTransactionReceipt({
        hash: executeHash,
        confirmations: 1,
      });

      // Success
      setState((s) => ({
        ...s,
        step: "success",
        isProcessing: false,
        txHash: executeHash,
      }));

      // Log to Supabase
      await insertActivity({
        tx_hash: executeHash,
        user_from: address.toLowerCase(),
        user_to: CONTRACTS.PrivacyRouter.toLowerCase(),
        activity_type: "swap_executed",
        contract_address: CONTRACTS.PrivacyRouter,
        note: `Swapped ${amount} USDC via Privacy Router`,
        token_address: CONTRACTS.TestUSDC,
        block_number: Number(receipt.blockNumber),
      });

      toast.success("Swap completed!");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Swap failed";
      setState((s) => ({
        ...s,
        step: "error",
        isProcessing: false,
        error: msg,
      }));
      toast.error(msg);
    }
  };

  const handleReset = () => {
    setState(initialState);
    setAmount("");
  };

  const currentStepIndex = getStepIndex(state.step);

  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="max-w-lg mx-auto space-y-6"
    >
      {/* ── Header ──────────────────────────────────────────────────── */}
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
            PRIVACY ROUTER
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.04, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="text-heading-1 font-semibold tracking-tight text-white"
          >
            Encrypted Swap
          </motion.h1>
          <p className="text-base text-apple-secondary font-medium mt-1">
            Private token exchange
          </p>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {/* ════════════════════ INPUT STEP ════════════════════════════ */}
        {state.step === "input" && (
          <motion.div key="swap-input" variants={riseIn} initial="initial" animate="animate" exit="exit" className="space-y-4">
            {/* Swap card */}
            <GlassCard
              variant="elevated"
              className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
            >
              <div className="space-y-4">
                {/* You Send */}
                <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
                  <div className="flex items-center justify-between mb-2">
                    <label htmlFor="swap-send-amount" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                      You Send
                    </label>
                    <span className="text-xs text-neutral-500 font-mono">
                      Encrypted
                    </span>
                  </div>
                  <div className="flex items-end gap-3">
                    <input
                      id="swap-send-amount"
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setAmount(v);
                      }}
                      className="flex-1 bg-transparent text-2xl font-mono font-semibold text-white placeholder:text-neutral-600 tabular-nums tracking-tight outline-none"
                      aria-label="Amount to swap"
                    />
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.08] shrink-0">
                      <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                        <span className="text-[9px] font-bold text-white">$</span>
                      </div>
                      <span className="text-sm font-semibold text-white">USDC</span>
                    </div>
                  </div>
                </div>

                {/* Swap direction arrow */}
                <div className="flex justify-center -my-1">
                  <div className="w-10 h-10 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <ArrowDownUp className="w-4 h-4 text-neutral-500" />
                  </div>
                </div>

                {/* You Receive */}
                <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                      You Receive (est.)
                    </span>
                    <span className="text-xs text-neutral-500 font-mono">
                      Re-encrypted
                    </span>
                  </div>
                  <div className="flex items-end gap-3">
                    <span className="flex-1 text-2xl font-mono font-semibold text-accent tabular-nums tracking-tight">
                      {estimatedOutput}
                    </span>
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.08] shrink-0">
                      <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                        <span className="text-[9px] font-bold text-white">$</span>
                      </div>
                      <span className="text-sm font-semibold text-white">USDC</span>
                    </div>
                  </div>
                </div>

                {/* Slippage */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 shrink-0">
                    Slippage
                  </span>
                  <div className="flex items-center gap-1.5">
                    {["0.5", "1", "2"].map((val) => (
                      <button
                        key={val}
                        onClick={() => setSlippage(val)}
                        className={`
                          px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200
                          ${
                            slippage === val
                              ? "bg-accent/15 text-accent border border-accent/30"
                              : "bg-white/[0.04] text-neutral-500 border border-white/[0.08] hover:border-white/[0.14]"
                          }
                        `}
                      >
                        {val}%
                      </button>
                    ))}
                    <div className="relative ml-1">
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        max="50"
                        value={slippage}
                        onChange={(e) => setSlippage(e.target.value)}
                        className="w-16 h-8 px-2 text-xs font-mono tabular-nums text-center text-white bg-white/[0.04] border border-white/[0.08] rounded-lg outline-none focus:border-accent/40"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-neutral-600 pointer-events-none">
                        %
                      </span>
                    </div>
                  </div>
                </div>

                {/* Rate info */}
                {parseFloat(amount) > 0 && (
                  <div className="flex items-center justify-between text-xs text-neutral-500 pt-2 border-t border-white/[0.04]">
                    <span>Rate</span>
                    <span className="font-mono tabular-nums">1 USDC = 1 USDC</span>
                  </div>
                )}
              </div>
            </GlassCard>

            {/* Privacy notice */}
            <GlassCard variant="outlined" className="!py-3 !px-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs text-neutral-400 leading-relaxed">
                    <span className="text-amber-400 font-medium">Privacy notice:</span>{" "}
                    Swap amounts are briefly visible on-chain during execution.
                    Your vault balances remain encrypted at all times.
                  </p>
                </div>
              </div>
            </GlassCard>

            {/* Swap button */}
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              icon={<ArrowDownUp className="w-4.5 h-4.5" />}
              onClick={handleSwap}
              disabled={!canSwap}
            >
              Initiate Swap
            </Button>
          </motion.div>
        )}

        {/* ════════════════════ PROCESSING STATES ═══════════════════ */}
        {(state.step === "approving" ||
          state.step === "encrypting" ||
          state.step === "initiating" ||
          state.step === "waiting_decrypt" ||
          state.step === "executing") && (
          <motion.div key="processing" variants={scaleCenter} initial="initial" animate="animate" exit="exit">
            <GlassCard variant="elevated" className="py-10">
              {/* Animated ring */}
              <div className="relative w-20 h-20 mx-auto mb-6">
                <svg width={80} height={80} className="absolute inset-0 -rotate-90" aria-hidden="true">
                  <defs>
                    <linearGradient id="swap-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#8b5cf6" />
                      <stop offset="100%" stopColor="#10b981" />
                    </linearGradient>
                  </defs>
                  <circle cx={40} cy={40} r={34} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={4} />
                  <motion.circle
                    cx={40}
                    cy={40}
                    r={34}
                    fill="none"
                    stroke="url(#swap-ring-grad)"
                    strokeWidth={4}
                    strokeLinecap="round"
                    strokeDasharray={213.6}
                    initial={{ strokeDashoffset: 213.6 }}
                    animate={{
                      strokeDashoffset:
                        213.6 - (((currentStepIndex + 1) / swapSteps.length) * 213.6),
                    }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                    className="w-10 h-10 rounded-xl bg-encrypted/10 border border-encrypted/20 flex items-center justify-center"
                  >
                    <ArrowDownUp className="w-5 h-5 text-encrypted" />
                  </motion.div>
                </div>
              </div>

              {/* Step indicators */}
              <div className="flex items-center justify-center gap-1 mb-6">
                {swapSteps.map((s, i) => {
                  const isComplete = i < currentStepIndex;
                  const isActive = i === currentStepIndex;

                  return (
                    <div key={s.label} className="flex items-center gap-1">
                      <motion.div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold transition-all duration-500 ${
                          isComplete
                            ? "bg-accent text-void shadow-[0_0_10px_rgba(52,211,153,0.3)]"
                            : isActive
                            ? "border-2 border-encrypted bg-encrypted/10 text-encrypted"
                            : "border border-white/[0.08] bg-white/[0.03] text-neutral-600"
                        }`}
                        animate={isActive ? { scale: [1, 1.1, 1] } : { scale: 1 }}
                        transition={isActive ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" } : {}}
                      >
                        {isComplete ? (
                          <Check className="w-3.5 h-3.5" strokeWidth={3} />
                        ) : (
                          i + 1
                        )}
                      </motion.div>
                      {i < swapSteps.length - 1 && (
                        <div
                          className={`w-6 h-0.5 rounded-full ${
                            isComplete ? "bg-accent" : "bg-white/[0.08]"
                          }`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Step labels */}
              <div className="text-center">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={currentStepIndex}
                    initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                    transition={{ duration: 0.25 }}
                  >
                    <h3 className="text-lg font-semibold text-white mb-1">
                      {state.step === "approving" && "Approving Vault Access"}
                      {state.step === "encrypting" && "Encrypting Amount"}
                      {state.step === "initiating" && "Initiating Swap"}
                      {state.step === "waiting_decrypt" && "Waiting for Decryption"}
                      {state.step === "executing" && "Executing Swap"}
                    </h3>
                    <p className="text-sm text-neutral-400">
                      {state.step === "approving" &&
                        "Granting Privacy Router access to your vault..."}
                      {state.step === "encrypting" &&
                        "Encrypting your swap amount with FHE..."}
                      {state.step === "initiating" &&
                        "Submitting encrypted swap to Base Sepolia..."}
                      {state.step === "waiting_decrypt" &&
                        "CoFHE network is decrypting the amount for the DEX..."}
                      {state.step === "executing" &&
                        "Executing token swap and re-encrypting output..."}
                    </p>
                  </motion.div>
                </AnimatePresence>

                {state.step === "waiting_decrypt" && (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-xs text-neutral-600 mt-3 font-mono tabular-nums"
                  >
                    Waiting for decryption... (timeout: {POLL_TIMEOUT_MS / 1000}s)
                  </motion.p>
                )}
              </div>
            </GlassCard>
          </motion.div>
        )}

        {/* ════════════════════ SUCCESS ═══════════════════════════════ */}
        {state.step === "success" && (
          <motion.div key="success" variants={springIn} initial="initial" animate="animate" exit="exit">
            <GlassCard variant="elevated" className="text-center py-12">
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
                Swap Complete!
              </h3>
              <p className="text-sm text-neutral-400 mb-1">
                Tokens have been re-encrypted in your vault.
              </p>

              <div className="flex items-center justify-center gap-2 mt-3 mb-6">
                <div className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                  <span className="text-sm font-mono text-white tabular-nums">{amount}</span>
                  <span className="text-xs text-neutral-500 ml-1">USDC</span>
                </div>
                <ArrowRight className="w-4 h-4 text-neutral-600" />
                <div className="px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/20">
                  <span className="text-sm font-mono text-accent tabular-nums">{estimatedOutput}</span>
                  <span className="text-xs text-accent/60 ml-1">USDC</span>
                </div>
              </div>

              {state.txHash && (
                <a
                  href={`${BASE_SEPOLIA.explorerUrl}/tx/${state.txHash}`}
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
                  Swap Again
                </Button>
              </div>
            </GlassCard>

            {/* Privacy reminder */}
            <GlassCard variant="outlined" className="!py-3 !px-4 mt-4">
              <div className="flex items-start gap-3">
                <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                <p className="text-xs text-neutral-400 leading-relaxed">
                  Your vault balance is now updated and fully encrypted. Only you can see
                  your balance with a valid permit.
                </p>
              </div>
            </GlassCard>
          </motion.div>
        )}

        {/* ════════════════════ ERROR ═════════════════════════════════ */}
        {state.step === "error" && (
          <motion.div key="error" variants={riseIn} initial="initial" animate="animate" exit="exit">
            <GlassCard variant="elevated" className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-5">
                <AlertTriangle className="w-8 h-8 text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-red-400">Swap Failed</h3>
              <p className="text-sm text-neutral-400 mt-2 max-w-sm mx-auto leading-relaxed">
                {state.error || "Something went wrong. Please try again."}
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
      </AnimatePresence>
    </motion.div>
  );
}
