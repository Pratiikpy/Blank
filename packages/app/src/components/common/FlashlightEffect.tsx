import { useRef, useEffect } from "react";

/**
 * Mouse-tracking radial gradient overlay.
 * Creates a premium "dark room with a spotlight" feel.
 * Desktop only — disabled on mobile via CSS.
 *
 * Pattern from NullPay: updates CSS custom properties on mousemove,
 * drives a radial-gradient. Zero React re-renders per frame.
 */
export function FlashlightEffect() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handler = (e: MouseEvent) => {
      el.style.setProperty("--mouse-x", `${e.clientX}px`);
      el.style.setProperty("--mouse-y", `${e.clientY}px`);
    };

    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  return (
    <div
      ref={ref}
      className="fixed inset-0 pointer-events-none z-0 hidden md:block"
      style={{
        background:
          "radial-gradient(300px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(52, 211, 153, 0.05), transparent 50%), radial-gradient(800px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(16, 185, 129, 0.03), transparent 70%)",
      }}
    />
  );
}
