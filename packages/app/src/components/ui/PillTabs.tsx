import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Optional badge count (e.g., pending requests) */
  badge?: number;
}

interface PillTabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  /**
   * Unique layoutId prefix. Required if multiple PillTabs
   * instances exist on the same page to prevent animation conflicts.
   */
  layoutId?: string;
  size?: "sm" | "md";
  className?: string;
}

// ─── Size config ────────────────────────────────────────────────────

const sizeConfig = {
  sm: {
    container: "h-9 p-0.5 gap-0.5",
    tab: "px-3 text-xs",
    badge: "h-4 min-w-[16px] text-[10px]",
  },
  md: {
    container: "h-11 p-1 gap-0.5",
    tab: "px-4 text-sm",
    badge: "h-[18px] min-w-[18px] text-[10px]",
  },
} as const;

// ─── Spring config ──────────────────────────────────────────────────
// Stiffness 350 + damping 30 = fast settle with no visible overshoot.
// This is the Linear/Stripe spring -- crisp, not bouncy.

const pillSpring = {
  type: "spring" as const,
  stiffness: 350,
  damping: 30,
};

// ─── Component ──────────────────────────────────────────────────────

export function PillTabs({
  tabs,
  activeTab,
  onTabChange,
  layoutId = "pill-tabs",
  size = "md",
  className,
}: PillTabsProps) {
  const styles = sizeConfig[size];

  return (
    <div
      className={cn(
        // Container: glass surface, pill shape
        "inline-flex items-center rounded-xl",
        "bg-white/[0.04] border border-white/[0.06]",
        styles.container,
        className
      )}
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              // Base tab: relative (for the pill behind it), z-10 (above pill)
              "relative z-10 inline-flex items-center justify-center gap-1.5",
              "rounded-lg font-medium transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              styles.tab,
              // Active: white text. Inactive: muted, brightens on hover.
              isActive
                ? "text-white"
                : "text-neutral-500 hover:text-neutral-300"
            )}
          >
            {/* ── Sliding pill indicator ── */}
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className={cn(
                  // The pill: positioned behind the text
                  "absolute inset-0 rounded-lg",
                  // Gradient bg + accent-tinted border + subtle glow
                  "bg-gradient-to-b from-white/[0.10] to-white/[0.05]",
                  "border border-white/[0.10]",
                  "shadow-[0_0_12px_rgba(52,211,153,0.08),inset_0_1px_0_rgba(255,255,255,0.06)]",
                  "ring-1 ring-inset ring-white/[0.04]"
                )}
                transition={pillSpring}
                // z-0: behind the text (z-10)
                style={{ zIndex: 0 }}
              />
            )}

            {/* Icon */}
            {tab.icon && (
              <span className="relative z-10 shrink-0">{tab.icon}</span>
            )}

            {/* Label */}
            <span className="relative z-10">{tab.label}</span>

            {/* Badge */}
            {tab.badge != null && tab.badge > 0 && (
              <span
                className={cn(
                  "relative z-10 inline-flex items-center justify-center",
                  "rounded-full font-semibold leading-none",
                  styles.badge,
                  isActive
                    ? "bg-accent/20 text-accent"
                    : "bg-white/[0.08] text-neutral-500"
                )}
              >
                {tab.badge > 99 ? "99+" : tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
