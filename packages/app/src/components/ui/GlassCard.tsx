import { motion, type HTMLMotionProps } from "framer-motion";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

type Variant = "default" | "elevated" | "outlined" | "interactive" | "heavy";

interface GlassCardProps extends HTMLMotionProps<"div"> {
  variant?: Variant;
  noPadding?: boolean;
  highlight?: boolean;
}

const variantStyles: Record<Variant, string> = {
  default: [
    "backdrop-blur-2xl rounded-2xl",
    "border border-white/[0.06]",
    "bg-gradient-to-br from-white/[0.05] to-white/[0.01]",
    "shadow-[0_2px_4px_rgba(0,0,0,0.3),0_8px_20px_-4px_rgba(0,0,0,0.4),0_20px_50px_-12px_rgba(0,0,0,0.5)]",
    "transition-shadow duration-300",
    "hover:shadow-[0_4px_8px_rgba(0,0,0,0.4),0_12px_28px_-4px_rgba(0,0,0,0.5),0_24px_56px_-12px_rgba(0,0,0,0.55)]",
  ].join(" "),

  elevated: [
    "backdrop-blur-3xl rounded-2xl",
    "border border-white/[0.08]",
    "bg-gradient-to-br from-white/[0.05] to-white/[0.015]",
    "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_30px_70px_-15px_rgba(0,0,0,0.6)]",
  ].join(" "),

  outlined: [
    "bg-transparent backdrop-blur-xl",
    "border border-white/[0.04] rounded-2xl",
  ].join(" "),

  interactive: [
    "backdrop-blur-2xl rounded-2xl",
    "border border-white/[0.04]",
    "bg-gradient-to-br from-white/[0.025] to-white/[0.008]",
    "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_20px_50px_-12px_rgba(0,0,0,0.4)]",
    "transition-all duration-300 cursor-pointer",
    "hover:border-white/[0.14]",
    "hover:from-white/[0.04] hover:to-white/[0.015]",
    "hover:shadow-[0_0_24px_rgba(52,211,153,0.06)]",
  ].join(" "),

  heavy: [
    "bg-[#060608]/85 backdrop-blur-2xl rounded-2xl",
    "border border-white/[0.08]",
    "shadow-[0_20px_50px_-12px_rgba(0,0,0,0.6)]",
  ].join(" "),
};

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ variant = "default", noPadding = false, highlight = false, className, children, ...props }, ref) => {
    return (
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          "group relative overflow-hidden",
          variantStyles[variant],
          highlight && "glass-highlight",
          !noPadding && "p-5 sm:p-6",
          className
        )}
        {...props}
      >
        {/* Content */}
        <div className="relative z-[1]">{children as React.ReactNode}</div>
      </motion.div>
    );
  }
);

GlassCard.displayName = "GlassCard";
