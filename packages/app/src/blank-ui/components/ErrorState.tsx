import { AlertOctagon } from "lucide-react";

interface ErrorStateProps {
  title?: string;
  message?: string;
  /** Optional retry CTA. */
  onRetry?: () => void;
  testId?: string;
}

// Wave 5 Block 6 — reusable error state.
//
// Per WAVE5_PLAN.md §6.2: every screen's error case shows an honest
// message + retry CTA + Sentry breadcrumb (caller responsible for
// the Sentry side; this component is the visual leg).

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  testId,
}: ErrorStateProps) {
  return (
    <div
      data-testid={testId ?? "error-state"}
      className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-5 max-w-md mx-auto"
    >
      <div className="flex items-start gap-3">
        <AlertOctagon size={18} className="text-rose-600 shrink-0 mt-0.5" />
        <div className="flex-1 text-sm">
          <div className="font-semibold text-rose-700">{title}</div>
          {message && (
            <div data-testid="error-state-message" className="mt-1 text-rose-700/80 break-words">
              {message}
            </div>
          )}
          {onRetry && (
            <button
              data-testid="error-state-retry"
              onClick={onRetry}
              className="mt-3 inline-flex items-center h-9 px-4 rounded-xl bg-rose-600 text-white text-xs font-medium hover:bg-rose-700"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
