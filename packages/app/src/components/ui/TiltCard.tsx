import { useRef, useState, useCallback } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

interface TiltCardProps {
  children: React.ReactNode;
  className?: string;
  /** Maximum tilt angle in degrees (default: 12) */
  maxTilt?: number;
  /** Peak opacity of the glare highlight (default: 0.15) */
  glareOpacity?: number;
  /** Disable all tilt/glare interactivity */
  disabled?: boolean;
}

// ─── Spring config ──────────────────────────────────────────────────
// Stiffness 150 + damping 20 = smooth return with a gentle, physical feel.
// Lower stiffness than buttons because cards should feel weighty.

const springConfig = { stiffness: 150, damping: 20, mass: 0.8 };

// ─── Component ──────────────────────────────────────────────────────

export function TiltCard({
  children,
  className,
  maxTilt = 12,
  glareOpacity = 0.15,
  disabled = false,
}: TiltCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [isHovering, setIsHovering] = useState(false);

  // Raw motion values from mouse position (updated every frame)
  const rawRotateX = useMotionValue(0);
  const rawRotateY = useMotionValue(0);
  const rawGlareX = useMotionValue(50);
  const rawGlareY = useMotionValue(50);

  // Spring-smoothed rotation — the card never snaps, always glides
  const rotateX = useSpring(rawRotateX, springConfig);
  const rotateY = useSpring(rawRotateY, springConfig);

  // Derive translateZ + shadow from hover state
  const z = useSpring(useMotionValue(0), springConfig);

  // Top-edge highlight shifts with tilt for a parallax lighting effect.
  // When tilted left (rotateY < 0) the highlight shifts right, and vice versa.
  const highlightX = useTransform(rotateY, [-maxTilt, maxTilt], [65, 35]);

  // ── Mouse handlers ──────────────────────────────────────────────

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled || !cardRef.current) return;

      const rect = cardRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // -1 to 1 range from card center
      const normalX = (e.clientX - centerX) / (rect.width / 2);
      const normalY = (e.clientY - centerY) / (rect.height / 2);

      // Clamp to [-1, 1] to avoid extreme angles when cursor is at edge
      const clampedX = Math.max(-1, Math.min(1, normalX));
      const clampedY = Math.max(-1, Math.min(1, normalY));

      // rotateX is inverted: mouse-down = positive Y normal = tilt top toward viewer
      rawRotateX.set(-clampedY * maxTilt);
      rawRotateY.set(clampedX * maxTilt);

      // Glare follows the cursor in 0-100 range
      rawGlareX.set(((e.clientX - rect.left) / rect.width) * 100);
      rawGlareY.set(((e.clientY - rect.top) / rect.height) * 100);
    },
    [disabled, maxTilt, rawRotateX, rawRotateY, rawGlareX, rawGlareY]
  );

  const handleMouseEnter = useCallback(() => {
    if (disabled) return;
    setIsHovering(true);
    z.set(20);
  }, [disabled, z]);

  const handleMouseLeave = useCallback(() => {
    setIsHovering(false);
    // Spring back to flat
    rawRotateX.set(0);
    rawRotateY.set(0);
    rawGlareX.set(50);
    rawGlareY.set(50);
    z.set(0);
  }, [rawRotateX, rawRotateY, rawGlareX, rawGlareY, z]);

  return (
    // Perspective container — must wrap the 3D-transformed card
    <div style={{ perspective: 800 }} className="w-full">
      <motion.div
        ref={cardRef}
        onMouseMove={handleMouseMove}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          rotateX,
          rotateY,
          translateZ: z,
          transformStyle: "preserve-3d",
        }}
        className={cn(
          "relative overflow-hidden rounded-2xl",
          // Glass card surface
          "bg-gradient-to-b from-white/[0.06] to-white/[0.02]",
          "backdrop-blur-2xl",
          "border border-white/[0.08]",
          "ring-1 ring-inset ring-white/[0.05]",
          // Shadow transitions based on hover
          isHovering
            ? "shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_20px_60px_rgba(0,0,0,0.5),0_8px_24px_rgba(0,0,0,0.3)]"
            : "shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_4px_24px_rgba(0,0,0,0.3),0_2px_8px_rgba(0,0,0,0.2)]",
          "transition-shadow duration-300 ease-out",
          className
        )}
      >
        {/* ── Dot-grid pattern overlay ── */}
        <div
          className="pointer-events-none absolute inset-0 z-[1] opacity-[0.05]"
          aria-hidden="true"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.8) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />

        {/* ── Top-edge highlight line ── */}
        {/* Shifts horizontally with tilt for a realistic lighting response */}
        <motion.div
          className="pointer-events-none absolute top-0 left-0 right-0 z-[2] h-px"
          aria-hidden="true"
          style={{
            background: useTransform(
              highlightX,
              (x) =>
                `linear-gradient(90deg, transparent 10%, rgba(255,255,255,0.25) ${x}%, transparent 90%)`
            ),
          }}
        />

        {/* ── Glare / shine overlay ── */}
        {/* Radial gradient centered on cursor, fades out at 60% radius */}
        <motion.div
          className="pointer-events-none absolute inset-0 z-[3] transition-opacity duration-300"
          aria-hidden="true"
          style={{
            opacity: isHovering ? 1 : 0,
            background: useTransform(
              [rawGlareX, rawGlareY] as const,
              ([gx, gy]: number[]) =>
                `radial-gradient(circle at ${gx}% ${gy}%, rgba(255,255,255,${glareOpacity}), transparent 60%)`
            ),
          }}
        />

        {/* ── Content ── */}
        <div className="relative z-[4]">{children}</div>
      </motion.div>
    </div>
  );
}
