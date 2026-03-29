import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

interface GradientAvatarProps {
  /** Ethereum address -- used to deterministically generate the gradient */
  address: string;
  /** If provided, show first letter as the initial */
  name?: string;
  /** 32px, 40px, or 64px */
  size?: "sm" | "md" | "lg";
  className?: string;
}

// ─── Size map ───────────────────────────────────────────────────────

const sizeStyles = {
  sm: "w-8 h-8 text-xs",
  md: "w-10 h-10 text-sm",
  lg: "w-16 h-16 text-lg",
} as const;

// ─── Gradient generation ────────────────────────────────────────────

/**
 * Derives two hue values from the first 4 hex characters of the address
 * (after the 0x prefix). The same address always produces the same pair,
 * giving every user a unique but stable visual identity.
 */
function addressToGradient(address: string): string {
  const hex = address.slice(2, 6);
  const hue1 = parseInt(hex, 16) % 360;
  const hue2 = (hue1 + 40) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 70%, 50%), hsl(${hue2}, 70%, 40%))`;
}

/**
 * Returns the display initial(s) for the avatar.
 * - If `name` is provided: first letter, uppercased.
 * - Otherwise: first 2 hex chars of the address (after 0x), uppercased.
 */
function getInitials(address: string, name?: string): string {
  if (name && name.trim().length > 0) {
    return name.trim()[0].toUpperCase();
  }
  return address.slice(2, 4).toUpperCase();
}

// ─── Component ──────────────────────────────────────────────────────

export function GradientAvatar({
  address,
  name,
  size = "md",
  className,
}: GradientAvatarProps) {
  const gradient = addressToGradient(address);
  const initials = getInitials(address, name);

  return (
    <div
      className={cn(
        "relative rounded-full flex items-center justify-center shrink-0",
        "font-semibold text-white select-none",
        "ring-2 ring-white/10",
        sizeStyles[size],
        className
      )}
      style={{ background: gradient }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}
