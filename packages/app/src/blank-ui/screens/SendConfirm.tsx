import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Lock, Zap, Info, ChevronLeft, AlertCircle } from "lucide-react";
import { useSendPayment } from "@/hooks/useSendPayment";
import { cn } from "@/lib/cn";
import { mapError } from "@/lib/error-messages";

import { truncateAddress } from "@/lib/address";

export default function SendConfirm() {
  const navigate = useNavigate();
  const {
    step,
    recipient,
    amount,
    note,
    error,
    isEncrypting,
    isSending,
    confirmSend,
    goBack,
  } = useSendPayment();

  // Navigate to success when step transitions
  useEffect(() => {
    if (step === "success") {
      navigate("/app/send/success", { replace: true });
    }
  }, [step, navigate]);

  const isProcessing = step === "sending" || step === "encrypting";
  const isErrored = step === "error";

  // #265: surface the actual failure reason inline so the user doesn't have
  // to rely on the toast (which may have dismissed by the time they look).
  const mappedError = isErrored && error ? mapError(error) : null;

  const statusLabel = isErrored
    ? "Try again"
    : isEncrypting
      ? "Encrypting..."
      : isSending
        ? "Broadcasting..."
        : step === "sending"
          ? "Processing..."
          : "Confirm & Send";

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-lg mx-auto flex flex-col min-h-[calc(100dvh-8rem)]">
        {/* Back button */}
        <div className="mb-6">
          <button
            onClick={() => {
              goBack();
              navigate(-1);
            }}
            className="w-10 h-10 rounded-full bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 flex items-center justify-center hover:bg-white/80 dark:hover:bg-white/10 transition-all"
            aria-label="Go back"
          >
            <ChevronLeft size={20} className="text-[var(--text-primary)]" />
          </button>
        </div>

        {/* Page title */}
        <div className="mb-8">
          <h1
            className="text-3xl sm:text-4xl font-medium tracking-tight text-[var(--text-primary)] mb-2"
            style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
          >
            Confirm Payment
          </h1>
          <p className="text-sm sm:text-base text-[var(--text-secondary)] leading-relaxed">
            Review the details before sending
          </p>
        </div>

        <div className="flex-1 space-y-5">
          {/* Details card */}
          <div className="rounded-[2rem] glass-card-static p-4 sm:p-6 space-y-0">
            {/* To */}
            <div className="flex items-center justify-between gap-3 py-4">
              <span className="text-[var(--text-secondary)] shrink-0">To</span>
              <span className="font-medium text-[var(--text-primary)] font-mono truncate">
                {truncateAddress(recipient)}
              </span>
            </div>

            <div className="h-px bg-black/5 dark:bg-white/5" />

            {/* Amount */}
            <div className="flex items-center justify-between gap-3 py-4">
              <span className="text-[var(--text-secondary)] shrink-0">Amount</span>
              <span
                className="text-base sm:text-lg font-semibold font-mono tabular-nums text-[var(--text-primary)] truncate"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                ${amount || "0.00"} USDC
              </span>
            </div>

            <div className="h-px bg-black/5 dark:bg-white/5" />

            {/* Encryption */}
            <div className="flex items-center justify-between py-4">
              <span className="text-[var(--text-secondary)]">Encryption</span>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <Shield size={14} className="text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  FHE Encrypted
                </span>
              </div>
            </div>

            <div className="h-px bg-black/5 dark:bg-white/5" />

            {/* Gas estimate */}
            <div className="flex items-center justify-between py-4">
              <span className="text-[var(--text-secondary)]">Est. gas</span>
              <div className="flex items-center gap-1.5">
                <Zap size={14} className="text-amber-500" />
                <span className="text-[var(--text-primary)]">~1.2M gas (estimated)</span>
              </div>
            </div>

            {/* Note if present */}
            {note && (
              <>
                <div className="h-px bg-black/5 dark:bg-white/5" />
                <div className="flex items-start justify-between gap-4 py-4">
                  <span className="text-[var(--text-secondary)] shrink-0">
                    Note
                  </span>
                  <span className="text-[var(--text-primary)] text-right">
                    {note}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Info banner */}
          <div className="rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 p-4 flex gap-3">
            <Info
              size={20}
              className="text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5"
            />
            <div>
              <p className="text-sm text-indigo-900 dark:text-indigo-300 font-medium mb-1">
                End-to-end encrypted
              </p>
              <p className="text-sm text-indigo-700 dark:text-indigo-400/80">
                The payment amount is encrypted with FHE before being sent
                on-chain. Only the sender and recipient can decrypt the value.
              </p>
            </div>
          </div>

          {/* Processing indicator */}
          {isProcessing && (
            <div className="rounded-[2rem] glass-card-static p-5 flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
                {isEncrypting ? (
                  <Lock
                    size={18}
                    className="text-emerald-600 dark:text-emerald-400 animate-pulse"
                  />
                ) : (
                  <Shield
                    size={18}
                    className="text-emerald-600 dark:text-emerald-400 animate-pulse"
                  />
                )}
              </div>
              <div className="flex-1">
                <p className="font-medium text-[var(--text-primary)]">
                  {isEncrypting
                    ? "Encrypting payment amount..."
                    : "Broadcasting to Ethereum Sepolia..."}
                </p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {isEncrypting
                    ? "Generating FHE ciphertext and ZK proof"
                    : "Waiting for transaction confirmation"}
                </p>
              </div>
            </div>
          )}

          {/* #265: error surface — stays visible until the user retries or
              backs out, so they don't lose the reason when the toast fades. */}
          {mappedError && (
            <div
              role="alert"
              className="rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 p-4 flex gap-3"
            >
              <AlertCircle
                size={20}
                className="text-red-600 dark:text-red-400 shrink-0 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-red-900 dark:text-red-300 mb-0.5">
                  {mappedError.title}
                </p>
                <p className="text-sm text-red-700 dark:text-red-400/80 break-words">
                  {mappedError.body}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Confirm button */}
        <div className="pt-6 pb-6">
          <button
            onClick={confirmSend}
            disabled={isProcessing}
            className={cn(
              "w-full h-14 rounded-2xl font-medium transition-all active:scale-95 flex items-center justify-center gap-2",
              isProcessing
                ? "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed"
                : isErrored
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] hover:bg-[#000000] dark:hover:bg-gray-100",
            )}
          >
            {isProcessing ? (
              <div className="w-5 h-5 border-2 border-gray-400/30 border-t-gray-400 rounded-full animate-spin" />
            ) : isErrored ? (
              <AlertCircle size={18} strokeWidth={2.2} />
            ) : (
              <Shield size={18} strokeWidth={2.2} />
            )}
            <span>{statusLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
