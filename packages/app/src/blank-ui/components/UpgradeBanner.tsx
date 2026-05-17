// Phase 4.1 — surfaces a one-click UUPS upgrade for users whose AA proxy
// is still on the pre-validator-dispatch implementation. Hidden when the
// account is current, when the canonical impl isn't deployed on this
// chain, and when the user has no AA at all.
//
// The upgrade itself is a self-call UserOp:
//   AA.execute(self, 0, abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, [newImpl, "0x"]))
//
// `_authorizeUpgrade` on BlankAccount permits upgrades from `address(this)`
// or the EntryPoint, so a UserOp originating from the user's passkey
// (signed via legacy P-256 path, which still works post-upgrade) lands
// the upgrade. After it mines, the proxy delegates to the new impl and
// future UserOps can use the validator-dispatch format.

import { useEffect, useState } from "react";
import { Sparkles, ArrowRight, Loader2, X } from "lucide-react";
import { encodeFunctionData } from "viem";
import { useBalance } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { toastMappedError } from "@/lib/error-messages";
import { useAccountVersion } from "@/hooks/useAccountVersion";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { usePaymasterHealth } from "@/hooks/usePaymasterHealth";
import { useChain } from "@/providers/ChainProvider";
import { getStoredString, setStoredString } from "@/lib/storage";

// EIP-1967 UUPSUpgradeable surface — minimal ABI for the upgrade call.
const UUPSAbi = [
  {
    type: "function",
    name: "upgradeToAndCall",
    stateMutability: "payable",
    inputs: [
      { name: "newImplementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// BlankAccount.execute(target, value, data) — used to trigger the
// self-call upgrade through the EntryPoint flow.
const BlankAccountExecAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const DISMISS_KEY_SCOPE = "upgrade_banner_dismissed";

/** Sticky-dismissal storage key, scoped per main address so the banner
 *  re-prompts on a wallet switch (different user). */
function dismissalKey(address: string): string {
  return `blank:${DISMISS_KEY_SCOPE}:${address.toLowerCase()}`;
}

export function UpgradeBanner() {
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChainId } = useChain();
  const { status, canonicalImpl } = useAccountVersion();
  const { unifiedWrite } = useUnifiedWrite();
  const queryClient = useQueryClient();
  const paymasterHealth = usePaymasterHealth();
  // Phase 7.5 self-pay readiness check — if the paymaster is unavailable
  // we route through the AA's own ETH so the upgrade itself isn't blocked
  // by a paymaster outage (audit caught this — the upgrade is exactly the
  // moment users most need the resilience layer Phase 7 added).
  const aaBalance = useBalance({
    address: effectiveAddress as `0x${string}` | undefined,
    chainId: activeChainId,
    query: { enabled: !!effectiveAddress, refetchInterval: 30_000 },
  });
  const SELF_PAY_REQUIRED_WEI = 1_000_000_000_000_000n; // 0.001 ETH
  const aaCanSelfPay = (aaBalance.data?.value ?? 0n) >= SELF_PAY_REQUIRED_WEI;
  const paymasterUnavailable = paymasterHealth.status === "unavailable";
  const [busy, setBusy] = useState(false);
  // Dismissal is sticky in localStorage AND mirrored in component state so
  // tapping Dismiss instantly hides the banner without waiting for a
  // re-render trigger from elsewhere. Per-address scope so a wallet
  // switch re-triggers the prompt for the next user.
  const [localDismissed, setLocalDismissed] = useState<boolean>(() =>
    effectiveAddress
      ? getStoredString(dismissalKey(effectiveAddress)) === "1"
      : false,
  );
  // Re-sync dismissal state when the active address changes (wallet
  // switch on a shared device). Without this, dismissal would leak from
  // the previous user's session into the next one.
  useEffect(() => {
    setLocalDismissed(
      effectiveAddress
        ? getStoredString(dismissalKey(effectiveAddress)) === "1"
        : false,
    );
  }, [effectiveAddress]);
  const dismissed = localDismissed;

  // Hide when not applicable: no AA, canonical not deployed, already on
  // current, or counterfactual (proxy not deployed yet — the user's first
  // UserOp will bake in the OLD impl, then we'll prompt next session).
  if (
    status !== "needs-upgrade" ||
    !effectiveAddress ||
    canonicalImpl === "0x0000000000000000000000000000000000000000" ||
    dismissed
  ) {
    return null;
  }

  const handleUpgrade = async () => {
    setBusy(true);
    try {
      // Build the inner upgradeToAndCall(newImpl, "0x") calldata.
      const upgradeData = encodeFunctionData({
        abi: UUPSAbi,
        functionName: "upgradeToAndCall",
        args: [canonicalImpl, "0x"],
      });
      // If paymaster is down AND the AA can self-pay, fall back to
      // self-pay mode so the upgrade isn't blocked by a paymaster outage.
      // Otherwise default (sponsored) path. SendConfirm uses the same
      // resolution.
      const paymasterMode: "self" | undefined =
        paymasterUnavailable && aaCanSelfPay ? "self" : undefined;
      // Wrap in execute(self, 0, upgradeData). The AA's `execute` does
      // target.call(data) where target == address(this); inside
      // upgradeToAndCall msg.sender is address(this), satisfying
      // _authorizeUpgrade's onlySelfOrEntryPoint gate.
      await unifiedWrite({
        address: effectiveAddress as `0x${string}`,
        abi: BlankAccountExecAbi,
        functionName: "execute",
        args: [effectiveAddress as `0x${string}`, 0n, upgradeData],
        gas: 600_000n,
        paymaster: paymasterMode,
      });
      // Eagerly invalidate the version query so the banner hides on the
      // next render instead of after the 30s polling cadence — the
      // upgrade is mined by the time unifiedWrite resolves.
      await queryClient.invalidateQueries({ queryKey: ["blank-account-impl"] });
      toast.success("Account upgraded. Session keys are now available");
    } catch (err) {
      toastMappedError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    if (effectiveAddress) {
      setStoredString(dismissalKey(effectiveAddress), "1");
    }
    setLocalDismissed(true);
  };

  return (
    <div
      role="status"
      data-testid="upgrade-banner"
      className="mb-6 rounded-2xl bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-500/10 dark:to-indigo-500/10 border border-violet-200 dark:border-violet-500/30 p-4 flex items-start gap-3"
    >
      <div className="w-10 h-10 rounded-xl bg-violet-500/15 flex items-center justify-center text-violet-700 dark:text-violet-300 shrink-0">
        <Sparkles size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-violet-900 dark:text-violet-200 mb-0.5">
          New: session keys for recurring sends
        </p>
        <p className="text-sm text-violet-700 dark:text-violet-300/80 leading-snug">
          Upgrade your smart wallet to enable scheduled payments (rent, payroll,
          subscriptions). Your address and balances stay the same — your
          existing passkey keeps working unchanged.
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={handleUpgrade}
          disabled={busy}
          data-testid="upgrade-banner-cta"
          className="h-9 px-4 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <ArrowRight size={14} />
          )}
          <span>{busy ? "Upgrading…" : "Upgrade"}</span>
        </button>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss"
          disabled={busy}
          className="w-9 h-9 rounded-xl hover:bg-violet-500/10 text-violet-700 dark:text-violet-300 flex items-center justify-center disabled:opacity-50"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
