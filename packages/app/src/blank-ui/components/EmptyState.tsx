import type { ReactNode } from "react";

interface EmptyStateProps {
  /** Lucide icon or any visual node, rendered inside a 56px bubble. */
  icon?: ReactNode;
  title: string;
  body: string;
  /** Optional CTA (single button). */
  cta?: { label: string; onClick?: () => void; href?: string; testId?: string };
  /** Tailwind bg-* class for the icon bubble. */
  bubbleClass?: string;
  testId?: string;
}

// Wave 5 Block 6 — reusable empty state.
//
// Drop-in for screens that need a consistent "nothing yet" surface
// per WAVE5_PLAN.md §6.2:
//   - rounded bubble + single CTA + 1-sentence explain
//
// The CTA accepts either an onClick (in-screen action) or an href
// (router-style link). Renders a button or an anchor accordingly.
// If neither is provided the CTA is omitted.

export function EmptyState({ icon, title, body, cta, bubbleClass, testId }: EmptyStateProps) {
  const bubble = bubbleClass ?? "bg-slate-100";
  return (
    <div
      data-testid={testId ?? "empty-state"}
      className="glass-card-static rounded-2xl p-10 text-center max-w-md mx-auto"
    >
      {icon && (
        <div className={`w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center ${bubble}`}>
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold mb-2">{title}</h3>
      <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{body}</p>
      {cta && (
        <div className="mt-5">
          {cta.href ? (
            <a
              data-testid={cta.testId ?? "empty-state-cta"}
              href={cta.href}
              className="inline-flex items-center justify-center h-11 px-5 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black"
            >
              {cta.label}
            </a>
          ) : (
            <button
              data-testid={cta.testId ?? "empty-state-cta"}
              onClick={cta.onClick}
              className="inline-flex items-center justify-center h-11 px-5 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black"
            >
              {cta.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
