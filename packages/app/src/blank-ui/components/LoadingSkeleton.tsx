// Wave 5 Block 6 — reusable loading skeleton.
//
// Per WAVE5_PLAN.md §6.2: every async fetch shows a skeleton sized
// to the final layout, not a spinner. The user shouldn't wonder
// whether the page is loading or broken.

interface LoadingSkeletonProps {
  /** Number of skeleton rows. */
  rows?: number;
  /** Tailwind height utility class for each row. */
  rowClassName?: string;
  testId?: string;
}

export function LoadingSkeleton({
  rows = 3,
  rowClassName = "h-14",
  testId,
}: LoadingSkeletonProps) {
  return (
    <div
      data-testid={testId ?? "loading-skeleton"}
      role="status"
      aria-live="polite"
      aria-label="Loading"
      className="space-y-3"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={`glass-card-static rounded-2xl ${rowClassName} animate-pulse bg-slate-100/50`}
        />
      ))}
    </div>
  );
}
