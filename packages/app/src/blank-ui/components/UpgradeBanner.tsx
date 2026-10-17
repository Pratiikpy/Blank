// One-click UUPS upgrade for accounts whose proxy runs an older BlankAccount
// implementation. The target is the newest implementation deployed on the
// chain (lib/account-impl.ts). Factory-deployed proxies always start on the
// factory's immutable implementation, so new accounts see this once too.
//
// Hidden when the account is current, when no implementation is configured
// on this chain, when the account is still counterfactual, and when the user
// has no AA at all.
//
// The upgrade is a self-call UserOp:
//   AA.execute(self, 0, abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, [newImpl, "0x"]))
// `_authorizeUpgrade` permits calls from `address(this)` or the EntryPoint.
//
// BlankPaymaster sponsors exactly this call when newImpl is on its
// approvedImplementations list. Otherwise the upgrade pays its own gas and
// the banner holds the button until the account has enough.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, ArrowRight, Loader2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { toastMappedError } from "@/lib/error-messages";
import { useAccountVersion } from "@/hooks/useAccountVersion";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useAccountGasFunds, SELF_PAID_SETTINGS_OP_WEI } from "@/hooks/useAccountGasFunds";
import { useSelfCallSponsorship } from "@/hooks/useSelfCallSponsorship";
import { getStoredString, setStoredString } from "@/lib/storage";

// EIP-1967 UUPSUpgradeable surface: minimal ABI for the upgrade call.
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

const DISMISS_KEY_SCOPE = "upgrade_banner_dismissed";

/** Sticky-dismissal storage key, scoped per address and target
 *  implementation: a new implementation prompts again. */
function dismissalKey(address: string, impl: string): string {
  return `blank:${DISMISS_KEY_SCOPE}:${address.toLowerCase()}:${impl.toLowerCase()}`;
}

function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function UpgradeBanner() {
  const { effectiveAddress } = useEffectiveAddress();
  const { status, canonicalImpl } = useAccountVersion();
  const { unifiedWrite } = useUnifiedWrite();
  const queryClient = useQueryClient();
  const funds = useAccountGasFunds(effectiveAddress as `0x${string}` | undefined);
  const sponsored = useSelfCallSponsorship("implementation", canonicalImpl);
  const [busy, setBusy] = useState(false);
  const [localDismissed, setLocalDismissed] = useState<boolean>(() =>
    effectiveAddress
      ? getStoredString(dismissalKey(effectiveAddress, canonicalImpl)) === "1"
      : false,
  );
  useEffect(() => {
    setLocalDismissed(
      effectiveAddress
        ? getStoredString(dismissalKey(effectiveAddress, canonicalImpl)) === "1"
        : false,
    );
  }, [effectiveAddress, canonicalImpl]);

  if (
    status !== "needs-upgrade" ||
    !effectiveAddress ||
    canonicalImpl === "0x0000000000000000000000000000000000000000" ||
    localDismissed
  ) {
    return null;
  }

  const fundsKnown = funds.totalWei !== null;
  const hasGas = fundsKnown && (funds.totalWei as bigint) >= SELF_PAID_SETTINGS_OP_WEI;
  const canUpgrade = sponsored === true || hasGas;

  const handleUpgrade = async () => {
    setBusy(true);
    try {
      // unifiedWrite wraps this as execute(self, 0, upgradeToAndCall(impl, "")):
      // inside upgradeToAndCall msg.sender is the account, which satisfies
      // _authorizeUpgrade, and it is the exact shape the paymaster sponsors.
      // Unsponsored, the op falls back to the account's own gas.
      await unifiedWrite({
        address: effectiveAddress as `0x${string}`,
        abi: UUPSAbi,
        functionName: "upgradeToAndCall",
        args: [canonicalImpl, "0x"],
        gas: 600_000n,
      });
      await queryClient.invalidateQueries({ queryKey: ["blank-account-impl"] });
      await queryClient.invalidateQueries({ queryKey: ["account-gas-funds"] });
      toast.success("Account upgraded. Re-enable scheduled sends if you use them.");
    } catch (err) {
      toastMappedError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    setStoredString(dismissalKey(effectiveAddress, canonicalImpl), "1");
    setLocalDismissed(true);
  };

  return (
    <div
      role="status"
      data-testid="upgrade-banner"
      className="mb-6 rounded-2xl bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-500/10 dark:to-indigo-500/10 border border-violet-200 dark:border-violet-500/30 p-4 flex flex-col sm:flex-row sm:items-start gap-3"
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="w-10 h-10 rounded-xl bg-violet-500/15 flex items-center justify-center text-violet-700 dark:text-violet-300 shrink-0">
          <ShieldCheck size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-violet-900 dark:text-violet-200 mb-0.5">
            Security update for your smart wallet
          </p>
          <p className="text-sm text-violet-700 dark:text-violet-300/80 leading-snug">
            Signatures become bound to this account and this chain, and a
            recovery revokes every session key. Your address, balances and
            passkey stay the same. Scheduled sends need to be enabled again
            afterwards.
          </p>
          <p className="text-xs text-violet-700/80 dark:text-violet-300/70 mt-1.5" data-testid="upgrade-banner-gas">
            {sponsored === true
              ? "Gas is sponsored by Blank. No ETH needed."
              : !fundsKnown
                ? "Checking your gas balance."
                : hasGas
                  ? `Paid from your own gas (about ${formatEth(SELF_PAID_SETTINGS_OP_WEI)} ETH at most).`
                  : (
                    <>
                      Needs about {formatEth(SELF_PAID_SETTINGS_OP_WEI)} ETH of gas in this wallet while sponsorship is unavailable.{" "}
                      <Link to="/app/wallet" className="underline font-medium">Add gas</Link>
                    </>
                  )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 self-end sm:self-start">
        <button
          onClick={handleUpgrade}
          disabled={busy || !canUpgrade}
          data-testid="upgrade-banner-cta"
          className="h-11 sm:h-9 px-4 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          <span>{busy ? "Upgrading…" : "Upgrade"}</span>
        </button>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss"
          disabled={busy}
          className="w-11 h-11 sm:w-9 sm:h-9 rounded-xl hover:bg-violet-500/10 text-violet-700 dark:text-violet-300 flex items-center justify-center disabled:opacity-50"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
