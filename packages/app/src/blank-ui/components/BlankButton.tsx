import { forwardRef } from "react";
import { cn } from "@/lib/cn";

interface BlankButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg" | "full";
  loading?: boolean;
  icon?: React.ReactNode;
}

export const BlankButton = forwardRef<HTMLButtonElement, BlankButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading,
      icon,
      className,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const baseClass =
      variant === "primary"
        ? "btn-primary"
        : variant === "secondary"
          ? "btn-secondary"
          : "btn-ghost";

    const sizeClass =
      size === "full"
        ? "!w-full !rounded-2xl !h-14 !text-base"
        : size === "lg"
          ? "!h-14 !rounded-2xl !text-base"
          : size === "sm"
            ? "!h-10 !text-sm !px-4"
            : "";

    return (
      <button
        ref={ref}
        className={cn(
          baseClass,
          sizeClass,
          loading && "opacity-70 pointer-events-none",
          className,
        )}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        ) : (
          icon
        )}
        {children}
      </button>
    );
  },
);

BlankButton.displayName = "BlankButton";
