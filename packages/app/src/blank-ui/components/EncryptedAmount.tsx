import { useState, useCallback, useRef, useEffect } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

interface EncryptedAmountProps {
  value?: bigint | number | null;
  decimals?: number;
  symbol?: string;
  size?: "sm" | "md" | "lg" | "hero";
  prefix?: "+" | "-" | "";
  showToggle?: boolean;
  className?: string;
}

const sizeClasses: Record<string, string> = {
  sm: "text-sm",
  md: "text-lg",
  lg: "text-2xl",
  hero: "text-display-hero",
};

function formatAmount(value: bigint | number, decimals: number): string {
  const num =
    typeof value === "bigint" ? Number(value) / 10 ** decimals : value;
  if (num < 0.01 && num > 0) return num.toFixed(6);
  if (num < 1) return num.toFixed(4);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

export function EncryptedAmount({
  value,
  decimals = 6,
  symbol: _symbol = "USDC",
  size = "md",
  prefix = "",
  showToggle = true,
  className,
}: EncryptedAmountProps) {
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const toggleReveal = useCallback(() => {
    if (value === null || value === undefined) return;
    setRevealed((prev) => {
      if (!prev) {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setRevealed(false), 10_000);
      }
      return !prev;
    });
  }, [value]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const hasValue = value !== null && value !== undefined;
  const formatted = hasValue ? formatAmount(value, decimals) : null;
  const prefixColor =
    prefix === "+"
      ? "text-[var(--money)]"
      : prefix === "-"
        ? "text-[var(--text-secondary)]"
        : "";

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className={cn(
          "text-mono",
          sizeClasses[size],
          revealed && hasValue
            ? prefixColor || "text-[var(--text-primary)]"
            : "text-[var(--text-tertiary)]",
        )}
      >
        {revealed && formatted
          ? `${prefix}$${formatted}`
          : `${prefix}$*****`}
      </span>
      {showToggle && hasValue && (
        <button
          onClick={toggleReveal}
          className="p-1 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
          aria-label={revealed ? "Hide amount" : "Reveal amount"}
        >
          {revealed ? (
            <EyeOff size={16} className="text-[var(--text-tertiary)]" />
          ) : (
            <Eye size={16} className="text-[var(--text-tertiary)]" />
          )}
        </button>
      )}
    </span>
  );
}
