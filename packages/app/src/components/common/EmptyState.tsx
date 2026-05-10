// Wave 4 task #253 — reusable empty-state component.
//
// Pattern matches the existing Groups.tsx + ClaimLinkPage.tsx aesthetic:
//   - Soft pastel icon bubble (rounded-2xl, configurable color)
//   - Heading-font headline (font-heading font-medium)
//   - Body copy in --text-secondary
//   - Optional primary CTA (dark fill, h-12, rounded-2xl)
//   - Optional secondary "learn more" anchor below
//
// Two visual densities — `centered` (for full-screen empty states like
// the recipient claim page) and `inline` (for cards-in-cards like the
// History list inside a parent panel).

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export type EmptyStateTone =
  | "neutral"
  | "blue"
  | "emerald"
  | "amber"
  | "rose"
  | "purple"
  | "pink"
  | "slate"
  | "cyan";

const TONE: Record<EmptyStateTone, { bg: string; text: string }> = {
  neutral: { bg: "bg-[var(--surface-2)]", text: "text-[var(--text-secondary)]" },
  blue:    { bg: "bg-blue-50",      text: "text-blue-600" },
  emerald: { bg: "bg-emerald-50",   text: "text-emerald-600" },
  amber:   { bg: "bg-amber-50",     text: "text-amber-600" },
  rose:    { bg: "bg-rose-50",      text: "text-rose-600" },
  purple:  { bg: "bg-purple-50",    text: "text-purple-600" },
  pink:    { bg: "bg-pink-50",      text: "text-pink-600" },
  slate:   { bg: "bg-slate-100",    text: "text-slate-700" },
  cyan:    { bg: "bg-cyan-50",      text: "text-cyan-600" },
};

interface EmptyStateProps {
  /** Lucide icon for the bubble. */
  icon: LucideIcon;
  /** Pastel tone for the icon bubble. Defaults to neutral. */
  tone?: EmptyStateTone;
  /** Headline (rendered in font-heading). */
  title: string;
  /** Subtitle / body. Plain text or ReactNode. */
  body?: React.ReactNode;
  /** Primary CTA. */
  cta?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
  /** Optional secondary action (text link below the CTA). */
  secondary?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
  /**
   * Density. `centered` = stand-alone full-screen layout (vh-centered).
   * `inline` = sits inside a parent panel without taking over.
   * Default: `inline`.
   */
  density?: "centered" | "inline";
  className?: string;
}

export function EmptyState({
  icon: Icon,
  tone = "neutral",
  title,
  body,
  cta,
  secondary,
  density = "inline",
  className,
}: EmptyStateProps) {
  const toneCls = TONE[tone];

  const inner = (
    <div className="flex flex-col items-center text-center max-w-sm mx-auto">
      <div
        className={cn(
          "w-16 h-16 rounded-2xl flex items-center justify-center mb-5",
          toneCls.bg,
        )}
        aria-hidden="true"
      >
        <Icon size={28} className={toneCls.text} strokeWidth={1.75} />
      </div>
      <h3 className="text-xl sm:text-2xl font-heading font-medium text-[var(--text-primary)] mb-2">
        {title}
      </h3>
      {body && (
        <p className="text-sm sm:text-base text-[var(--text-secondary)] mb-6">
          {body}
        </p>
      )}
      {cta && <PrimaryCta {...cta} />}
      {secondary && (
        <SecondaryLink className={cta ? "mt-3" : "mt-2"} {...secondary} />
      )}
    </div>
  );

  if (density === "centered") {
    return (
      <div className={cn("min-h-[60vh] flex items-center justify-center px-6", className)}>
        {inner}
      </div>
    );
  }

  return (
    <div className={cn("py-12 sm:py-16 px-6", className)}>
      {inner}
    </div>
  );
}

function PrimaryCta(props: { label: string; onClick?: () => void; href?: string }) {
  const cls = "h-12 px-6 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors inline-flex items-center justify-center gap-2";
  if (props.href) {
    return (
      <a href={props.href} className={cls}>
        {props.label}
      </a>
    );
  }
  return (
    <button type="button" onClick={props.onClick} className={cls}>
      {props.label}
    </button>
  );
}

function SecondaryLink(props: { label: string; onClick?: () => void; href?: string; className?: string }) {
  const cls = cn(
    "text-sm text-[var(--text-secondary)] underline decoration-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:decoration-[var(--text-primary)] transition-colors",
    props.className,
  );
  if (props.href) {
    return (
      <a href={props.href} className={cls}>
        {props.label}
      </a>
    );
  }
  return (
    <button type="button" onClick={props.onClick} className={cls}>
      {props.label}
    </button>
  );
}
