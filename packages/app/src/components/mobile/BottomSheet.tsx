import { useEffect, useCallback, useRef } from "react";
import {
  motion,
  AnimatePresence,
  type PanInfo,
  useMotionValue,
  useTransform,
  useAnimation,
} from "framer-motion";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

type SnapPoint = "half" | "full";

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  snapPoints?: SnapPoint[];
}

// ─── Constants ──────────────────────────────────────────────────────

const DISMISS_OFFSET_THRESHOLD = 100;
const DISMISS_VELOCITY_THRESHOLD = 500;

const SNAP_HEIGHTS: Record<SnapPoint, string> = {
  half: "50dvh",
  full: "calc(100dvh - 40px)",
};

// ─── Spring presets ─────────────────────────────────────────────────

const sheetSpring = {
  type: "spring" as const,
  stiffness: 350,
  damping: 30,
};

// ─── Component ──────────────────────────────────────────────────────

export function BottomSheet({
  isOpen,
  onClose,
  children,
  title,
  snapPoints = ["half", "full"],
}: BottomSheetProps) {
  const controls = useAnimation();
  const dragY = useMotionValue(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Backdrop fades out as the sheet is dragged down
  const backdropOpacity = useTransform(dragY, [0, 300], [0.6, 0]);

  // Determine height from the first snap point
  const initialSnap = snapPoints[0] || "half";
  const sheetHeight = SNAP_HEIGHTS[initialSnap];

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Handle drag end — dismiss or snap back
  const handleDragEnd = useCallback(
    (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      const shouldDismiss =
        info.offset.y > DISMISS_OFFSET_THRESHOLD ||
        info.velocity.y > DISMISS_VELOCITY_THRESHOLD;

      if (shouldDismiss) {
        onClose();
      } else {
        // Snap back to resting position
        controls.start({ y: 0, transition: sheetSpring });
      }
    },
    [onClose, controls]
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          {/* ── Backdrop ── */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 bg-black"
            style={{ opacity: backdropOpacity }}
            onClick={onClose}
            aria-label="Close bottom sheet"
          />

          {/* ── Sheet ── */}
          <motion.div
            ref={sheetRef}
            tabIndex={-1}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={sheetSpring}
            drag="y"
            dragConstraints={{ top: 0 }}
            dragElastic={0.1}
            onDragEnd={handleDragEnd}
            onAnimationComplete={() => sheetRef.current?.focus()}
            className={cn(
              "focus:outline-none",
              "absolute bottom-0 left-0 right-0",
              "flex flex-col",
              "rounded-t-3xl overflow-hidden",
              // Glass elevated background
              "backdrop-blur-3xl border-t border-white/[0.12]",
              "ring-1 ring-inset ring-white/[0.06]",
              // Multi-layer shadow for depth
              "shadow-[0_-8px_32px_rgba(0,0,0,0.5),0_-2px_8px_rgba(0,0,0,0.3)]",
              // Safe area padding at bottom
              "pb-[env(safe-area-inset-bottom)]"
            )}
            style={{
              y: dragY,
              height: sheetHeight,
              background:
                "linear-gradient(to bottom, rgba(26, 26, 31, 0.97) 0%, rgba(19, 19, 22, 0.98) 100%)",
            }}
          >
            {/* ── Drag handle ── */}
            <div className="flex justify-center pt-3 pb-1 shrink-0">
              <div
                className={cn(
                  "w-8 h-1 rounded-full",
                  "bg-white/[0.20]",
                  "transition-colors duration-150",
                  "hover:bg-white/[0.35] active:bg-white/[0.40]"
                )}
                aria-hidden="true"
              />
            </div>

            {/* ── Title bar (if title provided) ── */}
            {title && (
              <div className="px-6 pt-2 pb-4 shrink-0">
                <h2 className="text-heading-3 font-semibold text-text-primary text-center">
                  {title}
                </h2>
              </div>
            )}

            {/* ── Content area (scrollable) ── */}
            <div
              className={cn(
                "flex-1 min-h-0 overflow-y-auto overscroll-contain",
                "px-6 pb-6",
                !title && "pt-2"
              )}
            >
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
