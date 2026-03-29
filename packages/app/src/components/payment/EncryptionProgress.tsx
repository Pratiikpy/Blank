import { motion, AnimatePresence } from "framer-motion";
import { Lock, Cpu, ShieldCheck, Send } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";

interface EncryptionProgressProps {
  progress: number; // 0-100
}

const steps = [
  { label: "Encrypting", icon: Lock, threshold: 0 },
  { label: "ZK Proof", icon: Cpu, threshold: 33 },
  { label: "Verifying", icon: ShieldCheck, threshold: 66 },
  { label: "Ready", icon: Send, threshold: 100 },
];

// SVG ring constants
const RING_SIZE = 140;
const RING_CENTER = RING_SIZE / 2;
const RING_RADIUS = 58;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_STROKE = 5;

export function EncryptionProgress({ progress }: EncryptionProgressProps) {
  const activeStepIndex = steps.findIndex((_, i) => {
    const next = steps[i + 1];
    return !next || progress < next.threshold;
  });

  const strokeDashoffset =
    RING_CIRCUMFERENCE - (progress / 100) * RING_CIRCUMFERENCE;

  return (
    <GlassCard variant="elevated" className="text-center">
      {/* Circular progress ring with lock center */}
      <div className="relative mx-auto mb-6" style={{ width: RING_SIZE, height: RING_SIZE }}>
        {/* SVG ring */}
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          className="absolute inset-0 -rotate-90"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#8b5cf6" />
              <stop offset="100%" stopColor="#10b981" />
            </linearGradient>
          </defs>

          {/* Background track */}
          <circle
            cx={RING_CENTER}
            cy={RING_CENTER}
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(255, 255, 255, 0.06)"
            strokeWidth={RING_STROKE}
          />

          {/* Animated progress arc */}
          <motion.circle
            cx={RING_CENTER}
            cy={RING_CENTER}
            r={RING_RADIUS}
            fill="none"
            stroke="url(#ring-gradient)"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            initial={{ strokeDashoffset: RING_CIRCUMFERENCE }}
            animate={{ strokeDashoffset }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </svg>

        {/* Glow behind the ring when progressing */}
        <motion.div
          className="absolute inset-0 rounded-full"
          animate={{
            boxShadow:
              progress > 0
                ? [
                    "0 0 20px rgba(139, 92, 246, 0.08), 0 0 40px rgba(16, 185, 129, 0.05)",
                    "0 0 30px rgba(139, 92, 246, 0.15), 0 0 60px rgba(16, 185, 129, 0.10)",
                    "0 0 20px rgba(139, 92, 246, 0.08), 0 0 40px rgba(16, 185, 129, 0.05)",
                  ]
                : "0 0 0px transparent",
          }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Center lock icon */}
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.div
            animate={
              progress < 100
                ? { rotate: [0, -4, 4, -3, 3, 0] }
                : { rotate: 0 }
            }
            transition={
              progress < 100
                ? { duration: 0.5, repeat: Infinity, repeatDelay: 1.2, ease: "easeInOut" }
                : { duration: 0.3 }
            }
            className="w-14 h-14 rounded-2xl bg-encrypted/10 border border-encrypted/20 flex items-center justify-center"
          >
            <Lock className="w-7 h-7 text-encrypted" />
          </motion.div>
        </div>
      </div>

      {/* Title */}
      <h3 className="text-heading font-semibold mb-1 text-white">Encrypting Payment</h3>
      <p className="text-body text-neutral-500 mb-8">
        Your amount is being encrypted with FHE
      </p>

      {/* Step dots + animated label */}
      <div className="flex flex-col items-center gap-4">
        {/* 4 step dots */}
        <div className="flex items-center gap-3">
          {steps.map((step, i) => {
            const isActive = i === activeStepIndex;
            const isComplete = i < activeStepIndex;

            return (
              <div key={step.label} className="flex items-center gap-3">
                <motion.div
                  className="relative"
                  animate={isActive ? { scale: [1, 1.2, 1] } : { scale: 1 }}
                  transition={isActive ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" } : {}}
                >
                  {/* Active ring pulse */}
                  {isActive && (
                    <motion.div
                      className="absolute -inset-1.5 rounded-full border border-encrypted/30"
                      animate={{ scale: [1, 1.4], opacity: [0.5, 0] }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
                    />
                  )}

                  <div
                    className={`w-3 h-3 rounded-full transition-all duration-500 ${
                      isComplete
                        ? "bg-accent shadow-[0_0_8px_rgba(16,185,129,0.4)]"
                        : isActive
                        ? "bg-encrypted shadow-[0_0_8px_rgba(139,92,246,0.4)]"
                        : "bg-white/10"
                    }`}
                  />
                </motion.div>

                {/* Connector line (except after last dot) */}
                {i < steps.length - 1 && (
                  <div className="relative w-8 h-px">
                    <div className="absolute inset-0 bg-white/10 rounded-full" />
                    {isComplete && (
                      <motion.div
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-accent to-encrypted rounded-full"
                        initial={{ width: "0%" }}
                        animate={{ width: "100%" }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Animated step label */}
        <div className="h-6 flex items-center justify-center">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeStepIndex}
              initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-2"
            >
              {(() => {
                const step = steps[activeStepIndex];
                const Icon = step.icon;
                return (
                  <>
                    <Icon
                      className={`w-3.5 h-3.5 ${
                        activeStepIndex === steps.length - 1
                          ? "text-accent"
                          : "text-encrypted"
                      }`}
                    />
                    <span
                      className={`text-caption font-medium tracking-wider uppercase ${
                        activeStepIndex === steps.length - 1
                          ? "text-accent"
                          : "text-encrypted"
                      }`}
                    >
                      {step.label}
                    </span>
                  </>
                );
              })()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </GlassCard>
  );
}
