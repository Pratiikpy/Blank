import { motion, AnimatePresence } from "framer-motion";
import { Check, Lock, ShieldCheck, Send, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface StepProgressBarProps {
  currentStep: number; // 0 = encrypt, 1 = confirm, 2 = send
  className?: string;
}

interface StepDef {
  label: string;
  icon: LucideIcon;
}

const steps: StepDef[] = [
  { label: "Encrypt", icon: Lock },
  { label: "Confirm", icon: ShieldCheck },
  { label: "Send", icon: Send },
];

function StepBadge({
  step,
  index,
  currentStep,
}: {
  step: StepDef;
  index: number;
  currentStep: number;
}) {
  const isCompleted = index < currentStep;
  const isActive = index === currentStep;

  return (
    <div className="flex flex-col items-center gap-0">
      <div className="relative">
        {/* Pulsing glow ring behind active badge */}
        {isActive && (
          <motion.div
            className="absolute -inset-1 rounded-full"
            animate={{
              boxShadow: [
                "0 0 8px rgba(52,211,153,0.15)",
                "0 0 16px rgba(52,211,153,0.3)",
                "0 0 8px rgba(52,211,153,0.15)",
              ],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        )}

        <motion.div
          layout
          initial={false}
          animate={
            isActive
              ? { scale: [0.8, 1.1, 1.0] }
              : isCompleted
              ? { scale: 1 }
              : { scale: 1 }
          }
          transition={
            isActive
              ? { type: "spring", stiffness: 400, damping: 15, mass: 0.8 }
              : { type: "spring", stiffness: 300, damping: 20 }
          }
          className={cn(
            "relative z-10 w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold transition-colors duration-300",
            isCompleted &&
              "bg-accent text-void shadow-[0_0_12px_rgba(52,211,153,0.4)]",
            isActive &&
              "border-2 border-accent bg-accent/10 text-accent",
            !isCompleted &&
              !isActive &&
              "border border-white/[0.08] bg-white/[0.03] text-neutral-600"
          )}
        >
          <AnimatePresence mode="wait">
            {isCompleted ? (
              <motion.div
                key="check"
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{
                  type: "spring",
                  stiffness: 500,
                  damping: 15,
                  mass: 0.6,
                }}
              >
                <Check className="w-5 h-5" strokeWidth={3} />
              </motion.div>
            ) : (
              <motion.span
                key="number"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                {index + 1}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      {/* Label + icon below badge */}
      <div className="flex items-center gap-1 mt-2">
        <step.icon
          className={cn(
            "w-3 h-3",
            isCompleted || isActive ? "text-white" : "text-neutral-600"
          )}
        />
        <span
          className={cn(
            "text-[10px] uppercase tracking-[0.15em]",
            isCompleted || isActive
              ? "text-white font-medium"
              : "text-neutral-600"
          )}
        >
          {step.label}
        </span>
      </div>
    </div>
  );
}

function ConnectingLine({
  index,
  currentStep,
}: {
  index: number;
  currentStep: number;
}) {
  const isCompleted = index < currentStep;
  const isActive = index === currentStep;

  return (
    <div className="flex-1 h-0.5 relative self-start mt-5 mx-1">
      {/* Background track */}
      <div className="absolute inset-0 rounded-full bg-white/[0.06]" />

      {/* Filled portion */}
      {isCompleted && (
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          initial={{ width: "0%" }}
          animate={{ width: "100%" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      )}

      {isActive && (
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            background:
              "linear-gradient(to right, rgb(52 211 153), rgba(255 255 255 / 0.08))",
          }}
          initial={{ width: "0%" }}
          animate={{ width: "50%" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      )}
    </div>
  );
}

export function StepProgressBar({
  currentStep,
  className,
}: StepProgressBarProps) {
  return (
    <div
      className={cn("flex items-start w-full", className)}
      role="status"
      aria-live="polite"
      aria-label={`Payment step ${currentStep + 1} of ${steps.length}: ${steps[Math.min(currentStep, steps.length - 1)].label}`}
    >
      {steps.map((step, index) => (
        <div
          key={step.label}
          className={cn(
            "flex items-start",
            index < steps.length - 1 ? "flex-1" : ""
          )}
          aria-current={index === currentStep ? "step" : undefined}
        >
          <StepBadge step={step} index={index} currentStep={currentStep} />

          {index < steps.length - 1 && (
            <ConnectingLine index={index} currentStep={currentStep} />
          )}
        </div>
      ))}
    </div>
  );
}
