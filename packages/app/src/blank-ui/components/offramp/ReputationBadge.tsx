interface ReputationBadgeProps {
  fillCount: number;
  disputeCount: number;
  className?: string;
}

/**
 * Maker reputation chip. Score formula matches WAVE5_PLAN.md §1.3:
 *   trust = fillCount / (fillCount + 2 * disputeCount)
 * Disputes count double so a single bad fill drops the score
 * meaningfully. Returns "new" for makers with zero history.
 */
export function ReputationBadge({ fillCount, disputeCount, className }: ReputationBadgeProps) {
  if (fillCount === 0 && disputeCount === 0) {
    return (
      <span
        data-testid="offramp-rep-badge"
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-200 text-slate-700 ${className ?? ""}`.trim()}
      >
        new
      </span>
    );
  }
  const denom = fillCount + 2 * disputeCount;
  const score = denom === 0 ? 0 : (fillCount / denom) * 100;
  const tone =
    score >= 90 ? "bg-emerald-500/10 text-emerald-600" :
    score >= 70 ? "bg-blue-500/10 text-blue-600" :
    score >= 50 ? "bg-amber-500/10 text-amber-600" :
                  "bg-rose-500/10 text-rose-600";
  return (
    <span
      data-testid="offramp-rep-badge"
      title={`fills=${fillCount} · disputes=${disputeCount}`}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${tone} ${className ?? ""}`.trim()}
    >
      {Math.round(score)}% · {fillCount} fills
    </span>
  );
}
