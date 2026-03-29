import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";

/* ─── Types ──────────────────────────────────────────────────────── */

interface CycleTextProps {
  words: string[];
  interval?: number;
  className?: string;
}

interface CycleTextBlockProps {
  sentences: string[];
  interval?: number;
  className?: string;
}

/* ─── Animation Config ───────────────────────────────────────────── */

const TRANSITION = {
  duration: 0.65,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

const SLIDE_VARIANTS = {
  enter: {
    y: "100%",
    opacity: 0,
    filter: "blur(4px)",
  },
  center: {
    y: 0,
    opacity: 1,
    filter: "blur(0px)",
  },
  exit: {
    y: "-100%",
    opacity: 0,
    filter: "blur(4px)",
  },
};

/* ─── useCycleIndex Hook ─────────────────────────────────────────── */

function useCycleIndex(length: number, interval: number) {
  const [index, setIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(() => {
    if (length <= 1) return;
    timerRef.current = setInterval(() => {
      setIndex((prev) => (prev + 1) % length);
    }, interval);
  }, [length, interval]);

  useEffect(() => {
    start();
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
      }
    };
  }, [start]);

  return index;
}

/* ─── CycleText (inline) ─────────────────────────────────────────── */

/**
 * Cycles through `words` with a smooth vertical slide animation.
 * Renders as `inline-block` so it can sit within a sentence.
 *
 * @example
 * <h1>
 *   <CycleText words={["Send", "Split", "Invoice", "Tip", "Pay"]} /> privately.
 * </h1>
 */
export function CycleText({
  words,
  interval = 3000,
  className = "",
}: CycleTextProps) {
  const index = useCycleIndex(words.length, interval);

  if (words.length === 0) return null;

  return (
    <span
      className={`relative inline-block overflow-hidden align-bottom ${className}`}
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Invisible sizer — takes up width of longest word to prevent layout shift */}
      <span className="invisible block" aria-hidden="true">
        {words.reduce((a, b) => (a.length >= b.length ? a : b), "")}
      </span>

      {/* Animated word */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={words[index]}
          className="absolute inset-0 flex items-center"
          variants={SLIDE_VARIANTS}
          initial="enter"
          animate="center"
          exit="exit"
          transition={TRANSITION}
        >
          {words[index]}
        </motion.span>
      </AnimatePresence>

      {/* Screen-reader-only current word (hidden visually, announced by aria-live) */}
      <span className="sr-only">{words[index]}</span>
    </span>
  );
}

/* ─── CycleTextBlock (block-level, full sentences) ───────────────── */

/**
 * Cycles through full `sentences` with a smooth vertical slide animation.
 * Renders as a `block`-level element for standalone rotating text.
 *
 * @example
 * <CycleTextBlock
 *   sentences={["Send privately.", "Split privately.", "Invoice privately."]}
 *   className="text-3xl font-bold text-white"
 * />
 */
export function CycleTextBlock({
  sentences,
  interval = 3000,
  className = "",
}: CycleTextBlockProps) {
  const index = useCycleIndex(sentences.length, interval);

  if (sentences.length === 0) return null;

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Invisible sizer — tallest sentence determines container height */}
      <span className="invisible block" aria-hidden="true">
        {sentences.reduce((a, b) => (a.length >= b.length ? a : b), "")}
      </span>

      {/* Animated sentence */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={sentences[index]}
          className="absolute inset-0 flex items-center"
          variants={SLIDE_VARIANTS}
          initial="enter"
          animate="center"
          exit="exit"
          transition={TRANSITION}
        >
          {sentences[index]}
        </motion.span>
      </AnimatePresence>

      {/* Screen-reader-only current sentence */}
      <span className="sr-only">{sentences[index]}</span>
    </div>
  );
}

export default CycleText;
