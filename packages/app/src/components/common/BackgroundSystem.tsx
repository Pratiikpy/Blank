/**
 * Premium Background System — inspired by Devialet, Quantix, Abstract
 *
 * Layer 1: Pure black base (#000000)
 * Layer 2: Subtle mesh gradient for depth
 * Layer 3: Fine grid lines (60px spacing)
 * Layer 4: Animated gradient orbs (very subtle)
 * Layer 5: Edge vignette
 * Layer 6: Mouse spotlight (FlashlightEffect)
 * Layer 7: Noise texture for materiality
 */
export function BackgroundSystem() {
  return (
    <div className="fixed inset-0 -z-50 overflow-hidden" aria-hidden="true">
      {/* Layer 1: Pure black */}
      <div className="absolute inset-0 bg-black" />

      {/* Layer 2: Mesh gradient — minimal color */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 20% 0%, rgba(16,185,129,0.10) 0%, transparent 50%),
            radial-gradient(ellipse 60% 40% at 80% 90%, rgba(139,92,246,0.08) 0%, transparent 50%)
          `,
        }}
      />

      {/* Layer 3: Grid lines — editorial feel */}
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
        }}
      />

      {/* Layer 4: Gradient orbs — very subtle */}
      <div
        className="absolute w-[600px] h-[600px] rounded-full"
        style={{
          background: "rgba(16,185,129,0.10)",
          filter: "blur(160px)",
          top: "-15%",
          left: "-8%",
          animation: "orb-drift-1 22s ease-in-out infinite",
        }}
      />
      <div
        className="absolute w-[500px] h-[500px] rounded-full"
        style={{
          background: "rgba(139,92,246,0.08)",
          filter: "blur(140px)",
          top: "50%",
          right: "-10%",
          animation: "orb-drift-2 26s ease-in-out infinite",
        }}
      />

      {/* Layer 5: Vignette */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 80% 70% at center, transparent 30%, rgba(0,0,0,0.45) 100%)",
        }}
      />

      {/* Layer 7: Noise */}
      <div
        className="absolute inset-0 opacity-[0.045] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundRepeat: "repeat",
          backgroundSize: "128px 128px",
        }}
      />

      <style>{`
        @keyframes orb-drift-1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(50px, -35px) scale(1.03); }
          66% { transform: translate(-25px, 25px) scale(0.97); }
        }
        @keyframes orb-drift-2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(-50px, 35px) scale(0.98); }
          66% { transform: translate(35px, -35px) scale(1.02); }
        }
      `}</style>
    </div>
  );
}
