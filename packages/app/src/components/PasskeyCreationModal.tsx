import { useState, useCallback } from "react";
import { Fingerprint, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useSmartAccount } from "@/hooks/useSmartAccount";
import { useChain } from "@/providers/ChainProvider";
import { truncateAddress } from "@/lib/address";

// R5-A: passkey-first onboarding modal.
//
// Creates a BlankAccount smart wallet from a passphrase-encrypted P-256 key
// stored in IndexedDB. No browser extension, no WalletConnect, no EOA.
// After successful creation, the user's identity IS the smart account;
// BlankApp.tsx lets them past the isConnected gate because hasPasskey() is
// true (see R5-C).

export interface PasskeyCreationModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (smartAccountAddress: string) => void;
}

export function PasskeyCreationModal({ open, onClose, onSuccess }: PasskeyCreationModalProps) {
  const { createAccount, status } = useSmartAccount();
  const { activeChain } = useChain();

  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createdAddress, setCreatedAddress] = useState<string | null>(null);

  const isSubmitting = status === "idle" && createdAddress === null && passphrase.length > 0
    ? false
    : status === "ready" && createdAddress !== null
      ? false
      : false; // createAccount is synchronous-ish via useCallback; status drives UI

  const canSubmit =
    passphrase.length >= 8 && passphrase === confirm && createdAddress === null;

  const handleSubmit = useCallback(async () => {
    setError(null);
    if (passphrase.length < 8) {
      setError("Passphrase must be at least 8 characters.");
      return;
    }
    if (passphrase !== confirm) {
      setError("Passphrases don't match.");
      return;
    }
    try {
      const account = await createAccount(passphrase);
      if (!account) {
        setError("Account creation failed — try again.");
        return;
      }
      setCreatedAddress(account.address);
      onSuccess(account.address);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [passphrase, confirm, createAccount, onSuccess]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="passkey-modal-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => { if (e.target === e.currentTarget && createdAddress === null) onClose(); }}
    >
      <div className="w-full max-w-md rounded-3xl bg-white dark:bg-[#0F0F10] border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 p-6 pb-4">
          <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
            <Fingerprint size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="passkey-modal-title"
              className="font-heading font-semibold text-[var(--text-primary)] text-lg"
            >
              {createdAddress ? "Smart Wallet Ready" : "Create Smart Wallet"}
            </h2>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5 leading-snug">
              {createdAddress
                ? "Your passkey-controlled smart account is ready to use."
                : `No wallet extension needed. Your passphrase encrypts a P-256 key stored on this device.`}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Cancel"
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] -mt-1 -mr-1 disabled:opacity-30"
          >
            <X size={18} />
          </button>
        </div>

        {/* Success state */}
        {createdAddress !== null && (
          <div className="px-6 pb-6 space-y-4">
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20">
              <CheckCircle2 size={20} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-emerald-900 dark:text-emerald-300">
                  Smart account created on {activeChain.name}
                </p>
                <p
                  className="text-xs font-mono text-emerald-700 dark:text-emerald-400/80 truncate"
                  data-testid="smart-account-address"
                >
                  {truncateAddress(createdAddress)}
                </p>
              </div>
            </div>
            <p
              className="text-xs text-[var(--text-tertiary)] text-center"
              data-testid="smart-account-status"
            >
              Counterfactual — deploys automatically on your first transaction.
            </p>
          </div>
        )}

        {/* Form */}
        {createdAddress === null && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit && !isSubmitting) handleSubmit();
            }}
            className="px-6 pb-6 space-y-3"
          >
            <label className="block">
              <span className="block text-xs text-[var(--text-secondary)] mb-1.5">
                Passphrase (min 8 characters)
              </span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Create a passphrase"
                autoFocus
                data-testid="passkey-passphrase-new"
                className="w-full h-12 px-4 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] border border-black/5 dark:border-white/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-[var(--text-secondary)] mb-1.5">
                Confirm passphrase
              </span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat passphrase"
                data-testid="passkey-passphrase-confirm"
                className="w-full h-12 px-4 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] border border-black/5 dark:border-white/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm"
              />
            </label>

            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30"
              >
                <AlertCircle size={16} className="text-red-600 dark:text-red-400 shrink-0" />
                <p className="text-xs text-red-700 dark:text-red-400">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit || isSubmitting}
              data-testid="passkey-create-submit"
              className="w-full h-12 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium hover:bg-black dark:hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isSubmitting && <Loader2 size={18} className="animate-spin" />}
              <span>Create Smart Wallet</span>
            </button>

            <p className="text-[11px] text-[var(--text-tertiary)] text-center pt-1 leading-relaxed">
              Your passphrase never leaves this browser. Lose it and you lose
              access — there's no recovery without a guardian setup.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
