import { forwardRef, useCallback, useRef, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

interface GradientSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Keyboard shortcut hint shown on the right (e.g. "⌘K", "/") */
  shortcutHint?: string;
  /** Called when the user presses Enter */
  onSubmit?: (value: string) => void;
  /** Disable the input */
  disabled?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────

export const GradientSearchBar = forwardRef<
  HTMLInputElement,
  GradientSearchBarProps
>(
  (
    {
      value,
      onChange,
      placeholder = "Search transactions, addresses...",
      className,
      shortcutHint,
      onSubmit,
      disabled = false,
    },
    ref
  ) => {
    const innerRef = useRef<HTMLInputElement>(null);
    const inputRef = (ref as React.RefObject<HTMLInputElement>) ?? innerRef;

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && onSubmit) {
          onSubmit(value);
        }
      },
      [onSubmit, value]
    );

    return (
      <div className={cn("relative group", className)}>
        {/* ── Gradient border glow ──
         * Sits behind the input, slightly larger (-inset-0.5).
         * The gap between this layer and the solid-bg input
         * creates the animated gradient "border" effect.
         */}
        <div
          className={cn(
            "absolute -inset-0.5 rounded-2xl blur-sm",
            "bg-gradient-to-r from-accent/30 via-white/10 to-encrypted/30",
            "opacity-40 transition-opacity duration-500",
            "group-hover:opacity-70",
            "group-focus-within:opacity-80 group-focus-within:animate-glow-breathe",
            disabled && "opacity-20 group-hover:opacity-20"
          )}
          aria-hidden="true"
        />

        {/* ── Input container ── */}
        <div
          className={cn(
            "relative flex items-center",
            "h-12 rounded-xl",
            "bg-void-inset",
            "ring-1 ring-white/[0.06]",
            "transition-all duration-200",
            "group-focus-within:ring-white/[0.10]",
            "group-focus-within:shadow-[0_0_0_1px_rgba(52,211,153,0.08),0_0_20px_rgba(52,211,153,0.04)]"
          )}
        >
          {/* ── Search icon ── */}
          <Search
            className={cn(
              "absolute left-3.5 w-4 h-4",
              "text-neutral-600 transition-colors duration-200",
              "group-focus-within:text-neutral-400"
            )}
            aria-hidden="true"
          />

          {/* ── Input ── */}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={placeholder}
            className={cn(
              "w-full h-full bg-transparent",
              "pl-10 pr-4 text-sm text-white",
              "font-mono tabular-nums",
              "placeholder:text-neutral-700",
              "focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              // Right padding to accommodate shortcut badge
              shortcutHint && "pr-14"
            )}
          />

          {/* ── Keyboard shortcut hint ── */}
          {shortcutHint && (
            <kbd
              className={cn(
                "absolute right-3 top-1/2 -translate-y-1/2",
                "inline-flex items-center justify-center",
                "h-6 min-w-[24px] px-1.5",
                "rounded-md border border-white/[0.08]",
                "bg-white/[0.04] text-neutral-600",
                "text-[11px] font-mono font-medium leading-none",
                "select-none pointer-events-none",
                "transition-colors duration-200",
                "group-focus-within:border-white/[0.12] group-focus-within:text-neutral-500"
              )}
            >
              {shortcutHint}
            </kbd>
          )}
        </div>
      </div>
    );
  }
);

GradientSearchBar.displayName = "GradientSearchBar";
