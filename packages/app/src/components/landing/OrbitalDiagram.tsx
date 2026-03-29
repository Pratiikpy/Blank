/**
 * OrbitalDiagram — Animated 3D orbital ring visualization
 * of the FHE coprocessor architecture (Encrypt / Compute / Decrypt).
 *
 * Three concentric rings rotate around a central "FHE Coprocessor" label,
 * tilted via rotateX to create a convincing 3D perspective effect.
 * Each ring carries a text label and small glowing dot markers.
 *
 * All animation is pure CSS keyframes -- zero JS animation overhead.
 * Responsive: scales down on viewports below 640px via media queries.
 */

import { cn } from "@/lib/cn";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OrbitalDiagramProps {
  className?: string;
}

interface RingDot {
  /** Starting angle in degrees (0 = 3-o'clock position). */
  angle: number;
}

interface RingConfig {
  /** Diameter of the ring in px. */
  size: number;
  /** CSS border value. */
  border: string;
  /** 3D tilt applied via rotateX (degrees). */
  tiltDeg: number;
  /** Duration of one full rotation in seconds. */
  duration: number;
  /** true = clockwise, false = counter-clockwise. */
  clockwise: boolean;
  /** Label rendered along the ring edge. */
  label: string;
  /** Placement angle (degrees) of the label on the ring circumference. */
  labelAngle: number;
  /** Glowing dots placed around the ring. */
  dots: RingDot[];
}

/* ------------------------------------------------------------------ */
/*  Ring configuration                                                 */
/* ------------------------------------------------------------------ */

const RINGS: RingConfig[] = [
  {
    size: 320,
    border: "1.5px dashed rgba(255,255,255,0.08)",
    tiltDeg: 65,
    duration: 25,
    clockwise: true,
    label: "ENCRYPT",
    labelAngle: -30,
    dots: [{ angle: 0 }, { angle: 160 }],
  },
  {
    size: 240,
    border: "1px solid rgba(255,255,255,0.05)",
    tiltDeg: 70,
    duration: 18,
    clockwise: false,
    label: "COMPUTE",
    labelAngle: 45,
    dots: [{ angle: 90 }, { angle: 250 }],
  },
  {
    size: 160,
    border: "1px dashed rgba(255,255,255,0.06)",
    tiltDeg: 65,
    duration: 12,
    clockwise: true,
    label: "DECRYPT",
    labelAngle: -60,
    dots: [{ angle: 120 }],
  },
];

/* ------------------------------------------------------------------ */
/*  Keyframe generation                                                */
/* ------------------------------------------------------------------ */

/**
 * Each ring needs its own tilt hardcoded in the keyframe because CSS
 * custom properties inside @keyframes have limited browser support.
 * We generate per-ring keyframes with the tilt baked in.
 */
function buildPerRingKeyframes(): string {
  return RINGS.map((ring) => {
    const dir = ring.clockwise ? "" : "-";
    const name = `orbital-ring-${ring.size}`;
    return `
      @keyframes ${name} {
        from { transform: translate(-50%, -50%) rotateX(${ring.tiltDeg}deg) rotateZ(0deg); }
        to   { transform: translate(-50%, -50%) rotateX(${ring.tiltDeg}deg) rotateZ(${dir}360deg); }
      }
    `;
  }).join("\n");
}

/**
 * Counter-spin keyframes for labels: cancels the parent ring rotation
 * and un-tilts the text so it remains readable.
 */
function buildLabelCounterKeyframes(): string {
  return RINGS.map((ring) => {
    const dir = ring.clockwise ? "-" : "";
    const name = `orbital-label-${ring.size}`;
    return `
      @keyframes ${name} {
        from { transform: rotateZ(0deg) rotateX(-${ring.tiltDeg}deg); }
        to   { transform: rotateZ(${dir}360deg) rotateX(-${ring.tiltDeg}deg); }
      }
    `;
  }).join("\n");
}

const ALL_KEYFRAMES = [
  buildPerRingKeyframes(),
  buildLabelCounterKeyframes(),
  `
    @keyframes orbital-center-pulse {
      0%, 100% { opacity: 0.7; transform: translate(-50%, -50%) scale(1); }
      50%      { opacity: 1; transform: translate(-50%, -50%) scale(1.06); }
    }
  `,
  `
    @media (max-width: 639px) {
      .orbital-diagram-scale-root {
        transform: scale(0.8);
        transform-origin: center center;
      }
    }
    @media (max-width: 399px) {
      .orbital-diagram-scale-root {
        transform: scale(0.65);
        transform-origin: center center;
      }
    }
  `,
].join("\n");

/* ------------------------------------------------------------------ */
/*  OrbitalRing                                                        */
/* ------------------------------------------------------------------ */

function OrbitalRing({ ring }: { ring: RingConfig }) {
  const ringAnimName = `orbital-ring-${ring.size}`;
  const labelAnimName = `orbital-label-${ring.size}`;

  const radius = ring.size / 2;
  const labelRad = (ring.labelAngle * Math.PI) / 180;
  const labelX = Math.cos(labelRad) * radius;
  const labelY = Math.sin(labelRad) * radius;

  return (
    <div
      className="absolute"
      style={{
        width: ring.size,
        height: ring.size,
        top: "50%",
        left: "50%",
        transform: `translate(-50%, -50%) rotateX(${ring.tiltDeg}deg)`,
        animation: `${ringAnimName} ${ring.duration}s linear infinite`,
        transformStyle: "preserve-3d",
      }}
    >
      {/* Visible ring border */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ border: ring.border }}
      />

      {/* Glowing dots along the circumference */}
      {ring.dots.map((dot, i) => {
        const dotRad = (dot.angle * Math.PI) / 180;
        const x = Math.cos(dotRad) * radius;
        const y = Math.sin(dotRad) * radius;

        return (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              width: 6,
              height: 6,
              backgroundColor: "rgba(52,211,153,0.4)",
              boxShadow: "0 0 8px rgba(52,211,153,0.3)",
              top: "50%",
              left: "50%",
              transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
            }}
          />
        );
      })}

      {/* Label on the ring edge, counter-rotated to stay readable */}
      <span
        className="absolute pointer-events-none select-none"
        style={{
          top: "50%",
          left: "50%",
          transform: `translate(calc(-50% + ${labelX}px), calc(-50% + ${labelY}px))`,
        }}
      >
        <span
          className="block whitespace-nowrap text-neutral-600"
          style={{
            fontSize: 9,
            letterSpacing: "0.15em",
            textTransform: "uppercase" as const,
            animation: `${labelAnimName} ${ring.duration}s linear infinite`,
          }}
        >
          {ring.label}
        </span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function OrbitalDiagram({ className }: OrbitalDiagramProps) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-center orbital-diagram-scale-root",
        className,
      )}
      aria-hidden="true"
    >
      {/* Inject all keyframe animations and responsive media queries */}
      <style>{ALL_KEYFRAMES}</style>

      {/* Perspective container */}
      <div
        className="relative"
        style={{
          width: 360,
          height: 360,
          perspective: "800px",
          transformStyle: "preserve-3d",
        }}
      >
        {/* Subtle radial glow behind the center (rendered first, behind everything) */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: 180,
            height: 180,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            background:
              "radial-gradient(circle, rgba(16,185,129,0.06) 0%, transparent 70%)",
          }}
        />

        {/* Rings -- rendered outer to inner so inner paints on top */}
        {RINGS.map((ring) => (
          <OrbitalRing key={ring.size} ring={ring} />
        ))}

        {/* Center hub -- backdrop-blur circle with FHE label */}
        <div
          className="absolute rounded-full"
          style={{
            width: 100,
            height: 100,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            animation: "orbital-center-pulse 6s ease-in-out infinite",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div className="flex flex-col items-center justify-center h-full">
            <span
              className="font-display font-bold leading-none"
              style={{ color: "#34d399", fontSize: 22 }}
            >
              FHE
            </span>
            <span
              className="text-neutral-500 leading-none mt-1"
              style={{
                fontSize: 10,
                letterSpacing: "0.2em",
                textTransform: "uppercase" as const,
              }}
            >
              Coprocessor
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
