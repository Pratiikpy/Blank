/**
 * Phase 9.4 — Stealth Inbox screen.
 *
 * Lists ERC-5564 announcements that match the user's stealth keys
 * (i.e. payments addressed to a stealth address derived from their
 * meta-address). The list is the recipient-side complement to the
 * sender-side toggle in SendConfirm — together they form the
 * meta-address stealth flow.
 *
 * UX states:
 *   • No keys configured     → empty state with "Set up in Settings" CTA.
 *                               Phase 9.6 lands the Setup UI.
 *   • Keys present, scanning → progress indicator.
 *   • Keys present, no hits  → "No payments yet" + manual rescan button.
 *   • Keys present, matches  → list of stealth payments with "Sweep" CTA.
 *                               (Sweep flow lands in Phase 9.5.)
 */
import { useNavigate } from "react-router-dom";
import {
  Sparkles,
  RefreshCw,
  ArrowDown,
  KeyRound,
  ChevronLeft,
} from "lucide-react";
import { formatUnits } from "viem";

import { useStealthInbox, type StealthInboxEntry } from "@/hooks/useStealthInbox";
import { useStealthSweep } from "@/hooks/useStealthSweep";
import { useChain } from "@/providers/ChainProvider";
import { cn } from "@/lib/cn";
import { truncateAddress } from "@/lib/address";
import { useState } from "react";
import toast from "react-hot-toast";

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

function formatAmountForDisplay(
  token: string,
  amountStr: string,
  usdcAddress: string | undefined,
): string {
  // Best-effort: assume USDC-like 6dp for the project's TestUSDC, else
  // 18dp (ETH/most ERC-20s). We don't fetch decimals on every render.
  // Audit Top-28 #11: usdcAddress is now passed in from useChain() so the
  // token comparison stays correct after a reload-free chain switch.
  const usdc = usdcAddress?.toLowerCase();
  const decimals = token.toLowerCase() === usdc ? 6 : 18;
  try {
    return formatUnits(BigInt(amountStr), decimals);
  } catch {
    return amountStr;
  }
}

export default function StealthInbox() {
  const navigate = useNavigate();
  const { activeChainId, contracts } = useChain();
  const { entries, isScanning, scanProgress, hasKeys, scan } = useStealthInbox();
  const sweeper = useStealthSweep();
  const [sweepingTxHash, setSweepingTxHash] = useState<string | null>(null);

  const handleSweep = async (entry: StealthInboxEntry) => {
    setSweepingTxHash(entry.txHash);
    try {
      const result = await sweeper.sweep(entry);
      toast.success(`Swept ${entry.amount} units → your wallet`);
      console.log("[stealth-sweep] success", result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Sweep failed: ${msg}`);
    } finally {
      setSweepingTxHash(null);
    }
  };

  const sortedEntries = [...entries].sort(
    (a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)),
  );

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-2xl mx-auto flex flex-col">
        {/* Back */}
        <div className="mb-6">
          <button
            onClick={() => navigate(-1)}
            className="w-10 h-10 rounded-full bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 flex items-center justify-center hover:bg-white/80 dark:hover:bg-white/10 transition-all"
            aria-label="Go back"
          >
            <ChevronLeft size={20} className="text-[var(--text-primary)]" />
          </button>
        </div>

        {/* Title */}
        <div className="mb-8">
          <div className="flex items-start gap-3 mb-2">
            <div className="w-10 h-10 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <Sparkles size={20} />
            </div>
            <h1 className="text-3xl sm:text-4xl font-medium tracking-tight text-[var(--text-primary)]" style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}>
              Stealth Inbox
            </h1>
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            Auto-discovered payments addressed to your stealth meta-address. Outside observers can&apos;t link these to your main wallet without one of your keys.
          </p>
        </div>

        {/* No keys → setup CTA */}
        {!hasKeys && (
          <div className="rounded-3xl glass-card-static p-8 flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <KeyRound size={22} />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[var(--text-primary)] mb-1">
                Set up your stealth meta-address
              </h2>
              <p className="text-sm text-[var(--text-secondary)] max-w-md">
                Generate the spending and viewing key pair, publish your
                meta-address to the on-chain registry, and start receiving
                stealth payments. Outside observers will see only one-time
                addresses — never your main wallet.
              </p>
            </div>
            <button
              onClick={() => navigate("/app/stealth/setup")}
              className="h-11 px-6 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-colors"
            >
              Set up stealth meta-address
            </button>
          </div>
        )}

        {/* Has keys → scan UI + entries */}
        {hasKeys && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm text-[var(--text-secondary)]">
                {isScanning && scanProgress
                  ? `Scanning blocks ${scanProgress.current.toString()} / ${scanProgress.to.toString()}…`
                  : `${sortedEntries.length} stealth payment${sortedEntries.length === 1 ? "" : "s"} on chain ${activeChainId}`}
              </div>
              <button
                onClick={() => void scan()}
                disabled={isScanning}
                className={cn(
                  "h-9 px-3 rounded-lg flex items-center gap-2 text-sm transition-colors",
                  isScanning
                    ? "bg-black/5 dark:bg-white/5 text-[var(--text-secondary)] cursor-not-allowed"
                    : "bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
                )}
              >
                <RefreshCw size={14} className={cn(isScanning && "animate-spin")} />
                {isScanning ? "Scanning" : "Rescan"}
              </button>
            </div>

            {sortedEntries.length === 0 && !isScanning && (
              <div className="rounded-3xl glass-card-static p-8 text-center">
                <p className="text-sm text-[var(--text-secondary)]">
                  No stealth payments to your meta-address yet. They&apos;ll appear here automatically when received.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-3">
              {sortedEntries.map((entry) => {
                const isERC20 = entry.functionSelector.toLowerCase() === ERC20_TRANSFER_SELECTOR;
                const display = formatAmountForDisplay(entry.token, entry.amount, contracts.TestUSDC);
                return (
                  <div
                    key={`${entry.txHash}-${entry.stealthAddress}`}
                    className={cn(
                      "rounded-2xl glass-card-static p-4 flex items-start gap-3",
                      entry.swept && "opacity-60",
                    )}
                  >
                    <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                      <ArrowDown size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <span className="text-base font-medium text-[var(--text-primary)]">
                          {display} {isERC20 ? "" : "(token)"}
                        </span>
                        {entry.swept && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                            Swept
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--text-secondary)] flex flex-col gap-0.5">
                        <span>From: {truncateAddress(entry.sender)}</span>
                        <span>Stealth address: {truncateAddress(entry.stealthAddress)}</span>
                        <span>Token: {truncateAddress(entry.token)}</span>
                        <span>Block: #{entry.blockNumber}</span>
                      </div>
                      {!entry.swept && (
                        <button
                          onClick={() => void handleSweep(entry)}
                          disabled={sweepingTxHash === entry.txHash || sweeper.isSweeping}
                          className={cn(
                            "mt-3 h-9 px-4 rounded-lg text-sm font-medium transition-colors",
                            sweepingTxHash === entry.txHash
                              ? "bg-emerald-300 text-white cursor-wait"
                              : sweeper.isSweeping
                                ? "bg-gray-200 dark:bg-gray-700 text-gray-400 cursor-not-allowed"
                                : "bg-emerald-600 hover:bg-emerald-700 text-white",
                          )}
                        >
                          {sweepingTxHash === entry.txHash
                            ? sweeper.step === "funding"
                              ? "Funding stealth address…"
                              : sweeper.step === "waitingFund"
                                ? "Waiting for funding to confirm…"
                                : sweeper.step === "sweeping"
                                  ? "Sweeping…"
                                  : sweeper.step === "waitingSweep"
                                    ? "Waiting for sweep to confirm…"
                                    : "Sweeping…"
                            : "Sweep to my wallet"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
