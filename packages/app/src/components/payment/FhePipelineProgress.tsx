// Wave 4 task #245 — visual companion to useFhePipeline.
//
// Renders the 7-step FHE pipeline as a vertical step list with live
// status (pending / active / done / failed) and SDK-reported per-step
// durations. Replaces the fake-percentage `EncryptionProgress` for new
// flows; the old component is kept for legacy paths during migration.

import { Check, Loader2, AlertCircle, Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  PIPELINE_STEPS,
  STEP_LABEL,
  STEP_HINT,
  type FhePipelineState,
  type FhePipelineStep,
} from "@/hooks/useFhePipeline";

interface FhePipelineProgressProps {
  state: FhePipelineState;
  /** When true (default), show step durations once each step finishes. */
  showDurations?: boolean;
  /** When true, render a compact one-line "step X of 7: <label>" instead of the full list. */
  compact?: boolean;
  className?: string;
}

export function FhePipelineProgress({
  state,
  showDurations = true,
  compact = false,
  className,
}: FhePipelineProgressProps) {
  // Idle = render nothing (consumer should not mount us in idle mode).
  if (state.phase === "idle") return null;

  if (compact) {
    const cur = state.currentIndex >= 0 ? PIPELINE_STEPS[state.currentIndex] : null;
    const label = cur ? STEP_LABEL[cur] : state.phase === "success" ? "Done" : "Working…";
    return (
      <div
        className={cn(
          "flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--surface-2)] text-sm",
          className,
        )}
        role="status"
        aria-live="polite"
      >
        {state.phase === "failed" ? (
          <AlertCircle size={16} className="text-red-500 flex-shrink-0" />
        ) : state.phase === "success" ? (
          <Check size={16} className="text-emerald-600 flex-shrink-0" />
        ) : (
          <Loader2 size={16} className="animate-spin flex-shrink-0" />
        )}
        <span className="font-medium">{label}</span>
        <span className="text-[var(--text-secondary)] ml-auto text-xs">
          Step {Math.max(state.currentIndex + 1, 1)} of {PIPELINE_STEPS.length}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn("space-y-2", className)}
      role="status"
      aria-live="polite"
      aria-label={`FHE pipeline progress, step ${state.currentIndex + 1} of ${PIPELINE_STEPS.length}`}
    >
      <div className="flex items-center gap-2 mb-3 text-xs uppercase tracking-wide text-[var(--text-secondary)]">
        <Lock size={12} /> Encrypted pipeline
      </div>
      {PIPELINE_STEPS.map((id) => (
        <StepRow
          key={id}
          id={id}
          status={state.status[id]}
          duration={showDurations ? state.duration[id] : undefined}
        />
      ))}
      {state.error && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-xs flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{state.error}</span>
        </div>
      )}
    </div>
  );
}

function StepRow({
  id,
  status,
  duration,
}: {
  id: FhePipelineStep;
  status: "pending" | "active" | "done" | "failed";
  duration: number | undefined;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-3 py-2 rounded-lg transition-colors",
        status === "active" && "bg-[var(--surface-2)]",
      )}
    >
      <div
        className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
          status === "done" && "bg-emerald-100 text-emerald-600",
          status === "active" && "bg-blue-100 text-blue-600",
          status === "failed" && "bg-red-100 text-red-600",
          status === "pending" && "bg-[var(--surface-2)] text-[var(--text-tertiary)]",
        )}
      >
        {status === "done" && <Check size={14} />}
        {status === "active" && <Loader2 size={14} className="animate-spin" />}
        {status === "failed" && <AlertCircle size={14} />}
        {status === "pending" && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-sm font-medium",
              status === "pending" && "text-[var(--text-tertiary)]",
              status === "active" && "text-[var(--text-primary)]",
            )}
          >
            {STEP_LABEL[id]}
          </span>
          {duration !== undefined && status === "done" && (
            <span className="text-xs text-[var(--text-tertiary)] tabular-nums">
              {formatDuration(duration)}
            </span>
          )}
        </div>
        {(status === "active" || status === "failed") && (
          <div className="text-xs text-[var(--text-secondary)] mt-0.5">{STEP_HINT[id]}</div>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
