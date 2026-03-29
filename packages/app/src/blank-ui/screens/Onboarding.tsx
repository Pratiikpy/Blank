import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useConnect } from "wagmi";
import { Lock, Shield, Key, Sparkles, ArrowRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

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
  const [step, setStep] = useState(() => {
    const seen = typeof window !== "undefined" && localStorage.getItem("blank_onboarding_seen");
    return seen ? steps.length - 1 : 0;
  });

  useEffect(() => {
    if (step === steps.length - 1) {
      localStorage.setItem("blank_onboarding_seen", "true");
    }
  }, [step]);
  const { connectors, connect, isPending, error: connectError } = useConnect();

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
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  onClick={() => connect({ connector })}
                  disabled={isPending}
                  className="w-full h-14 px-6 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-all active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50"
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
    </div>
  );
}
