import type { Variants } from "framer-motion";

export const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Reduced-motion-safe variant helper ─────────────────────────────
// When the user prefers reduced motion, all variants collapse to simple
// opacity fades (no blur, no scale, no y-offset).

const noMotion: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

// ─── Page Transitions (blur in/out like NullPay) ────────────────────

export const pageVariants: Variants = prefersReducedMotion
  ? noMotion
  : {
      initial: {
        opacity: 0,
        filter: "blur(8px)",
        y: 12,
      },
      animate: {
        opacity: 1,
        filter: "blur(0px)",
        y: 0,
        transition: {
          duration: 0.5,
          ease: [0.22, 1, 0.36, 1],
          filter: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
        },
      },
      exit: {
        opacity: 0,
        filter: "blur(8px)",
        y: -8,
        transition: {
          duration: 0.3,
          ease: [0.22, 1, 0.36, 1],
          filter: { duration: 0.25, ease: [0.22, 1, 0.36, 1] },
        },
      },
    };

// ─── Hero Section (scale + blur, slower & more dramatic) ─────────────

export const heroVariants: Variants = prefersReducedMotion
  ? noMotion
  : {
      initial: {
        opacity: 0,
        scale: 0.92,
        filter: "blur(12px)",
      },
      animate: {
        opacity: 1,
        scale: 1,
        filter: "blur(0px)",
        transition: {
          duration: 0.8,
          ease: [0.22, 1, 0.36, 1],
          scale: { type: "spring", stiffness: 200, damping: 22, duration: 0.9 },
          filter: { duration: 0.7, ease: [0.22, 1, 0.36, 1] },
        },
      },
      exit: {
        opacity: 0,
        scale: 0.96,
        filter: "blur(8px)",
        transition: {
          duration: 0.4,
          ease: [0.22, 1, 0.36, 1],
          filter: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
        },
      },
    };

// ─── Staggered List Items ───────────────────────────────────────────

export const staggerContainer: Variants = prefersReducedMotion
  ? { animate: {} }
  : {
      animate: {
        transition: {
          staggerChildren: 0.08,
        },
      },
    };

export const fadeInUp: Variants = prefersReducedMotion
  ? noMotion
  : {
      initial: {
        opacity: 0,
        y: 20,
      },
      animate: {
        opacity: 1,
        y: 0,
        transition: {
          duration: 0.4,
          ease: [0.22, 1, 0.36, 1],
        },
      },
    };

// ─── Scale In (for cards, modals) ───────────────────────────────────

export const scaleIn: Variants = prefersReducedMotion
  ? noMotion
  : {
      initial: {
        opacity: 0,
        scale: 0.96,
      },
      animate: {
        opacity: 1,
        scale: 1,
        transition: {
          type: "spring",
          stiffness: 260,
          damping: 28,
        },
      },
    };

// ─── Modal Overlay ──────────────────────────────────────────────────

export const overlayVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

export const modalVariants: Variants = prefersReducedMotion
  ? noMotion
  : {
      initial: {
        opacity: 0,
        scale: 0.95,
        y: 20,
      },
      animate: {
        opacity: 1,
        scale: 1,
        y: 0,
        transition: {
          type: "spring",
          stiffness: 350,
          damping: 28,
        },
      },
      exit: {
        opacity: 0,
        scale: 0.95,
        y: 10,
        transition: {
          duration: 0.2,
        },
      },
    };

// ─── Interactive Elements ───────────────────────────────────────────

/** Button/card hover: lift up + scale. Tap: press down. */
export const tapScale = prefersReducedMotion
  ? {}
  : {
      whileHover: { scale: 1.02, y: -1, transition: { type: "spring", stiffness: 400, damping: 17 } },
      whileTap: { scale: 0.97, y: 1, transition: { type: "spring", stiffness: 500, damping: 20 } },
    };

/** Subtle tap for list items and secondary interactive elements. */
export const gentleTap = prefersReducedMotion
  ? {}
  : {
      whileTap: { scale: 0.98, transition: { type: "spring", stiffness: 500, damping: 25 } },
    };

// ─── Spring Presets ─────────────────────────────────────────────────

/** Fast settle, no visible overshoot. For tab pills, indicators. */
export const springCrisp = {
  type: "spring" as const,
  stiffness: 350,
  damping: 30,
};

/** Slight overshoot. For buttons, cards. Feels physical. */
export const springBouncy = {
  type: "spring" as const,
  stiffness: 400,
  damping: 22,
};

/** Very fast snap. For press/release feedback. */
export const springSnappy = {
  type: "spring" as const,
  stiffness: 500,
  damping: 20,
};

/** Slow, smooth settle. For page elements, modals. */
export const springGentle = {
  type: "spring" as const,
  stiffness: 250,
  damping: 25,
};
