import { useRef, useState } from "react";

// ══════════════════════════════════════════════════════════════════
//  XRaySlider — hover-to-reveal window, à la Fhenix's dollar-bill demo
//  Uses clip-path: inset(...) which is GPU-accelerated and jank-free.
//  The "window" only appears on hover/touch — creates the X-ray feel.
//  ══════════════════════════════════════════════════════════════════

interface Props {
  baseSrc: string;
  baseAlt: string;
  revealSrc: string;
  revealAlt: string;
  /** Width of the reveal window as % of container — default 22 */
  windowWidthPct?: number;
}

export function XRaySlider({
  baseSrc,
  baseAlt,
  revealSrc,
  revealAlt,
  windowWidthPct = 22,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<HTMLImageElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  const move = (clientX: number, clientY: number) => {
    const container = containerRef.current;
    const reveal = revealRef.current;
    const handle = handleRef.current;
    const icon = iconRef.current;
    if (!container || !reveal || !handle || !icon) return;

    const rect = container.getBoundingClientRect();
    const xPos = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const yPos = Math.max(0, Math.min(clientY - rect.top, rect.height));
    const pct = (xPos / rect.width) * 100;

    const leftInset = Math.max(0, pct - windowWidthPct / 2);
    const rightInset = Math.max(0, 100 - (pct + windowWidthPct / 2));

    reveal.style.clipPath = `inset(0% ${rightInset}% 0% ${leftInset}%)`;
    handle.style.left = `${pct}%`;
    icon.style.top = `${yPos}px`;
  };

  return (
    <div
      ref={containerRef}
      className="ll-slider"
      role="img"
      aria-label="Hover to reveal: dollar bill decoded into FHE ciphertext"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onMouseMove={(e) => move(e.clientX, e.clientY)}
      onTouchStart={(e) => {
        setVisible(true);
        const t = e.touches[0];
        move(t.clientX, t.clientY);
      }}
      onTouchEnd={() => setVisible(false)}
      onTouchMove={(e) => {
        const t = e.touches[0];
        move(t.clientX, t.clientY);
      }}
    >
      <img src={baseSrc} alt={baseAlt} className="ll-slider-base" loading="lazy" />
      <img
        ref={revealRef}
        src={revealSrc}
        alt={revealAlt}
        className={`ll-slider-reveal${visible ? " visible" : ""}`}
        loading="lazy"
      />
      <div ref={handleRef} className="ll-slider-handle">
        <div
          ref={iconRef}
          className={`ll-slider-handle-icon${visible ? " visible" : ""}`}
        >
          ↔
        </div>
      </div>
    </div>
  );
}
