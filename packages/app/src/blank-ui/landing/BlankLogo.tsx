// ══════════════════════════════════════════════════════════════════
//  BlankLogo — brand identity component
//
//  Variants:
//    "wordmark"  → "blank." (lowercase, period) — for nav, footer, inline
//    "mark"      → the filled-bowl "b" SVG only — for small contexts
//    "lockup"    → mark + wordmark side by side — for app sidebars etc.
//    "contained" → mark inside a rounded black square — for app icons
//
//  The mark uses currentColor so it inherits from parent CSS. Change
//  the color of the parent to restyle for dark/light contexts.
// ══════════════════════════════════════════════════════════════════

interface BlankLogoProps {
  variant?: "wordmark" | "mark" | "lockup" | "contained";
  size?: number;      // used by mark variants (height in px)
  wordmarkSize?: string; // CSS font-size for wordmark text (e.g. "1rem")
  className?: string;
  title?: string;
}

// The standalone "b" mark — tall stem + filled (counter-less) bowl
// Proportions tuned for legibility at 16–32px: ascender is ~30% of
// total height so the "letter" silhouette reads even at favicon sizes.
function MarkGlyph({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      aria-hidden="true"
    >
      {/* Ascender + stem — full-height bar on the left */}
      <rect x="8" y="4" width="14" height="54" rx="1.5" fill="currentColor" />
      {/* Bowl — filled circle, positioned low so the ascender reads above it */}
      <circle cx="36" cy="41" r="17" fill="currentColor" />
    </svg>
  );
}

// The same mark inside a black rounded square — for app icons / favicons.
// Geometry is distinct from the standalone glyph: the contained version
// trades a bit of ascender height for more overall presence inside the
// container, because at 16px the container itself provides the silhouette.
function MarkContained({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="13" fill="#0A0A0A" />
      {/* White ascender + stem */}
      <rect x="14" y="9" width="13" height="46" rx="1" fill="#FFFFFF" />
      {/* White bowl — slightly taller-than-wide for better letter feel */}
      <ellipse cx="39" cy="39" rx="14" ry="15" fill="#FFFFFF" />
    </svg>
  );
}

// The wordmark — "blank." as styled text (not SVG, for accessibility + scaling)
function Wordmark({ size }: { size?: string }) {
  return (
    <span
      className="bl-wordmark"
      style={size ? { fontSize: size } : undefined}
    >
      blank.
    </span>
  );
}

export function BlankLogo({
  variant = "wordmark",
  size = 22,
  wordmarkSize,
  className,
  title = "Blank",
}: BlankLogoProps) {
  if (variant === "mark") {
    return (
      <span className={className} title={title} aria-label={title} role="img">
        <MarkGlyph size={size} />
      </span>
    );
  }

  if (variant === "contained") {
    return (
      <span className={className} title={title} aria-label={title} role="img">
        <MarkContained size={size} />
      </span>
    );
  }

  if (variant === "lockup") {
    return (
      <span
        className={`bl-lockup ${className ?? ""}`}
        aria-label={title}
      >
        <MarkGlyph size={size} />
        <Wordmark size={wordmarkSize} />
      </span>
    );
  }

  // Default: "wordmark"
  return (
    <span className={className} aria-label={title}>
      <Wordmark size={wordmarkSize} />
    </span>
  );
}
