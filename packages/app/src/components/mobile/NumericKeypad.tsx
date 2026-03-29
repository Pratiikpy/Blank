import { useCallback } from "react";
import { motion } from "framer-motion";
import { Delete } from "lucide-react";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

interface NumericKeypadProps {
  /** Called when a digit or decimal point is pressed */
  onKey: (key: string) => void;
  /** Called when the backspace/delete key is pressed */
  onBackspace: () => void;
  className?: string;
}

// ─── Key Layout ─────────────────────────────────────────────────────

type KeyDef =
  | { type: "digit"; value: string }
  | { type: "backspace" };

const ROWS: KeyDef[][] = [
  [{ type: "digit", value: "1" }, { type: "digit", value: "2" }, { type: "digit", value: "3" }],
  [{ type: "digit", value: "4" }, { type: "digit", value: "5" }, { type: "digit", value: "6" }],
  [{ type: "digit", value: "7" }, { type: "digit", value: "8" }, { type: "digit", value: "9" }],
  [{ type: "digit", value: "." }, { type: "digit", value: "0" }, { type: "backspace" }],
];

// ─── Spring config ──────────────────────────────────────────────────

const tapTransition = {
  type: "spring" as const,
  stiffness: 500,
  damping: 25,
};

// ─── Component ──────────────────────────────────────────────────────

export function NumericKeypad({ onKey, onBackspace, className }: NumericKeypadProps) {
  const handlePress = useCallback(
    (keyDef: KeyDef) => {
      if (keyDef.type === "backspace") {
        onBackspace();
      } else {
        onKey(keyDef.value);
      }
    },
    [onKey, onBackspace]
  );

  return (
    <div
      className={cn(
        // Glass surface behind the entire keypad
        "rounded-3xl p-3",
        "bg-gradient-to-b from-white/[0.04] to-white/[0.015]",
        "backdrop-blur-xl",
        "border border-white/[0.06]",
        "ring-1 ring-inset ring-white/[0.03]",
        className
      )}
      role="group"
      aria-label="Numeric keypad"
    >
      <div className="grid grid-cols-3 gap-2">
        {ROWS.flat().map((keyDef, index) => {
          const isBackspace = keyDef.type === "backspace";
          const label = isBackspace ? "Delete" : keyDef.value;

          return (
            <motion.button
              key={isBackspace ? "backspace" : keyDef.value + "-" + index}
              type="button"
              aria-label={isBackspace ? "Backspace" : `${keyDef.value}`}
              onClick={() => handlePress(keyDef)}
              // ── Press feedback: shrink + subtle bg flash ──
              whileTap={{
                scale: 0.92,
                backgroundColor: "rgba(255, 255, 255, 0.08)",
                transition: tapTransition,
              }}
              className={cn(
                // Base key style
                "h-16 rounded-2xl",
                "flex items-center justify-center",
                "select-none cursor-pointer",
                // Dark glass key background
                "bg-white/[0.03]",
                "border border-white/[0.05]",
                // Hover glow
                "hover:bg-white/[0.06] hover:border-white/[0.08]",
                "transition-colors duration-150",
                // Focus ring for keyboard nav
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-void",
                // Text
                "font-mono text-2xl font-medium text-white",
                // Backspace key gets muted styling
                isBackspace && "text-neutral-400"
              )}
            >
              {isBackspace ? (
                <Delete className="h-6 w-6" strokeWidth={1.5} />
              ) : (
                <span className="tabular-nums">{label}</span>
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
