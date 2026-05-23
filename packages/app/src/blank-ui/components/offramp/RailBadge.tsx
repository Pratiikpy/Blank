import { railById } from "@/lib/reclaim-providers";

interface RailBadgeProps {
  railId: number;
  className?: string;
}

/**
 * Small rail pill. Color-coded per WAVE5_PLAN.md §2 design tokens.
 * Falls back to a neutral chip on unknown ids so we don't crash on
 * a future rail value the UI doesn't know yet.
 */
export function RailBadge({ railId, className }: RailBadgeProps) {
  const rail = railById(railId);
  const label = rail?.label ?? `Rail #${railId}`;
  const tone = rail?.badgeClass ?? "bg-slate-200 text-slate-700";
  return (
    <span
      data-testid="offramp-rail-badge"
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${tone} ${className ?? ""}`.trim()}
    >
      {label}
    </span>
  );
}
