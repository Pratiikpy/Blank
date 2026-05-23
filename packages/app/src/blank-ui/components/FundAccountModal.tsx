// FundAccountModal — chain-aware "send ETH to your AA" walkthrough.
//
// Surfaces when the BlankPaymaster is degraded AND the user's smart account
// lacks enough ETH on the active chain to self-pay a UserOp's prefund. Walks
// the user through depositing testnet ETH from a public faucet directly to
// their AA's same-on-every-chain address.
//
// Critical UX guard: same AA address holds INDEPENDENT ETH balances per
// chain. We repeat the chain name in the title, the address row, and the
// faucet links section so a user transacting on Base Sepolia never accidentally
// sends Sepolia ETH (or vice-versa). The chain badge color comes from the
// active chain's identity colour so it's visually distinct.
//
// Polling: live `useBalance` against the active chain's RPC, refresh every
// 5 seconds while the modal is open. When balance crosses the required
// threshold, the Continue button enables and the on-success callback fires.

import { useEffect, useMemo, useState } from "react";
import { useBalance } from "wagmi";
import { formatUnits, type Address, type Hex } from "viem";
import {
  CheckCircle2,
  Copy,
  Check,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import toast from "react-hot-toast";
import { CHAINS, FAUCET_LINKS, type SupportedChainId } from "@/lib/constants";
import { cn } from "@/lib/cn";

/** Default minimum ETH required to cover a single self-pay UserOp's prefund.
 *  Sized for non-deploy ops on testnet (gas ~600k × 1 gwei = 0.0006 ETH plus
 *  margin). First-time deploys may need ~0.005 — callers can override. */
const DEFAULT_REQUIRED_WEI = 1_000_000_000_000_000n; // 0.001 ETH

export interface FundAccountModalProps {
  /** Modal visibility. */
  open: boolean;
  /** Dismiss handler — called on overlay click, escape, or close button. */
  onClose: () => void;
  /** AA address to fund. Same on every chain (Create2-deterministic) but the
   *  ETH balance is per-chain — we always read against `chainId`. */
  address: Address | null;
  /** Active chain — drives the title, badge colour, and faucet list. */
  chainId: SupportedChainId;
  /** Required ETH balance in wei. Defaults to 0.001 ETH. */
  requiredWei?: bigint;
  /** Called once balance >= requiredWei. Caller closes the modal and proceeds. */
  onFunded?: (currentWei: bigint) => void;
  /** Optional title override (e.g. "Fund your wallet to send"). */
  title?: string;
}

export function FundAccountModal({
  open,
  onClose,
  address,
  chainId,
  requiredWei = DEFAULT_REQUIRED_WEI,
  onFunded,
  title,
}: FundAccountModalProps) {
  const chain = CHAINS[chainId];
  const faucets = FAUCET_LINKS[chainId] ?? [];

  // Live ETH balance against the active chain. Poll every 5 seconds while
  // the modal is open; React Query stops the loop automatically when the
  // component unmounts (modal closes).
  const balanceQuery = useBalance({
    address: open && address ? address : undefined,
    chainId,
    query: {
      enabled: open && !!address,
      refetchInterval: open ? 5_000 : false,
    },
  });

  const balanceWei = balanceQuery.data?.value ?? 0n;
  const isFunded = balanceWei >= requiredWei;
  const progressPct = requiredWei > 0n
    ? Math.min(100, Number((balanceWei * 100n) / requiredWei))
    : 0;

  // Fire onFunded once when threshold is crossed. Guarded so we don't
  // re-fire on subsequent polls if the user pauses on the success state.
  const [didFire, setDidFire] = useState(false);
  useEffect(() => {
    if (!open) {
      setDidFire(false);
      return;
    }
    if (isFunded && !didFire) {
      setDidFire(true);
      onFunded?.(balanceWei);
    }
  }, [open, isFunded, didFire, balanceWei, onFunded]);

  // Address copy state — clears after 1.5s.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      toast.error("Could not copy. Long-press the address to copy manually.");
    }
  };

  const requiredEth = useMemo(
    () => formatUnits(requiredWei, 18),
    [requiredWei],
  );
  const balanceEth = useMemo(
    () => formatUnits(balanceWei, 18),
    [balanceWei],
  );

  // ESC key closes the modal — match standard dialog behaviour.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title ?? `Fund your ${chain.name} wallet`}
    >
      <div
        className="bg-white dark:bg-[#1a1a1a] w-full sm:max-w-md rounded-t-[2rem] sm:rounded-[2rem] border border-black/5 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[92dvh]"
        onClick={(e) => e.stopPropagation()}
        style={{
          paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))",
        }}
      >
        {/* Header — chain badge appears here, AGAIN by the address, AGAIN
            in the faucet section. The triplet is intentional. */}
        <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-4">
          <div className="min-w-0">
            <ChainBadge chainName={chain.name} className="mb-2" />
            <h2
              className="text-xl sm:text-2xl font-medium text-[var(--text-primary)] tracking-tight"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              {title ?? `Fund your ${chain.name} wallet`}
            </h2>
            <p className="text-sm text-[var(--text-secondary)] mt-1 leading-snug">
              Sponsored gas is unavailable. Send a small amount of {chain.name} ETH
              to your wallet and we'll keep going.
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 w-9 h-9 rounded-full bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 flex items-center justify-center"
            aria-label="Close"
          >
            <X size={18} className="text-[var(--text-primary)]" />
          </button>
        </div>

        {/* Balance progress */}
        <div className="px-6">
          <div className="rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 p-4">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <span className="text-xs font-semibold tracking-widest uppercase text-[var(--text-tertiary)]">
                Balance on {chain.name}
              </span>
              {balanceQuery.isFetching && (
                <Loader2 size={12} className="animate-spin text-[var(--text-tertiary)]" />
              )}
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-2xl font-mono tabular-nums text-[var(--text-primary)]">
                {trimZeros(balanceEth)} <span className="text-sm text-[var(--text-secondary)]">ETH</span>
              </span>
              <span className="text-sm text-[var(--text-secondary)]">
                of {trimZeros(requiredEth)} ETH needed
              </span>
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  isFunded ? "bg-emerald-500" : "bg-amber-500",
                )}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Address + QR */}
        <div className="px-6 mt-4">
          <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-tertiary)] mb-2">
            Your wallet address (on {chain.name})
          </p>
          <div className="rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 p-4 flex items-start gap-4">
            <div className="bg-white p-2 rounded-xl shrink-0">
              {address ? (
                <QRCodeSVG value={address} size={96} level="M" includeMargin={false} />
              ) : (
                <div className="w-24 h-24 bg-black/5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-[var(--text-secondary)] mb-1.5">
                Send {chain.name} ETH to:
              </p>
              <p className="font-mono text-xs text-[var(--text-primary)] break-all leading-relaxed">
                {address ?? "—"}
              </p>
              <button
                onClick={handleCopy}
                disabled={!address}
                className="mt-2 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-xs font-medium text-[var(--text-primary)] disabled:opacity-50"
              >
                {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>

        {/* Faucet links */}
        <div className="px-6 mt-4">
          <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-tertiary)] mb-2">
            Get free {chain.name} ETH
          </p>
          <div className="space-y-2">
            {faucets.map((faucet) => (
              <a
                key={faucet.url}
                href={faucet.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10 transition-colors"
              >
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {faucet.label}
                </span>
                <ExternalLink size={14} className="text-[var(--text-tertiary)]" />
              </a>
            ))}
            {faucets.length === 0 && (
              <p className="text-xs text-[var(--text-secondary)]">
                No faucets configured for this chain. Send ETH from another wallet.
              </p>
            )}
          </div>
        </div>

        {/* Sticky CTA */}
        <div className="px-6 mt-5 pb-2">
          <button
            onClick={() => {
              if (isFunded) {
                onFunded?.(balanceWei);
                onClose();
              }
            }}
            disabled={!isFunded}
            className={cn(
              "w-full h-14 rounded-2xl font-medium transition-all flex items-center justify-center gap-2",
              isFunded
                ? "bg-emerald-500 hover:bg-emerald-600 text-white active:scale-[0.99]"
                : "bg-black/5 dark:bg-white/10 text-[var(--text-tertiary)] cursor-not-allowed",
            )}
          >
            {isFunded ? (
              <>
                <CheckCircle2 size={18} />
                Funded. Continue
              </>
            ) : (
              <>
                <Loader2 size={16} className="animate-spin" />
                Waiting for {chain.name} ETH…
              </>
            )}
          </button>
          <button
            onClick={onClose}
            className="w-full h-11 mt-2 rounded-2xl text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Small chain-name pill — repeated three times in the modal. */
function ChainBadge({ chainName, className }: { chainName: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-xs font-medium text-amber-900 dark:text-amber-300",
        className,
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      {chainName}
    </span>
  );
}

/** Trim trailing zeros from formatUnits output: "0.0010000" → "0.001". */
function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

// Re-export Hex so consumers don't need a separate import.
export type { Hex };
