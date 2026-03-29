import { motion, type HTMLMotionProps } from "framer-motion";
import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends HTMLMotionProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

// ─── Variant class strings ──────────────────────────────────────────
// Each variant has: base + hover + active classes.
// Primary gets the "glow lift" effect. Others use border/bg shifts.

const variantStyles: Record<ButtonVariant, string> = {
  primary: [
    // Base: gradient 400->500, inverse text, 3-layer glow
    "btn-accent-glow font-semibold",
    // Inset highlight for depth
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]",
    // Glow intensification on hover
    "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_0_24px_rgba(52,211,153,0.25)]",
    // Overflow hidden for shine sweep + group for group-hover
    "overflow-hidden group",
  ].join(" "),

  secondary: [
    "bg-white/[0.06] text-white border border-white/[0.08]",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
    "hover:bg-white/[0.10] hover:border-white/[0.15]",
    "hover:shadow-[0_0_0_1px_rgba(255,255,255,0.1),inset_0_1px_0_rgba(255,255,255,0.08)]",
    "active:bg-white/[0.08] active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)]",
  ].join(" "),

  outline: [
    "bg-transparent border border-white/[0.10] text-text-secondary",
    "hover:border-white/[0.18] hover:text-text-primary hover:bg-white/[0.03]",
    "active:bg-white/[0.02] active:border-white/[0.12]",
  ].join(" "),

  ghost: [
    "bg-transparent text-text-secondary",
    "hover:text-text-primary hover:bg-white/[0.05]",
    "active:bg-white/[0.03]",
  ].join(" "),

  danger: [
    "bg-error/10 text-error border border-error/20",
    "shadow-[inset_0_1px_0_rgba(248,113,113,0.06)]",
    "hover:bg-error/[0.18] hover:border-error/30",
    "hover:shadow-[0_0_20px_rgba(248,113,113,0.1),inset_0_1px_0_rgba(248,113,113,0.08)]",
    "active:bg-error/[0.12] active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)]",
  ].join(" "),
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-6 text-[15px] font-semibold gap-2.5 rounded-xl",
};

// ─── Spring physics ─────────────────────────────────────────────────
// Stiffness 400 + damping 12 = bouncy snap with noticeable overshoot.
// Lower damping = more bounce, like cubic-bezier(0.34, 1.56, 0.64, 1).

const hoverSpring = {
  type: "spring" as const,
  stiffness: 400,
  damping: 20,
};

const tapSpring = {
  type: "spring" as const,
  stiffness: 500,
  damping: 20,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      icon,
      className,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    return (
      <motion.button
        ref={ref}
        // ── Hover: lift up slightly + expand ──
        whileHover={
          isDisabled
            ? undefined
            : {
                scale: 1.02,
                y: -1,
                transition: hoverSpring,
              }
        }
        // ── Tap: press into surface + shrink ──
        whileTap={
          isDisabled
            ? undefined
            : {
                scale: 0.97,
                y: 1,
                transition: tapSpring,
              }
        }
        className={cn(
          // Base: flex layout, font, transitions
          "relative inline-flex items-center justify-center font-medium",
          "transition-[background,border-color,color,box-shadow,filter] duration-200 ease-out",
          // Focus ring: visible for keyboard, offset from bg
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-void",
          // Variant + size
          variantStyles[variant],
          sizeStyles[size],
          // Loading: slightly faded but distinct from fully disabled
          loading && !disabled && "opacity-60 cursor-not-allowed pointer-events-none",
          // Disabled: more faded, no pointer events
          disabled && !loading && "opacity-40 cursor-not-allowed pointer-events-none saturate-0 brightness-75",
          // Both loading and disabled
          loading && disabled && "opacity-40 cursor-not-allowed pointer-events-none saturate-0 brightness-75",
          className
        )}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        {...props}
      >
        {/* ── Shine sweep (primary only) ── */}
        {variant === "primary" && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 z-[1] skew-x-12",
              "translate-x-[-100%] transition-transform duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
              "group-hover:translate-x-[200%]"
            )}
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent)",
            }}
          />
        )}

        {/* ── Spinner overlay ── */}
        {loading && (
          <motion.span
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
          </motion.span>
        )}

        {/* ── Content: invisible while loading to hold size ── */}
        <span
          className={cn(
            "inline-flex items-center justify-center gap-inherit",
            loading && "invisible"
          )}
        >
          {icon && <span className="shrink-0">{icon}</span>}
          {children as React.ReactNode}
        </span>
      </motion.button>
    );
  }
);

Button.displayName = "Button";
