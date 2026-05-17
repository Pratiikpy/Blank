import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { formatEther } from "viem";
import { Copy, Fuel, RefreshCw, ExternalLink, Wallet as WalletIcon } from "lucide-react";
import toast from "react-hot-toast";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { log } from "@/lib/log";

// ──────────────────────────────────────────────────────────────────
//  GasWalletPanel — the "self-paid gas" UI surface.
//
//  Shows:
//    • Smart-account address with a Copy CTA so the user can paste it
//      into a CEX withdrawal, hardware wallet, friend's send screen,
//      or any other source of ETH on the active chain.
//    • Live EntryPoint deposit balance (gas credit) for THIS smart
//      account, in ETH, refreshed every 10s and on demand.
//    • Plain ETH balance sitting idle on the account (pre-auto-deposit
//      arrival window, or if receive()'s auto-deposit reverted).
//
//  The Copy CTA is intentionally agnostic about the funding source.
//  The user can deposit ETH from anywhere; the BlankAccount upgrade
//  (deploy-upgrade-blankaccount-gas-wallet) makes the contract's
//  receive() hook auto-convert incoming ETH into EntryPoint gas
//  credit. The cron at /api/cron/paymaster-monitor still sponsors
//  gas while the user's deposit is empty.
//
//  Routing into self-paid mode lives in useUnifiedWrite: when the
//  smart account's EntryPoint deposit covers the estimated gas cost,
//  the UserOp is built with paymasterAndData="0x" and the sender's
//  deposit is debited instead of the operator-sponsored paymaster.
//  This component does NOT route — it only exposes the surface.
// ──────────────────────────────────────────────────────────────────

const ENTRY_POINT_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const REFRESH_INTERVAL_MS = 10_000;

export function GasWalletPanel() {
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChain, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChain.id });

  const [depositWei, setDepositWei] = useState<bigint | null>(null);
  const [idleWei, setIdleWei] = useState<bigint | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!publicClient || !effectiveAddress || !contracts.EntryPoint) return;
    setRefreshing(true);
    setLastError(null);
    try {
      const [deposit, idle] = await Promise.all([
        publicClient.readContract({
          address: contracts.EntryPoint,
          abi: ENTRY_POINT_ABI,
          functionName: "balanceOf",
          args: [effectiveAddress],
        }) as Promise<bigint>,
        publicClient.getBalance({ address: effectiveAddress }),
      ]);
      setDepositWei(deposit);
      setIdleWei(idle);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      log.warn("gasWallet.refresh.failed", err instanceof Error ? err : new Error(msg));
    } finally {
      setRefreshing(false);
    }
  }, [publicClient, effectiveAddress, contracts.EntryPoint]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const handleCopy = useCallback(async () => {
    if (!effectiveAddress) return;
    try {
      await navigator.clipboard.writeText(effectiveAddress);
      toast.success("Address copied. Send ETH from any wallet or exchange.");
    } catch {
      toast.error("Couldn't copy. Long-press to copy manually.");
    }
  }, [effectiveAddress]);

  if (!effectiveAddress) {
    return (
      <div className="rounded-2xl border border-[var(--border)] p-6 text-sm text-[var(--text-secondary)]">
        Connect a wallet or create a passkey to see your gas balance.
      </div>
    );
  }

  const depositEth = depositWei !== null ? formatEther(depositWei) : null;
  const idleEth = idleWei !== null ? formatEther(idleWei) : null;
  const hasGas = depositWei !== null && depositWei > 0n;

  return (
    <div className="rounded-2xl border border-[var(--border)] p-6 bg-white/50 dark:bg-white/[0.03]">
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
          <Fuel size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-heading font-medium text-[var(--text-primary)]">
            Gas wallet on {activeChain.name}
          </h2>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-snug">
            Deposit ETH from anywhere. Auto-converts to gas credit so Blank uses your funds, not the operator's.
          </p>
        </div>
      </div>

      <div className="rounded-xl bg-black/[0.04] dark:bg-white/[0.04] p-4 mb-4">
        <div className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-1.5">
          Your smart-account address
        </div>
        <div className="flex items-center gap-2">
          <code
            className="flex-1 font-mono text-sm text-[var(--text-primary)] break-all"
            data-testid="gas-wallet-address"
          >
            {effectiveAddress}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy smart-account address"
            className="shrink-0 h-9 w-9 rounded-lg bg-[#1D1D1F] text-white hover:bg-black flex items-center justify-center transition-colors"
          >
            <Copy size={14} />
          </button>
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-2 leading-snug">
          Send {activeChain.name} ETH to this address from any wallet, CEX withdrawal, or hardware wallet. It auto-converts to gas.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl bg-emerald-50/60 dark:bg-emerald-500/10 p-4">
          <div className="text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-300 mb-1">
            Gas credit
          </div>
          <div
            className="text-lg font-mono tabular-nums text-[var(--text-primary)]"
            data-testid="gas-wallet-deposit"
          >
            {depositEth !== null ? `${depositEth} ETH` : "…"}
          </div>
          <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
            EntryPoint deposit (covers your UserOp gas)
          </div>
        </div>
        <div className="rounded-xl bg-amber-50/60 dark:bg-amber-500/10 p-4">
          <div className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-1">
            Idle balance
          </div>
          <div
            className="text-lg font-mono tabular-nums text-[var(--text-primary)]"
            data-testid="gas-wallet-idle"
          >
            {idleEth !== null ? `${idleEth} ETH` : "…"}
          </div>
          <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
            Pre-deposit / failed auto-deposit
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="h-8 px-3 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] flex items-center gap-1.5 disabled:opacity-50"
          aria-label="Refresh gas balance"
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <a
          href={`${activeChain.explorerUrl}/address/${effectiveAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="h-8 px-3 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] flex items-center gap-1.5"
          aria-label="View account on explorer"
        >
          <ExternalLink size={12} />
          Explorer
        </a>
        {hasGas && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
            <WalletIcon size={10} /> Self-paying mode active
          </span>
        )}
      </div>

      {lastError && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-xs">
          Couldn't read balance: {lastError}
        </div>
      )}
    </div>
  );
}
