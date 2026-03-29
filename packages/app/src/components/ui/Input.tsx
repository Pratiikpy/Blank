import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  rightElement?: React.ReactNode;
  /** Use JetBrains Mono and right-align for financial amounts */
  isAmount?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, rightElement, isAmount, className, id, ...props }, ref) => {
    const reactId = useId();
    const inputId = id || `input-${label?.replace(/\s/g, "-").toLowerCase() || "field"}-${reactId}`;

    return (
      <div className="w-full">
        {/* ── Label ── */}
        {label && (
          <label
            htmlFor={inputId}
            className={cn(
              "block mb-2 text-[11px] font-semibold uppercase tracking-[0.12em]",
              "text-neutral-500 transition-colors duration-200",
              // Label brightens when sibling input is focused (via group)
              "group-focus-within:text-neutral-300"
            )}
          >
            {label}
          </label>
        )}

        {/* ── Input wrapper with bottom glow line ── */}
        <div className="input-glow group relative">
          <input
            ref={ref}
            id={inputId}
            className={cn(
              // Size + base text
              "w-full h-12 px-4 text-sm text-white placeholder:text-neutral-500",
              // Background: gradient top-to-bottom (matches glass panels)
              "bg-gradient-to-b from-white/[0.04] to-white/[0.02]",
              // Border + bevel ring
              "border border-white/[0.08] rounded-xl",
              "ring-1 ring-inset ring-white/[0.04]",
              // Smooth transition on all interactive properties
              "transition-all duration-200 ease-out",
              // Hover: border brightens, bg lifts
              "hover:border-white/[0.14] hover:from-white/[0.05] hover:to-white/[0.025]",
              // Focus: accent-tinted border, stronger ring, bg shift
              "focus:border-accent/40 focus:ring-accent/15 focus:from-white/[0.05] focus:to-white/[0.02]",
              "focus:outline-none",
              // Shadow on focus: subtle accent glow
              "focus:shadow-[0_0_0_1px_rgba(16,185,129,0.1),0_0_16px_rgba(16,185,129,0.06)]",
              // Error state overrides
              error && [
                "border-red-500/40 ring-red-500/15",
                "focus:border-red-500/50 focus:ring-red-500/20",
                "focus:shadow-[0_0_0_1px_rgba(239,68,68,0.1),0_0_16px_rgba(239,68,68,0.06)]",
              ].join(" "),
              // Amount mode: mono font, right-aligned, larger
              isAmount && "font-mono text-2xl tabular-nums text-right tracking-tight h-14",
              // Space for right element
              rightElement && "pr-12",
              className
            )}
            aria-invalid={!!error}
            aria-describedby={
              error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
            }
            {...props}
          />

          {/* ── Right element (icon, token badge, etc.) ── */}
          {rightElement && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500">
              {rightElement}
            </div>
          )}
        </div>

        {/* ── Error message with icon ── */}
        {error && (
          <p
            id={`${inputId}-error`}
            className="flex items-center gap-1.5 mt-2 text-xs text-red-400"
            role="alert"
          >
            <AlertCircle className="h-3 w-3 shrink-0" />
            {error}
          </p>
        )}

        {/* ── Hint text ── */}
        {hint && !error && (
          <p
            id={`${inputId}-hint`}
            className="mt-2 text-xs text-neutral-500"
          >
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
