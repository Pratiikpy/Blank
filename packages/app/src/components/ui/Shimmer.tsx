import { cn } from "@/lib/cn";

// ─── Base Shimmer ───────────────────────────────────────────────────
// The shimmer animation is defined in index.css as .shimmer
// This component provides typed wrappers with correct dimensions.

interface ShimmerProps {
  className?: string;
  width?: string;
  height?: string;
  /** Rounded variant: "sm" | "md" | "lg" | "full" (circle) */
  rounded?: "sm" | "md" | "lg" | "full";
}

const roundedStyles = {
  sm: "rounded",
  md: "rounded-lg",
  lg: "rounded-xl",
  full: "rounded-full",
} as const;

export function Shimmer({
  className,
  width = "w-full",
  height = "h-4",
  rounded = "md",
}: ShimmerProps) {
  return (
    <div
      className={cn("shimmer", roundedStyles[rounded], width, height, className)}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading...</span>
    </div>
  );
}

// ─── Preset Shapes ──────────────────────────────────────────────────
// Each preset matches the EXACT dimensions of the real content it
// replaces, preventing layout shift when data arrives.

export function ShimmerText({ className, lines = 1 }: { className?: string; lines?: number }) {
  if (lines === 1) {
    return <Shimmer className={className} width="w-24" height="h-4" rounded="sm" />;
  }
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Shimmer
          key={i}
          width={i === lines - 1 ? "w-3/5" : "w-full"}
          height="h-4"
          rounded="sm"
        />
      ))}
    </div>
  );
}

export function ShimmerAmount({ className }: { className?: string }) {
  return (
    <Shimmer
      className={cn("font-mono", className)}
      width="w-[8ch]"
      height="h-7"
      rounded="md"
    />
  );
}

export function ShimmerCircle({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizes = { sm: "w-8 h-8", md: "w-10 h-10", lg: "w-12 h-12" };
  return (
    <div
      className={cn("shimmer rounded-full", sizes[size], className)}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading...</span>
    </div>
  );
}

// ─── Composite Skeletons ────────────────────────────────────────────

/** Matches ActivityItem layout exactly */
export function ShimmerActivityItem({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3",
        "rounded-2xl bg-gradient-to-b from-white/[0.03] to-white/[0.01]",
        "border border-white/[0.06]",
        className
      )}
    >
      {/* Icon circle */}
      <ShimmerCircle size="md" />

      {/* Text lines */}
      <div className="flex-1 space-y-2">
        <Shimmer width="w-32" height="h-3.5" rounded="sm" />
        <Shimmer width="w-20" height="h-3" rounded="sm" />
      </div>

      {/* Amount + time */}
      <div className="flex flex-col items-end gap-1.5">
        <Shimmer width="w-16" height="h-3.5" rounded="sm" />
        <Shimmer width="w-10" height="h-2.5" rounded="sm" />
      </div>
    </div>
  );
}

/** Matches a GlassCard with title + body content */
export function ShimmerCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "p-6 space-y-4",
        "rounded-2xl bg-gradient-to-b from-white/[0.04] to-white/[0.015]",
        "border border-white/[0.07] ring-1 ring-inset ring-white/[0.03]",
        className
      )}
    >
      <Shimmer width="w-1/3" height="h-5" rounded="md" />
      <Shimmer width="w-full" height="h-10" rounded="lg" />
      <div className="flex gap-3">
        <Shimmer width="w-1/2" height="h-9" rounded="lg" />
        <Shimmer width="w-1/2" height="h-9" rounded="lg" />
      </div>
    </div>
  );
}

/** Matches balance display: large amount + subtitle */
export function ShimmerBalance({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <Shimmer width="w-40" height="h-10" rounded="lg" />
      <Shimmer width="w-24" height="h-4" rounded="sm" />
    </div>
  );
}
