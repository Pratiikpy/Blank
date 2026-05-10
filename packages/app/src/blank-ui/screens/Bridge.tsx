import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Zap,
  Clock,
  RefreshCw,
} from "lucide-react";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { useReadContract } from "wagmi";
import toast from "react-hot-toast";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import {
  useBridgeUSDC,
  type BridgeStep,
} from "@/hooks/useBridgeUSDC";
import {
  CCTP_USDC,
  CCTP_DOMAIN,
} from "@/lib/cctp";
import {
  CHAINS,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  type SupportedChainId,
} from "@/lib/constants";
import { cn } from "@/lib/cn";
import { truncateAddress } from "@/lib/address";

// ───────────────────────────────────────────────────────────────────
//  Bridge — CCTP V2 burn-and-mint USDC between Sepolia and Base Sepolia.
//
//  Uses native (Circle-issued) USDC, not the FHE-vault wrapper. Users
//  must unshield first if their balance is encrypted. The screen calls
//  this out explicitly.
//
//  Flow is a two-phase state machine — see useBridgeUSDC. Phase 1 (approve
//  + burn + poll) finishes when the attestation lands. Phase 2 (switch
//  chain + receiveMessage) is user-initiated via the "Switch & Claim"
//  button. We never auto-switch chain on Phase 1 so the user can still
//  navigate freely while polling.
// ───────────────────────────────────────────────────────────────────

function chainName(id: SupportedChainId): string {
  return CHAINS[id]?.name ?? `Chain ${id}`;
}

function explorerUrl(id: SupportedChainId, hash: string): string {
  const base = CHAINS[id]?.explorerUrl;
  if (!base) return "#";
  return `${base.replace(/\/$/, "")}/tx/${hash}`;
}

function statusLabel(step: BridgeStep, attestationStatus: string | null): string {
  switch (step) {
    case "idle":
      return "Ready to bridge";
    case "approving":
      return "Approving USDC for the CCTP bridge…";
    case "burning":
      return "Burning USDC on the source chain…";
    case "polling":
      return attestationStatus === "complete"
        ? "Attestation ready"
        : `Waiting for Circle attestation${attestationStatus ? ` (${attestationStatus})` : ""}…`;
    case "readyToClaim":
      return "Attestation ready — claim on the destination chain";
    case "switching":
      return "Switching to destination chain…";
    case "minting":
      return "Minting USDC on the destination chain…";
    case "complete":
      return "Bridge complete";
    case "error":
      return "Bridge interrupted. See error below";
  }
}

/** When mounted as a tab inside the Exchange screen (Phase 5.3), the
 *  outer container already prints an "Exchange" page header and tab nav,
 *  so suppress this component's own header to avoid duplicate H1 a11y +
 *  visual noise. Standalone /app/bridge mounts pass the default (false). */
export default function Bridge({ embedded = false }: { embedded?: boolean } = {}) {
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChainId } = useChain();
  const bridge = useBridgeUSDC();

  // Default the source chain to whatever the user is currently on.
  const [sourceChain, setSourceChain] = useState<SupportedChainId>(activeChainId);
  const destChain = useMemo<SupportedChainId>(
    () => (sourceChain === ETH_SEPOLIA_ID ? BASE_SEPOLIA_ID : ETH_SEPOLIA_ID),
    [sourceChain],
  );
  const [amountInput, setAmountInput] = useState("");
  const [speed, setSpeed] = useState<"fast" | "finalized">("fast");

  // Keep the source chain in sync with the active wagmi chain so the form
  // doesn't quietly target the wrong network. The user can flip the source
  // selector to swap direction; that flips the active chain too.
  useEffect(() => {
    setSourceChain(activeChainId);
  }, [activeChainId]);

  // ── Balance read on the source chain ─────────────────────────────
  const balanceQuery = useReadContract({
    chainId: sourceChain,
    address: CCTP_USDC[sourceChain],
    abi: erc20Abi,
    functionName: "balanceOf",
    args: effectiveAddress ? [effectiveAddress as `0x${string}`] : undefined,
    query: {
      enabled: !!effectiveAddress,
      refetchInterval: 15_000,
    },
  });

  const balanceUnits = (balanceQuery.data as bigint | undefined) ?? 0n;
  const balanceDisplay = formatUnits(balanceUnits, 6);

  // ── Form validity ────────────────────────────────────────────────
  let amountUnits = 0n;
  let amountError: string | null = null;
  if (amountInput.trim().length > 0) {
    try {
      amountUnits = parseUnits(amountInput, 6);
      if (amountUnits <= 0n) amountError = "Amount must be > 0";
      else if (amountUnits > balanceUnits) amountError = "Amount exceeds balance";
    } catch {
      amountError = "Invalid amount";
    }
  }

  const canStart =
    bridge.step === "idle" &&
    amountInput.length > 0 &&
    !amountError &&
    sourceChain === activeChainId;

  // ── Handlers ─────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!canStart) return;
    if (sourceChain !== activeChainId) {
      toast.error("Switch to the source chain first");
      return;
    }
    await bridge.start({
      sourceChain,
      destChain,
      amountUnits,
      speed,
    });
  };

  const handleClaim = async () => {
    await bridge.claim();
  };

  // ── Computed UI flags ────────────────────────────────────────────
  const inProgress = ![
    "idle",
    "readyToClaim",
    "complete",
    "error",
  ].includes(bridge.step);

  const isReadyToClaim = bridge.step === "readyToClaim";
  const isComplete = bridge.step === "complete";

  return (
    <div className={embedded ? "" : "animate-in fade-in slide-in-from-bottom-4 duration-500"}>
      <div className={embedded ? "" : "max-w-xl mx-auto"}>
        {/* Header — suppressed when embedded (outer Exchange tab already
            prints a page header). */}
        {!embedded && (
          <div className="mb-8">
            <h1
              className="text-3xl sm:text-5xl font-medium tracking-tight text-[var(--text-primary)] mb-2"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Bridge USDC
            </h1>
            <p className="text-base text-[var(--text-secondary)] leading-relaxed">
              Move native USDC between Ethereum Sepolia and Base Sepolia using
              Circle CCTP V2 (burn-and-mint). The bridge takes ~15 seconds on
              Fast, ~15 minutes on Finalized.
            </p>
          </div>
        )}

        {/* Resume banner — surfaces when a previous bridge was started in
            this browser but never claimed. Reading from localStorage
            (useBridgeUSDC handles persistence). Hidden once the user
            either resumes or starts a fresh bridge. */}
        {bridge.resumable &&
          bridge.step === "idle" &&
          !inProgress && (
            <div className="mb-6 rounded-2xl bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/30 p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-violet-500/15 flex items-center justify-center text-violet-700 dark:text-violet-300 shrink-0">
                <Loader2 size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-violet-900 dark:text-violet-300">
                  Unfinished bridge
                </p>
                <p className="text-sm text-violet-700 dark:text-violet-400/80 leading-snug">
                  You started a bridge from {chainName(bridge.resumable.sourceChainId)} to{" "}
                  {chainName(bridge.resumable.destChainId)}{" "}
                  {Math.max(0, Math.round((Date.now() - bridge.resumable.startedAt) / 60000))} min ago.
                  {" "}{bridge.resumable.attestation ? "Ready to claim." : "Picking up the attestation poll where it left off."}
                </p>
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <button
                  onClick={() => void bridge.resume()}
                  className="h-10 px-4 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-all"
                >
                  Resume
                </button>
                <button
                  onClick={() => bridge.reset()}
                  className="h-8 px-3 rounded-xl text-xs text-violet-700 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-500/10"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

        {/* Form card */}
        <div className="rounded-[2rem] glass-card-static p-6 sm:p-8 space-y-6">
          {/* From / To row */}
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-2 block">
                From
              </label>
              <button
                type="button"
                disabled={inProgress}
                onClick={() =>
                  setSourceChain((c) =>
                    c === ETH_SEPOLIA_ID ? BASE_SEPOLIA_ID : ETH_SEPOLIA_ID,
                  )
                }
                className="h-14 w-full rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 px-5 text-left font-medium text-[var(--text-primary)] disabled:opacity-50"
              >
                {chainName(sourceChain)}
              </button>
            </div>
            <div className="pt-7">
              <ArrowRight className="text-[var(--text-tertiary)]" />
            </div>
            <div className="flex-1">
              <label className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-2 block">
                To
              </label>
              <div className="h-14 w-full rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 px-5 flex items-center font-medium text-[var(--text-primary)]">
                {chainName(destChain)}
              </div>
            </div>
          </div>

          {/* Active-chain mismatch warning */}
          {sourceChain !== activeChainId && (
            <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/20 p-4 text-sm text-amber-900 dark:text-amber-300">
              Your wallet is on <strong>{chainName(activeChainId)}</strong> but the
              bridge source is <strong>{chainName(sourceChain)}</strong>. Use the
              chain selector to switch before starting.
            </div>
          )}

          {/* Amount */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)]">
                Amount
              </label>
              <button
                type="button"
                onClick={() => setAmountInput(balanceDisplay)}
                disabled={inProgress || balanceUnits === 0n}
                className="text-xs font-medium text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
              >
                Max ({balanceDisplay} USDC)
              </button>
            </div>
            <div className="relative">
              <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-tertiary)]">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={amountInput}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setAmountInput(v);
                }}
                disabled={inProgress}
                className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 outline-none text-lg font-mono disabled:opacity-50"
              />
            </div>
            {amountError && (
              <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">{amountError}</p>
            )}
          </div>

          {/* Speed toggle */}
          <div>
            <label className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-2 block">
              Speed
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setSpeed("fast")}
                disabled={inProgress}
                className={cn(
                  "h-16 rounded-2xl border px-4 flex items-start gap-3 text-left transition-colors disabled:opacity-50",
                  speed === "fast"
                    ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30"
                    : "bg-white/60 dark:bg-white/5 border-black/5 dark:border-white/10",
                )}
              >
                <Zap size={18} className="text-emerald-600 mt-0.5" />
                <div>
                  <p className="font-medium text-[var(--text-primary)]">Fast</p>
                  <p className="text-xs text-[var(--text-secondary)]">~15s · 0.5% fee cap</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setSpeed("finalized")}
                disabled={inProgress}
                className={cn(
                  "h-16 rounded-2xl border px-4 flex items-start gap-3 text-left transition-colors disabled:opacity-50",
                  speed === "finalized"
                    ? "bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30"
                    : "bg-white/60 dark:bg-white/5 border-black/5 dark:border-white/10",
                )}
              >
                <Clock size={18} className="text-indigo-600 mt-0.5" />
                <div>
                  <p className="font-medium text-[var(--text-primary)]">Finalized</p>
                  <p className="text-xs text-[var(--text-secondary)]">~15min · no fee</p>
                </div>
              </button>
            </div>
          </div>

          {/* Privacy reminder */}
          <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/20 p-4 text-xs text-amber-900 dark:text-amber-300 leading-relaxed">
            CCTP burns and mints native USDC, not the encrypted FHE-vault
            wrapper. Amounts are visible on both chains during the bridge
            window. Unshield encrypted balances first if you need to bridge.
          </div>

          {/* Action button(s) */}
          {bridge.step !== "complete" && bridge.step !== "readyToClaim" && (
            <button
              type="button"
              onClick={handleStart}
              disabled={!canStart || inProgress}
              className={cn(
                "w-full h-14 rounded-2xl text-white font-medium transition-all active:scale-[0.99] flex items-center justify-center gap-2",
                canStart && !inProgress
                  ? "bg-[#1D1D1F] hover:bg-[#000]"
                  : "bg-gray-300 dark:bg-gray-700 cursor-not-allowed",
              )}
            >
              {inProgress ? <Loader2 className="animate-spin" size={18} /> : null}
              <span>{statusLabel(bridge.step, bridge.attestationStatus)}</span>
            </button>
          )}

          {isReadyToClaim && (
            <button
              type="button"
              onClick={handleClaim}
              className="w-full h-14 rounded-2xl text-white font-medium bg-emerald-600 hover:bg-emerald-700 transition-all active:scale-[0.99] flex items-center justify-center gap-2"
            >
              Switch to {chainName(destChain)} &amp; Claim
            </button>
          )}

          {isComplete && (
            <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 p-4 flex items-start gap-3">
              <CheckCircle2 className="text-emerald-600 mt-0.5" size={20} />
              <div className="flex-1">
                <p className="font-medium text-emerald-900 dark:text-emerald-300">
                  Bridge complete
                </p>
                <p className="text-xs text-emerald-700 dark:text-emerald-400/80 mt-1">
                  USDC minted to {truncateAddress(effectiveAddress ?? "")} on{" "}
                  {chainName(destChain)}.
                </p>
              </div>
              <button
                onClick={bridge.reset}
                className="text-xs font-medium text-emerald-700 hover:underline shrink-0 inline-flex items-center gap-1"
              >
                <RefreshCw size={12} /> Bridge again
              </button>
            </div>
          )}

          {bridge.error && (
            <div className="rounded-2xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 p-4 flex items-start gap-3">
              <XCircle className="text-rose-600 mt-0.5" size={20} />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-rose-900 dark:text-rose-300">
                  {statusLabel(bridge.step, bridge.attestationStatus)}
                </p>
                <p className="text-xs text-rose-700 dark:text-rose-400/80 mt-1 break-words">
                  {bridge.error}
                </p>
              </div>
              <button
                onClick={bridge.reset}
                className="text-xs font-medium text-rose-700 hover:underline shrink-0"
              >
                Reset
              </button>
            </div>
          )}
        </div>

        {/* Tx hashes */}
        {(bridge.txHashes.approve || bridge.txHashes.burn || bridge.txHashes.mint) && (
          <div className="mt-6 rounded-[2rem] glass-card-static p-6 space-y-3 text-sm">
            <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)]">
              Transactions
            </p>
            {bridge.txHashes.approve && (
              <TxRow
                label="Approve"
                hash={bridge.txHashes.approve}
                chainId={sourceChain}
              />
            )}
            {bridge.txHashes.burn && (
              <TxRow
                label="Burn"
                hash={bridge.txHashes.burn}
                chainId={sourceChain}
              />
            )}
            {bridge.txHashes.mint && (
              <TxRow
                label="Mint"
                hash={bridge.txHashes.mint}
                chainId={destChain}
              />
            )}
          </div>
        )}

        {/* Diagnostic detail (collapsed by default) */}
        {bridge.quote && bridge.step !== "idle" && (
          <details className="mt-4 text-xs text-[var(--text-tertiary)]">
            <summary className="cursor-pointer">Bridge details</summary>
            <div className="pt-2 pl-2 space-y-1 font-mono">
              <div>Source domain: {CCTP_DOMAIN[sourceChain]}</div>
              <div>Dest domain: {bridge.quote.destDomain}</div>
              <div>
                Min finality: {bridge.quote.minFinalityThreshold} (
                {bridge.quote.minFinalityThreshold === 1000 ? "Fast" : "Finalized"})
              </div>
              {bridge.attestation && (
                <div className="break-all">
                  attestation: {bridge.attestation.attestation.slice(0, 20)}…
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function TxRow({
  label,
  hash,
  chainId,
}: {
  label: string;
  hash: string;
  chainId: SupportedChainId;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <a
        href={explorerUrl(chainId, hash)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-emerald-600 hover:underline inline-flex items-center gap-1"
      >
        {hash.slice(0, 10)}…{hash.slice(-6)}
        <ExternalLink size={11} />
      </a>
    </div>
  );
}
