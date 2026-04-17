import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from "framer-motion";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";

// ─── Constants ──────────────────────────────────────────────────────

const ENCRYPTED_PLACEHOLDER = "\u2022\u2022\u2022\u2022.\u2022\u2022"; // ████.██
const REVEAL_TIMEOUT_MS = 10_000;
const SCRAMBLE_CHARS = "0123456789$.,#%&!@*";
const SCRAMBLE_DURATION = 350;
const SCRAMBLE_INTERVAL = 25;

// ─── Scramble hook ──────────────────────────────────────────────────

function useScrambleText(target: string, active: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!active) {
      setDisplay(target);
      return;
    }

    const startTime = Date.now();
    const length = target.length;

    frameRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / SCRAMBLE_DURATION, 1);
      // Characters settle left-to-right
      const settledCount = Math.floor(progress * length);
      let result = "";

      for (let i = 0; i < length; i++) {
        if (i < settledCount) {
          result += target[i];
        } else if (target[i] === "." || target[i] === "," || target[i] === "$") {
          // Keep punctuation stable during scramble for readability
          result += target[i];
        } else {
          result += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        }
      }

      setDisplay(result);

      if (progress >= 1) {
        clearInterval(frameRef.current);
        setDisplay(target);
      }
    }, SCRAMBLE_INTERVAL);

    return () => clearInterval(frameRef.current);
  }, [target, active]);

  return display;
}

// ─── Countdown ring ─────────────────────────────────────────────────

function CountdownRing({ durationMs, size = 14 }: { durationMs: number; size?: number }) {
  const progress = useMotionValue(1);
  const circumference = (size - 2) * Math.PI;
  const strokeDashoffset = useTransform(progress, (v) => circumference * (1 - v));

  useEffect(() => {
    const controls = animate(progress, 0, {
      duration: durationMs / 1000,
      ease: "linear",
    });
    return () => controls.stop();
  }, [progress, durationMs]);

  return (
    <svg width={size} height={size} className="rotate-[-90deg]" aria-hidden="true">
      {/* Track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={(size - 2) / 2}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={1.5}
      />
      {/* Progress — uses accent-400 (#34d399) */}
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={(size - 2) / 2}
        fill="none"
        stroke="rgba(52, 211, 153, 0.5)"
        strokeWidth={1.5}
        strokeDasharray={circumference}
        style={{ strokeDashoffset }}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── Size styles ────────────────────────────────────────────────────

const sizeStyles = {
  sm: "text-sm",
  md: "text-lg",
  lg: "text-2xl",
  xl: "text-mono-display font-bold tracking-tight",
} as const;

const iconSizes = {
  sm: "h-3 w-3",
  md: "h-3.5 w-3.5",
  lg: "h-4 w-4",
  xl: "h-5 w-5",
} as const;

// ─── Component ──────────────────────────────────────────────────────

interface EncryptedAmountProps {
  value?: number | bigint | null;
  decimals?: number;
  symbol?: string;
  isLoading?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  showToggle?: boolean;
  className?: string;
}

export function EncryptedAmount({
  value,
  decimals = 6,
  symbol = "USDC",
  isLoading = false,
  size = "md",
  showToggle = true,
  className,
}: EncryptedAmountProps) {
  const [revealed, setRevealed] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const formattedValue = useMemo(() => {
    if (value == null) return null;
    return (Number(value) / 10 ** decimals).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }, [value, decimals]);

  const displayTarget = revealed && formattedValue ? `$${formattedValue}` : "";
  const scrambledText = useScrambleText(displayTarget, scrambling);

  const toggleReveal = useCallback(() => {
    if (!formattedValue) return;

    setRevealed((prev) => {
      if (!prev) {
        setScrambling(true);
        setTimeout(() => setScrambling(false), SCRAMBLE_DURATION + 50);

        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setRevealed(false), REVEAL_TIMEOUT_MS);
      }
      return !prev;
    });
  }, [formattedValue]);

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  // ── Loading: shimmer skeleton matching the exact size ──
  if (isLoading) {
    return (
      <div
        className={cn("shimmer rounded", sizeStyles[size], className)}
        style={{ width: "8ch", height: "1.2em" }}
        role="status"
        aria-label="Loading encrypted amount"
      >
        <span className="sr-only">Loading...</span>
      </div>
    );
  }

  return (
    <button
      onClick={toggleReveal}
      className={cn(
        "inline-flex items-center gap-2 group rounded-lg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-void",
        "transition-colors duration-150",
        showToggle && formattedValue && "cursor-pointer hover:bg-white/[0.03] px-2 py-1 -mx-2 -my-1",
        !showToggle && "cursor-default",
        className
      )}
      aria-label={
        revealed ? `${formattedValue} ${symbol}` : "Encrypted amount, tap to reveal"
      }
      type="button"
    >
      <AnimatePresence mode="wait">
        {revealed && formattedValue ? (
          <motion.span
            key="revealed"
            initial={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
            animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
            exit={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
            transition={{
              duration: 0.25,
              ease: [0.22, 1, 0.36, 1],
            }}
            className={cn(
              "font-mono font-semibold tabular-nums",
              sizeStyles[size]
            )}
          >
            {scrambling ? (
              <span className="text-accent-400/70">{scrambledText}</span>
            ) : (
              <span className="revealed-text">
                ${formattedValue}
              </span>
            )}
          </motion.span>
        ) : (
          <motion.span
            key="encrypted"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={cn(
              "encrypted-text",
              sizeStyles[size]
            )}
          >
            {ENCRYPTED_PLACEHOLDER}
          </motion.span>
        )}
      </AnimatePresence>

      {/* ── Countdown ring while revealed ── */}
      {revealed && formattedValue && (
        <motion.span
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0 }}
          className="shrink-0"
        >
          <CountdownRing durationMs={REVEAL_TIMEOUT_MS} size={size === "xl" ? 18 : 14} />
        </motion.span>
      )}

      {/* ── Eye toggle icon ── */}
      {showToggle && formattedValue && !revealed && (
        <motion.span
          className="text-text-muted group-hover:text-text-tertiary transition-colors duration-150"
          whileTap={{ scale: 0.85 }}
        >
          <Eye className={iconSizes[size]} />
        </motion.span>
      )}

      {revealed && formattedValue && (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-text-muted group-hover:text-text-tertiary transition-colors duration-150"
          whileTap={{ scale: 0.85 }}
        >
          <EyeOff className={iconSizes[size]} />
        </motion.span>
      )}

      {/* ── Lock icon when no value ── */}
      {!formattedValue && (
        <ShieldCheck className={cn(iconSizes[size], "text-encrypted-400/40")} />
      )}
    </button>
  );
}
