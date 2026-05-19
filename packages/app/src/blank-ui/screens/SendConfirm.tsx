import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBalance } from "wagmi";
import { parseUnits } from "viem";
import {
  Shield,
  Lock,
  Zap,
  Info,
  ChevronLeft,
  AlertCircle,
  EyeOff,
  Wallet,
  Sparkles,
} from "lucide-react";
import { useSendPayment } from "@/hooks/useSendPayment";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { usePaymasterHealth } from "@/hooks/usePaymasterHealth";
import {
  useStealthMetaAddressLookup,
  useStealthSend,
} from "@/hooks/useStealthSend";
import { FundAccountModal } from "@/blank-ui/components/FundAccountModal";
import { cn } from "@/lib/cn";
import { mapError } from "@/lib/error-messages";
import toast from "react-hot-toast";

import { truncateAddress } from "@/lib/address";

export default function SendConfirm() {
  const navigate = useNavigate();
  const {
    step,
    recipient,
    amount,
    note,
    error,
    mode,
    recipients,
    splitMode,
    recipientAmounts,
    isEncrypting,
    isSending,
    confirmSend,
    goBack,
  } = useSendPayment();

  // Per-recipient amounts in many mode: equal-split duplicates `amount`,
  // custom uses the parallel `recipientAmounts` array.
  const batchRows = mode === "many"
    ? recipients.map((addr, i) => ({
        address: addr,
        amount: splitMode === "equal" ? amount : (recipientAmounts[i] ?? "0"),
      }))
    : [];

  const batchTotal = mode === "many"
    ? batchRows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0)
    : 0;

  // Navigate to success when step transitions
  useEffect(() => {
    if (step === "success") {
      navigate("/app/send/success", { replace: true });
    }
  }, [step, navigate]);

  // Phase 3.1: optional "stealth" mode. When enabled, the Confirm button
  // hands off to /app/stealth with the recipient + amount pre-filled. The
  // stealth flow there is its own multi-step state machine (claim codes,
  // deferred recipient claims) so we don't try to merge them — single
  // entry point on Send, two diverging paths after the fork.
  const [stealthMode, setStealthMode] = useState(false);

  // Phase 9.3: ERC-5564 meta-address stealth send. Distinct from the
  // claim-code stealth above — when the recipient has registered a
  // stealth meta-address in ERC-6538, we offer a toggle that derives a
  // fresh stealth EOA, ERC-20-transfers there, and emits the
  // ERC-5564 announcement in one atomic batch UserOp. The two toggles
  // are mutually exclusive — meta-stealth supersedes claim-code stealth
  // when available because the recipient experience is dramatically
  // better (auto-discovery instead of manual claim-link).
  const [metaStealthMode, setMetaStealthMode] = useState(false);
  const [metaStealthBusy, setMetaStealthBusy] = useState(false);
  const [metaStealthError, setMetaStealthError] = useState<string | null>(null);
  const recipientLookup = useStealthMetaAddressLookup(
    mode === "single" && recipient ? (recipient as `0x${string}`) : undefined,
  );
  const recipientHasMetaAddress = !!recipientLookup.metaAddress;
  const { sendStealthPayment } = useStealthSend();

  // `approving` shows up in the batch path (BusinessHub vault approval)
  // and historically in the atomic single path. Treat it as in-flight so
  // the spinner panel renders and the Confirm button stays disabled —
  // otherwise the user sees no progress indicator while a UserOp is mid-air.
  // metaStealthBusy is the Phase 9.3 in-flight signal — the UserOp is
  // out for relay, button stays disabled.
  const isProcessing =
    step === "sending" || step === "encrypting" || step === "approving" || metaStealthBusy;
  const isErrored = step === "error" || !!metaStealthError;

  // #265: surface the actual failure reason inline so the user doesn't have
  // to rely on the toast (which may have dismissed by the time they look).
  // Either source can fire — the legacy useSendPayment path or the Phase
  // 9.3 meta-stealth path. Prefer the meta-stealth error when present
  // since the legacy `error` may still be stale from a prior retry.
  const mappedError = metaStealthError
    ? { title: "Stealth send failed", body: metaStealthError }
    : isErrored && error
      ? mapError(error)
      : null;

  // Phase 7.4-7.6: paymaster resilience. When the BlankPaymaster's deposit
  // is depleted, the sponsored UserOp path will fail with a cryptic AA31
  // revert. We pre-empt that by:
  //   1. Reading the paymaster's deposit health (60s cache, shared across
  //      Dashboard + SendConfirm).
  //   2. If health is "unavailable" AND the AA's own ETH balance on the
  //      active chain is below ~0.001 ETH, block the Send button and open
  //      `FundAccountModal` so the user can deposit ETH from any wallet
  //      and self-pay the UserOp's prefund.
  //
  // The "self" mode is now threaded all the way through `confirmSend` →
  // `useUnifiedWrite` → `useSmartAccount.submitCallData`, so once the user
  // tops up their AA's ETH the next send actually self-pays via the
  // EntryPoint prefund mechanism (see `useSmartAccount.ts` self-pay branch).
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChainId, activeChain, contracts } = useChain();
  const paymasterHealth = usePaymasterHealth();
  const aaBalance = useBalance({
    address: effectiveAddress as `0x${string}` | undefined,
    chainId: activeChainId,
    query: {
      enabled: !!effectiveAddress,
      refetchInterval: 30_000,
    },
  });
  const aaBalanceWei = aaBalance.data?.value ?? 0n;
  const SELF_PAY_REQUIRED_WEI = 1_000_000_000_000_000n; // 0.001 ETH
  const paymasterUnavailable = paymasterHealth.status === "unavailable";
  const aaCanSelfPay = aaBalanceWei >= SELF_PAY_REQUIRED_WEI;
  const needsFunding = paymasterUnavailable && !aaCanSelfPay;
  const [fundModalOpen, setFundModalOpen] = useState(false);

  const handleConfirm = async () => {
    // #377 diag: e2e wave4 phase 02 sees the user click confirm but never
    // sees the passphrase modal. Log every entry into handleConfirm so the
    // e2e trace shows which branch fires.
    console.log("[SendConfirm.handleConfirm]", JSON.stringify({
      mode, metaStealthMode, stealthMode, needsFunding, isProcessing,
      hasRecipient: !!recipient, hasMetaAddress: !!recipientLookup.metaAddress,
      paymasterStatus: paymasterHealth.status,
    }));
    // Phase 9.3: meta-address stealth fork. When the recipient has a
    // registered meta-address AND the user opted into the toggle, we
    // route to the ERC-5564 sender flow instead of the encrypted-FHE
    // PaymentHub path. The two flows are mutually exclusive.
    if (
      mode === "single" &&
      metaStealthMode &&
      recipient &&
      recipientLookup.metaAddress
    ) {
      setMetaStealthError(null);
      setMetaStealthBusy(true);
      try {
        // Plain USDC (the public token) — stealth EOAs can't decrypt FHE
        // ciphertexts, so the payment must be in the public ERC-20.
        // 6 decimals matches TestUSDC's `decimals()`.
        const amountUnits = parseUnits(amount || "0", 6);
        if (amountUnits <= 0n) {
          throw new Error("Amount must be positive");
        }
        // Audit Top-28 #11: read TestUSDC from useChain() rather than the
        // module-level CONTRACTS — after a reload-free chain switch the
        // module reference is stale and a stealth send would otherwise
        // fire on the wrong chain's token address.
        const result = await sendStealthPayment({
          token: contracts.TestUSDC as `0x${string}`,
          amount: amountUnits,
          metaAddress: recipientLookup.metaAddress,
        });
        toast.success(
          `Stealth payment sent to ${result.stealthAddress.slice(0, 8)}…`,
        );
        const params = new URLSearchParams();
        params.set("tx", result.txHash);
        params.set("stealth", result.stealthAddress);
        params.set("amount", amount);
        navigate(`/app/send/success?${params.toString()}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMetaStealthError(msg);
        toast.error("Stealth send failed. See details on the screen");
      } finally {
        setMetaStealthBusy(false);
      }
      return;
    }
    // Stealth mode only applies to single-recipient sends — its claim-code
    // model is per-payment, no batched analogue exists. The toggle is
    // hidden in many mode below; this guard is belt-and-braces.
    if (stealthMode && mode === "single") {
      const params = new URLSearchParams();
      if (recipient) params.set("to", recipient);
      if (amount) params.set("amount", amount);
      if (note) params.set("note", note);
      navigate(`/app/stealth${params.size > 0 ? `?${params.toString()}` : ""}`);
      return;
    }
    if (needsFunding) {
      setFundModalOpen(true);
      return;
    }
    // Phase 7.D: when the paymaster is unavailable AND the AA already has
    // enough ETH to self-pay, switch the underlying UserOps to self-pay
    // mode. This is the path users land on after the FundAccountModal
    // walks them through depositing ETH — the modal closes once balance
    // crosses the threshold, the next tap on Confirm picks up here, and
    // we tell `confirmSend` to skip the sponsored paymaster entirely.
    //
    // Degraded (sponsored may still succeed) and healthy states pass
    // undefined → useSendPayment defaults to the sponsored path, which
    // is the existing behaviour for everyone today.
    const paymasterMode: "sponsored" | "self" | undefined =
      paymasterUnavailable && aaCanSelfPay ? "self" : undefined;
    void confirmSend(paymasterMode);
  };

  const statusLabel = isErrored
    ? "Try again"
    : isEncrypting
      ? "Encrypting..."
      : isSending || metaStealthBusy
        ? "Broadcasting..."
        : step === "sending"
          ? "Processing..."
          : metaStealthMode
            ? "Send to stealth address"
            : stealthMode
              ? "Continue stealth send"
              : needsFunding
                ? "Fund wallet to send"
                : "Confirm & Send";

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-lg mx-auto flex flex-col min-h-[calc(100dvh-8rem)]">
        {/* Back button */}
        <div className="mb-6">
          <button
            onClick={() => {
              // Audit Top-28 #17: don't let the user navigate away mid-tx.
              // The on-chain submission is in flight — losing this screen
              // means losing the success/error surface for a tx the user
              // already authorized. The success/error toasts still fire
              // but the user has no scoped progress thread.
              if (isProcessing) return;
              goBack();
              navigate(-1);
            }}
            disabled={isProcessing}
            className="w-10 h-10 rounded-full bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 flex items-center justify-center hover:bg-white/80 dark:hover:bg-white/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
            {mode === "single" ? (
              <>
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
              </>
            ) : (
              <>
                {/* Batch summary header */}
                <div className="flex items-center justify-between gap-3 py-4">
                  <span className="text-[var(--text-secondary)] shrink-0">
                    Recipients ({batchRows.length})
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)] uppercase tracking-wider">
                    {splitMode === "equal" ? "Equal split" : "Custom amounts"}
                  </span>
                </div>

                {/* Per-recipient list — capped scroll height so a 30-row
                    batch doesn't push the action button off-screen. */}
                <div
                  data-testid="batch-confirm-rows"
                  className="max-h-64 overflow-y-auto rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/5 dark:border-white/5 divide-y divide-black/5 dark:divide-white/5"
                >
                  {batchRows.map((row) => (
                    <div
                      key={row.address}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <span className="font-mono text-sm text-[var(--text-secondary)] truncate">
                        {truncateAddress(row.address)}
                      </span>
                      <span
                        className="font-mono tabular-nums text-sm text-[var(--text-primary)] shrink-0"
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                      >
                        ${row.amount || "0.00"}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Total */}
                <div className="flex items-center justify-between gap-3 py-4 mt-2">
                  <span className="text-[var(--text-secondary)] shrink-0 font-medium">
                    Total
                  </span>
                  <span
                    className="text-lg font-semibold font-mono tabular-nums text-[var(--text-primary)]"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    ${batchTotal.toFixed(batchTotal % 1 === 0 ? 2 : 6)} USDC
                  </span>
                </div>
              </>
            )}

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

            {/* Phase 9.3 meta-stealth: when the recipient has a registered
                ERC-6538 meta-address, surface the toggle that uses the
                ERC-5564 flow (auto-discovery, no claim-link). Mutually
                exclusive with the claim-code stealth toggle below. */}
            {mode === "single" && recipientHasMetaAddress && (
              <>
                <div className="h-px bg-black/5 dark:bg-white/5" />
                <label className="flex items-center justify-between gap-3 py-4 cursor-pointer select-none">
                  <div className="flex items-start gap-3 flex-1">
                    <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                      <Sparkles size={16} />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-[var(--text-primary)]">Send to stealth address</span>
                      <span className="text-xs text-[var(--text-secondary)] leading-snug">
                        Recipient publishes a stealth meta-address. We&apos;ll derive a fresh one-time address. Outside observers can&apos;t link the payment to them.
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={metaStealthMode}
                    onClick={() => {
                      setMetaStealthMode((s) => !s);
                      // Mutually exclusive with the claim-code toggle.
                      if (!metaStealthMode) setStealthMode(false);
                    }}
                    className={cn(
                      "relative w-11 h-6 rounded-full transition-colors shrink-0",
                      metaStealthMode ? "bg-emerald-500" : "bg-black/10 dark:bg-white/10",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform",
                        metaStealthMode ? "translate-x-5" : "translate-x-0.5",
                      )}
                    />
                  </button>
                </label>
              </>
            )}

            {/* Hide-my-identity (claim-code) toggle — stealth is a single-recipient
                primitive (claim-code per payment), so the toggle is hidden
                in many mode. Hidden when the recipient publishes a meta-address
                (the meta-stealth toggle above is the better option). */}
            {mode === "single" && !recipientHasMetaAddress && (
              <>
                <div className="h-px bg-black/5 dark:bg-white/5" />
                <label className="flex items-center justify-between gap-3 py-4 cursor-pointer select-none">
                  <div className="flex items-start gap-3 flex-1">
                    <div className="w-9 h-9 rounded-xl bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0">
                      <EyeOff size={16} />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-[var(--text-primary)]">Hide my identity</span>
                      <span className="text-xs text-[var(--text-secondary)] leading-snug">
                        Recipient claims via a shareable link. Your address never sits next to theirs on-chain.
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={stealthMode}
                    onClick={() => setStealthMode((s) => !s)}
                    className={cn(
                      "relative w-11 h-6 rounded-full transition-colors shrink-0",
                      stealthMode ? "bg-violet-500" : "bg-black/10 dark:bg-white/10",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform",
                        stealthMode ? "translate-x-5" : "translate-x-0.5",
                      )}
                    />
                  </button>
                </label>
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
                  {step === "approving"
                    ? "Approving encrypted transfers..."
                    : isEncrypting
                      ? "Encrypting payment amount..."
                      : `Broadcasting to ${activeChain.name}...`}
                </p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {step === "approving"
                    ? "First batch needs a one-time vault approval"
                    : isEncrypting
                      ? "Generating FHE ciphertext and ZK proof"
                      : "Waiting for transaction confirmation"}
                </p>
              </div>
            </div>
          )}

          {/* Phase 7.4: paymaster degraded surface — appears when the
              sponsored gas pool is too low to reliably cover the next
              UserOp. Lets the user know BEFORE they tap Confirm so they
              don't burn input on a tx that would revert. */}
          {paymasterHealth.status === "degraded" && (
            <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 p-4 flex gap-3">
              <AlertCircle
                size={20}
                className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-300 mb-0.5">
                  Sponsored gas is running low
                </p>
                <p className="text-sm text-amber-700 dark:text-amber-400/80 break-words">
                  Your send may still go through. If it fails, we'll walk you
                  through funding your wallet so you can pay your own gas as a
                  one-time fallback.
                </p>
              </div>
            </div>
          )}

          {needsFunding && (
            <div className="rounded-2xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 p-4 flex gap-3">
              <Wallet
                size={20}
                className="text-rose-600 dark:text-rose-400 shrink-0 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-rose-900 dark:text-rose-300 mb-0.5">
                  Sponsored gas unavailable
                </p>
                <p className="text-sm text-rose-700 dark:text-rose-400/80 break-words">
                  Top up ~0.001 ETH on your smart wallet to keep sending.
                  We'll walk you through it. Tap the button below.
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
            onClick={handleConfirm}
            // #377: gate on `effectiveAddress` so impatient clicks can't fire
            // confirmSend before useSmartAccount finishes its first
            // resolveAccount (per-instance useState; the binder's instance
            // may be "ready" while SendConfirm's instance is still "idle").
            // The pre-fix race manifested as a silent
            // "Smart wallet not ready" toast and a never-arriving passphrase
            // modal in wave4 phase 02 e2e.
            disabled={isProcessing || !effectiveAddress}
            className={cn(
              "w-full h-14 rounded-2xl font-medium transition-all active:scale-95 flex items-center justify-center gap-2",
              isProcessing
                ? "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed"
                : isErrored
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : needsFunding
                    ? "bg-rose-600 hover:bg-rose-700 text-white"
                    : metaStealthMode
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                      : stealthMode
                        ? "bg-violet-600 hover:bg-violet-700 text-white"
                        : "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] hover:bg-[#000000] dark:hover:bg-gray-100",
            )}
          >
            {isProcessing ? (
              <div className="w-5 h-5 border-2 border-gray-400/30 border-t-gray-400 rounded-full animate-spin" />
            ) : isErrored ? (
              <AlertCircle size={18} strokeWidth={2.2} />
            ) : needsFunding ? (
              <Wallet size={18} strokeWidth={2.2} />
            ) : metaStealthMode ? (
              <Sparkles size={18} strokeWidth={2.2} />
            ) : stealthMode ? (
              <EyeOff size={18} strokeWidth={2.2} />
            ) : (
              <Shield size={18} strokeWidth={2.2} />
            )}
            <span>{statusLabel}</span>
          </button>
        </div>
      </div>

      {/* Phase 7.6: chain-aware ETH funding walkthrough. Opens when the
          user taps "Fund wallet to send" with paymaster unavailable +
          insufficient AA ETH. Polls balance every 5s; auto-closes once
          funded so the user can immediately retry the send. */}
      <FundAccountModal
        open={fundModalOpen}
        onClose={() => setFundModalOpen(false)}
        address={effectiveAddress as `0x${string}` | null}
        chainId={activeChainId}
        requiredWei={SELF_PAY_REQUIRED_WEI}
        onFunded={() => {
          // Refresh the balance query so `aaCanSelfPay` updates immediately.
          void aaBalance.refetch();
        }}
      />
    </div>
  );
}
