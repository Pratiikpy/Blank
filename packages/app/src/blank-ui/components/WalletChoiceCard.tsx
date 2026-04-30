// Phase 7.1: Three-option wallet picker. Replaces the implicit
// "passkey CTA above a connector list" pattern in Onboarding so each
// path carries an honest one-line tradeoff:
//
//   ① Create a passkey wallet     (default — sponsored gas, no extension)
//   ② Connect existing wallet      (MetaMask / WalletConnect — user pays gas)
//   ③ Browse without a wallet      (read-only — back to landing)
//
// Coinbase Smart Wallet is intentionally NOT surfaced as its own option
// because the wagmi `coinbaseWallet` connector emits COOP warnings on
// every page load (our COOP is `same-origin` so TFHE can use
// SharedArrayBuffer). Coinbase users reach Blank via WalletConnect's
// universal modal instead — same outcome, one less broken connector.
//
// Designed to be reusable: PayPage can drop this in when an unauth user
// hits a payment link, with `hideBrowse` set since "browse" is nonsense
// in that context.

import { useCallback } from "react";
import { useConnect } from "wagmi";
import { Fingerprint, Wallet, Loader2, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export interface WalletChoiceCardProps {
  /** Fired when the user picks "Create passkey". Caller opens the
   *  passkey-creation modal in response. */
  onSelectPasskey: () => void;
  /** Fired when the user picks "Browse without a wallet". Caller navigates
   *  to landing. Ignored when `hideBrowse` is true. */
  onSelectBrowse?: () => void;
  /** Hide the "Browse without a wallet" tertiary link. Set on PayPage. */
  hideBrowse?: boolean;
  /** Optional className appended to the outer wrapper. */
  className?: string;
}

export function WalletChoiceCard({
  onSelectPasskey,
  onSelectBrowse,
  hideBrowse = false,
  className,
}: WalletChoiceCardProps) {
  const { connectors, connect, isPending, error: connectError, reset } = useConnect();

  // Pivoting to passkey / browse must clear any in-flight wagmi state so:
  //   1. A leftover `connectError` (e.g. user rejected MetaMask) doesn't
  //      stay rose-coloured under the existing-wallet card after the
  //      passkey modal opens.
  //   2. A pending wagmi handshake doesn't race the passkey creation —
  //      `BlankApp.tsx` picks `isConnected || hasPasskeyAccount`, so an
  //      EOA finishing first would orphan the freshly-minted passkey AA.
  const handlePasskey = useCallback(() => {
    reset();
    onSelectPasskey();
  }, [onSelectPasskey, reset]);

  const handleBrowse = useCallback(() => {
    reset();
    onSelectBrowse?.();
  }, [onSelectBrowse, reset]);

  return (
    <div className={cn("space-y-4", className)}>
      {/* Option 1 — Create passkey (recommended, visually emphasised).
          testid kept as `onboarding-passkey-cta` for backward compat with
          existing e2e tests (smoke-phase1, passkey-smart-wallet).
          Disabled while a wagmi connector handshake is mid-flight to
          avoid the orphan-passkey race described in handlePasskey. */}
      <button
        onClick={handlePasskey}
        disabled={isPending}
        data-testid="onboarding-passkey-cta"
        className="group w-full text-left rounded-2xl bg-[#1D1D1F] text-white p-5 hover:bg-black transition-all active:scale-[0.99] flex items-center gap-4 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <div className="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
          <Fingerprint size={22} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <p className="font-semibold">Create a passkey wallet</p>
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-emerald-400/20 text-emerald-300">
              Free gas
            </span>
          </div>
          <p className="text-sm text-white/70 leading-snug">
            Saved to this device. No extension. We sponsor the gas.
          </p>
        </div>
        <ChevronRight size={18} className="text-white/40 group-hover:text-white/70 transition-colors shrink-0" />
      </button>

      {/* Option 2 — Connect existing wallet (medium emphasis). Connector
          buttons render inline always, so e2e tests can find "Connect
          MetaMask" without first toggling a disclosure. */}
      <div
        data-testid="wallet-choice-existing"
        className="rounded-2xl bg-white text-gray-900 border border-gray-200 p-5"
      >
        <div className="flex items-center gap-4 mb-4">
          <div className="w-11 h-11 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
            <Wallet size={22} strokeWidth={2} className="text-gray-700" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold mb-0.5">Connect existing wallet</p>
            <p className="text-sm text-gray-500 leading-snug">
              MetaMask, Rainbow, WalletConnect. You pay your own gas.
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {connectors.length === 0 && (
            <p className="text-sm text-gray-500 px-2 py-2">
              No wallets detected. Install MetaMask or scan a WalletConnect
              QR with a mobile wallet.
            </p>
          )}
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              onClick={() => connect({ connector })}
              disabled={isPending}
              aria-busy={isPending}
              aria-label={`Connect ${connector.name}${isPending ? ", connecting" : ""}`}
              className="w-full h-12 px-4 rounded-xl bg-white text-gray-900 border border-gray-200 font-medium hover:bg-gray-50 transition-all active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isPending && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              <span>Connect {connector.name}</span>
            </button>
          ))}
          {connectError && (
            <p className="text-sm text-rose-500 px-2 mt-2">{connectError.message}</p>
          )}
        </div>
      </div>

      {/* Option 3 — Browse without a wallet (de-emphasised tertiary link) */}
      {!hideBrowse && (
        <div className="pt-2 text-center">
          <button
            onClick={handleBrowse}
            data-testid="wallet-choice-browse"
            className="text-sm text-gray-500 hover:text-gray-700 hover:underline transition-colors"
          >
            Just exploring? Browse without a wallet →
          </button>
        </div>
      )}
    </div>
  );
}
