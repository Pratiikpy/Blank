import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";

// ─── Constants ──────────────────────────────────────────────────────

const ENCRYPTED_PLACEHOLDER = "\u2588\u2588\u2588\u2588.\u2588\u2588"; // ████.██

// ─── Types ──────────────────────────────────────────────────────────

interface AmountDisplayProps {
  /** The raw amount string, e.g. "42.50" or "" */
  amount: string;
  /** Token symbol shown beside the encrypted indicator (default: "USDC") */
  token?: string;
  className?: string;
}

// ─── Spring for digit pop-in ────────────────────────────────────────

const digitSpring = {
  type: "spring" as const,
  stiffness: 400,
  damping: 22,
};

// ─── Component ──────────────────────────────────────────────────────

export function AmountDisplay({
  amount,
  token = "USDC",
  className,
}: AmountDisplayProps) {
  const isEmpty = amount === "" || amount === "0";
  const displayValue = isEmpty ? "0" : amount;

  // Split into individual characters for staggered animation.
  // Each character gets a unique key based on its position and value
  // so React/Framer can animate additions and removals.
  const characters = useMemo(() => {
    return displayValue.split("").map((char, i) => ({
      id: `${i}-${char}`,
      char,
    }));
  }, [displayValue]);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3",
        className
      )}
      aria-live="polite"
      aria-label={isEmpty ? "No amount entered" : `${amount} dollars`}
    >
      {/* ── Main amount display ── */}
      <div className="flex items-baseline justify-center min-h-[4.5rem]">
        {/* Dollar sign prefix */}
        <span
          className={cn(
            "font-mono text-5xl font-bold tracking-tight transition-colors duration-200",
            isEmpty ? "text-neutral-700" : "text-neutral-500"
          )}
        >
          $
        </span>

        {/* Animated digits */}
        <div className="flex items-baseline overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            {characters.map(({ id, char }) => (
              <motion.span
                key={id}
                layout
                initial={{ opacity: 0, scale: 0.6, y: 8, filter: "blur(4px)" }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  y: 0,
                  filter: "blur(0px)",
                  transition: digitSpring,
                }}
                exit={{
                  opacity: 0,
                  scale: 0.6,
                  y: -8,
                  filter: "blur(4px)",
                  transition: { duration: 0.15 },
                }}
                className={cn(
                  "inline-block font-mono text-6xl font-bold tabular-nums tracking-tight",
                  isEmpty ? "text-neutral-700" : "text-white"
                )}
              >
                {char}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Encrypted equivalent indicator ── */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.3 }}
        className="flex items-center gap-2"
      >
        <span className="font-mono text-sm tracking-wide text-encrypted-400/70">
          = {ENCRYPTED_PLACEHOLDER}
        </span>
        <span className="text-sm text-encrypted-400/50">
          encrypted {token}
        </span>
      </motion.div>
    </div>
  );
}
