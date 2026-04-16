import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useConnect } from "wagmi";
import { Lock, Shield, Key, Sparkles, ArrowRight, Loader2, Fingerprint } from "lucide-react";
import { cn } from "@/lib/cn";
import { STORAGE_KEYS, getStoredString, setStoredString } from "@/lib/storage";
import { PasskeyCreationModal } from "@/components/PasskeyCreationModal";

// ─── Step data with gradient icon backgrounds ─────────────────────────

const steps = [
  {
    Icon: Sparkles,
    gradient: "from-purple-500 to-pink-500",
    heading: "Send money privately",
    subtitle: "Your payments are encrypted. Who you pay is visible \u2014 how much stays completely hidden.",
  },
  {
    Icon: Shield,
    gradient: "from-emerald-500 to-teal-500",
    heading: "Only you see the amounts",
    subtitle: "Your balances and transfers are encrypted on-chain. Not even the blockchain can read them.",
  },
  {
    Icon: Lock,
    gradient: "from-blue-500 to-cyan-500",
    heading: "Works everywhere you go",
    subtitle: "Built on Base network. Fast transactions, low fees, and military-grade encryption on every payment.",
  },
  {
    Icon: Key,
    gradient: "from-amber-500 to-orange-500",
    heading: "Your keys. Your money.",
    subtitle: "Non-custodial and self-sovereign. No company holds your funds. Complete financial privacy, always.",
  },
];

// ─── Component ────────────────────────────────────────────────────────

export default function Onboarding() {
  const { address } = useAccount();
  const [step, setStep] = useState(() => {
    // Per-address onboarding flag — users on a shared browser don't skip
    // each other's onboarding. Pre-connect (address = undefined), fall
    // back to step 0.
    if (!address) return 0;
    const seen = getStoredString(STORAGE_KEYS.onboardingComplete(address));
    return seen ? steps.length - 1 : 0;
  });

  // When the wallet connects after onboarding is complete, re-sync to last
  // step so a returning user isn't forced through the intro again.
  useEffect(() => {
    if (!address) return;
    const seen = getStoredString(STORAGE_KEYS.onboardingComplete(address));
    if (seen && step !== steps.length - 1) setStep(steps.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  useEffect(() => {
    if (step === steps.length - 1 && address) {
      setStoredString(STORAGE_KEYS.onboardingComplete(address), "true");
    }
  }, [step, address]);
  const { connectors, connect, isPending, error: connectError } = useConnect();
  // R5-A: passkey-first path — opens a modal that creates a BlankAccount
  // smart wallet from a passphrase-encrypted P-256 key. After success,
  // BlankApp's R5-C gate lets the user through to the Dashboard without
  // any wagmi EOA connection.
  const [passkeyModalOpen, setPasskeyModalOpen] = useState(false);

  const goNext = useCallback(() => {
    if (step < steps.length - 1) setStep(s => s + 1);
    else handleConnect();
  }, [step]);

  const goBack = useCallback(() => {
    if (step > 0) setStep(s => s - 1);
  }, [step]);

  const handleConnect = useCallback(() => {
    const connector = connectors[0];
    if (connector) connect({ connector });
  }, [connectors, connect]);

  const current = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <div className="blank-app min-h-dvh flex items-center justify-center px-4">
      {/* Subtle background gradient wash */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse at 30% 20%, rgba(139, 92, 246, 0.06) 0%, transparent 50%),
            radial-gradient(ellipse at 70% 80%, rgba(16, 185, 129, 0.04) 0%, transparent 50%)
          `,
        }}
      />

      {/* Card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-lg bg-white rounded-[2rem] shadow-2xl overflow-hidden"
      >
        <div className="p-10 sm:p-12">
          {/* Icon with spring animation */}
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0, rotate: 180 }}
              transition={{ type: "spring", bounce: 0.5, duration: 0.6 }}
              className={cn(
                "w-20 h-20 rounded-2xl bg-gradient-to-br flex items-center justify-center mb-8 mx-auto shadow-lg",
                current.gradient
              )}
            >
              <current.Icon size={40} className="text-white" strokeWidth={1.5} />
            </motion.div>
          </AnimatePresence>

          {/* Text with fade animation */}
          <AnimatePresence mode="wait">
            <motion.div
              key={`text-${step}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3, delay: 0.15 }}
              className="text-center"
            >
              <h2 className="text-2xl sm:text-3xl font-semibold text-gray-900 mb-4 tracking-tight" style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}>
                {current.heading}
              </h2>
              <p className="text-base sm:text-lg text-gray-500 leading-relaxed max-w-sm mx-auto">
                {current.subtitle}
              </p>
            </motion.div>
          </AnimatePresence>

          {/* Progress dots */}
          <div className="flex items-center justify-center gap-2 mt-10 mb-10">
            {steps.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setStep(idx)}
                className={cn(
                  "h-2 rounded-full transition-all duration-300",
                  idx === step
                    ? "w-8 bg-gray-900"
                    : "w-2 bg-gray-300 hover:bg-gray-400"
                )}
                aria-label={`Go to step ${idx + 1}`}
              />
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            {step > 0 && (
              <button
                onClick={goBack}
                className="flex-1 h-14 px-6 rounded-2xl bg-gray-100 text-gray-900 font-medium hover:bg-gray-200 transition-all active:scale-[0.98]"
              >
                Back
              </button>
            )}
            {!isLast && (
              <button
                onClick={goNext}
                className="flex-1 h-14 px-6 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <span>Next</span>
                <ArrowRight size={18} strokeWidth={2} />
              </button>
            )}
          </div>

          {/* Wallet selector on last step */}
          {isLast && (
            <div className="space-y-3">
              {/* R5-A: passkey-first path. Shown prominently so users can
                  onboard without installing anything. */}
              <button
                onClick={() => setPasskeyModalOpen(true)}
                data-testid="onboarding-passkey-cta"
                className="w-full h-14 px-6 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-all active:scale-[0.98] flex items-center justify-center gap-3"
              >
                <Fingerprint size={20} strokeWidth={2} />
                <span>Continue with Passkey</span>
              </button>

              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-gray-200" />
                <span className="text-[11px] uppercase tracking-wider text-gray-400">or</span>
                <div className="h-px flex-1 bg-gray-200" />
              </div>

              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  onClick={() => connect({ connector })}
                  disabled={isPending}
                  className="w-full h-14 px-6 rounded-2xl bg-white text-gray-900 border border-gray-200 font-medium hover:bg-gray-50 transition-all active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50"
                >
                  {isPending ? (
                    <Loader2 size={20} className="animate-spin" />
                  ) : null}
                  <span>Connect {connector.name}</span>
                </button>
              ))}
              {connectError && (
                <p className="text-sm text-red-500 text-center">{connectError.message}</p>
              )}
              <p className="text-xs text-center text-gray-400 mt-2">
                Don&apos;t have a wallet?{" "}
                <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer" className="text-[#6366F1] hover:underline">
                  Install MetaMask
                </a>
              </p>
            </div>
          )}
        </div>
      </motion.div>

      {/* R5-A: passkey creation modal. On success, the smart account is
          persisted in IndexedDB; BlankApp's R5-C gate unlocks the app. */}
      <PasskeyCreationModal
        open={passkeyModalOpen}
        onClose={() => setPasskeyModalOpen(false)}
        onSuccess={() => {
          // Modal stays open briefly to show the success state; its own
          // X button closes it, at which point hasPasskey()=true drives
          // BlankApp to render the main shell.
        }}
      />
    </div>
  );
}
