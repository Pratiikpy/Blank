import { useEffect, useRef } from "react";

// ══════════════════════════════════════════════════════════════════
//  DecodeWord — scramble-reveal cycling word animation
//  Uses direct DOM construction (createElement/textContent) for speed:
//  at 45ms per character, a React state-driven span tree would thrash
//  reconciliation. This also avoids innerHTML entirely — safer by pattern.
//  ══════════════════════════════════════════════════════════════════

type Word = { text: string; star: number };

const WORDS: Word[] = [
  { text: "confidential", star: 7 },
  { text: "private", star: 3 },
  { text: "encrypted", star: 7 },
  { text: "shielded", star: 3 },
];

const SCRAMBLE_CHARS = "!<>-_\\/[]{}—=+*^?#abcdefghijklmnopqrstuvwxyz";
const SPEED_MS = 45;
const HOLD_MS = 2200;

function randScrambleChar(): string {
  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
}

/** Rebuilds the word via DOM API (no innerHTML) — called up to ~22/sec. */
function renderWord(
  host: HTMLElement,
  word: string,
  starPos: number,
  upTo: number,
  hoverAt: number | null
): void {
  const frag = document.createDocumentFragment();

  const open = document.createElement("span");
  open.className = "paren";
  open.textContent = "(";
  frag.appendChild(open);

  for (let i = 0; i < word.length; i++) {
    const span = document.createElement("span");
    span.dataset.index = String(i + 1);

    if (i === starPos) {
      span.className = "star";
      span.textContent = "*";
    } else if (i === hoverAt) {
      span.className = "hover-char";
      span.textContent = randScrambleChar();
    } else if (i < upTo || upTo >= word.length) {
      span.className = "revealed";
      span.textContent = word[i];
    } else {
      span.className = "scramble";
      span.textContent = randScrambleChar();
    }

    frag.appendChild(span);
  }

  const close = document.createElement("span");
  close.className = "paren";
  close.textContent = ")";
  frag.appendChild(close);

  // Swap children in one shot — browser repaints once, not per-span.
  host.replaceChildren(frag);
}

export function DecodeWord() {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const isSmall = window.innerWidth < 768;
    let wordIdx = 0;
    let revealPos = 0;
    let isPaused = false;
    let hoveredIdx: number | null = null;
    let hoverInterval: ReturnType<typeof setInterval> | null = null;
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    let stepTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const cur = () => WORDS[wordIdx];

    const step = () => {
      if (cancelled || isPaused) return;
      const w = cur();
      if (revealPos <= w.text.length) {
        renderWord(el, w.text, w.star, revealPos, null);
        revealPos++;
        stepTimer = setTimeout(step, SPEED_MS);
      } else {
        renderWord(el, w.text, w.star, w.text.length, null);
        stepTimer = setTimeout(() => {
          if (cancelled || isPaused) return;
          wordIdx = (wordIdx + 1) % WORDS.length;
          revealPos = 0;
          step();
        }, HOLD_MS);
      }
    };

    const onMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const span = target.closest("span[data-index]") as HTMLElement | null;
      if (!span) return;
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      isPaused = true;
      hoveredIdx = parseInt(span.dataset.index || "1", 10) - 1;
      if (hoverInterval) clearInterval(hoverInterval);
      hoverInterval = setInterval(() => {
        const w = cur();
        renderWord(el, w.text, w.star, w.text.length, hoveredIdx);
      }, 70);
    };

    const onMouseOut = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const span = target.closest("span[data-index]") as HTMLElement | null;
      if (!span) return;
      if (hoverInterval) {
        clearInterval(hoverInterval);
        hoverInterval = null;
      }
      hoveredIdx = null;
      isPaused = false;
      const w = cur();
      renderWord(el, w.text, w.star, w.text.length, null);
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        wordIdx = (wordIdx + 1) % WORDS.length;
        revealPos = 0;
        step();
        resumeTimer = null;
      }, HOLD_MS);
    };

    if (!isSmall) {
      el.addEventListener("mouseover", onMouseOver);
      el.addEventListener("mouseout", onMouseOut);
    }

    step();

    return () => {
      cancelled = true;
      if (stepTimer) clearTimeout(stepTimer);
      if (hoverInterval) clearInterval(hoverInterval);
      if (resumeTimer) clearTimeout(resumeTimer);
      el.removeEventListener("mouseover", onMouseOver);
      el.removeEventListener("mouseout", onMouseOut);
    };
  }, []);

  return (
    <div
      ref={elRef}
      className="ll-decode"
      aria-label="confidential, private, encrypted, shielded"
    />
  );
}
