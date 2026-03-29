import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ScanLine, ClipboardPaste, Check, Camera } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// ── Props ──────────────────────────────────────────────────────────

interface QRScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (data: string) => void;
}

// ── Animation Variants ─────────────────────────────────────────────

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 12 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: "spring" as const,
      stiffness: 300,
      damping: 25,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 12,
    transition: { duration: 0.2 },
  },
};

const cornerVariants = {
  idle: { opacity: 0.6 },
  pulse: {
    opacity: [0.6, 1, 0.6],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: "easeInOut" as const,
    },
  },
};

// ── Helpers ────────────────────────────────────────────────────────

const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/**
 * Extracts a valid Ethereum address from user input.
 * Accepts:
 *  - Raw 0x address
 *  - URL with ?to=0x... query param
 *  - ethereum:0x... URI scheme (EIP-681)
 *  - Any string containing a 0x + 40 hex chars address
 */
function extractAddress(input: string): string | null {
  const trimmed = input.trim();

  // Direct address match
  if (ETH_ADDRESS_REGEX.test(trimmed)) {
    return trimmed;
  }

  // EIP-681: ethereum:0x...
  const eip681Match = trimmed.match(/^ethereum:(0x[0-9a-fA-F]{40})/i);
  if (eip681Match) {
    return eip681Match[1];
  }

  // URL with ?to= param
  try {
    const url = new URL(trimmed);
    const toParam = url.searchParams.get("to");
    if (toParam && ETH_ADDRESS_REGEX.test(toParam)) {
      return toParam;
    }
    // Also check hash params (e.g., ...#/pay?to=0x...)
    if (url.hash.includes("to=")) {
      const hashParams = new URLSearchParams(url.hash.split("?")[1] ?? "");
      const hashTo = hashParams.get("to");
      if (hashTo && ETH_ADDRESS_REGEX.test(hashTo)) {
        return hashTo;
      }
    }
  } catch {
    // Not a URL, continue to fallback
  }

  // Fallback: find any embedded address
  const embeddedMatch = trimmed.match(/(0x[0-9a-fA-F]{40})/);
  if (embeddedMatch) {
    return embeddedMatch[1];
  }

  return null;
}

// ── Corner Bracket SVG ─────────────────────────────────────────────

interface CornerProps {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

function ScanCorner({ position }: CornerProps) {
  const size = 28;
  const stroke = 3;

  const rotations: Record<CornerProps["position"], number> = {
    "top-left": 0,
    "top-right": 90,
    "bottom-right": 180,
    "bottom-left": 270,
  };

  const positions: Record<CornerProps["position"], string> = {
    "top-left": "top-0 left-0",
    "top-right": "top-0 right-0",
    "bottom-right": "bottom-0 right-0",
    "bottom-left": "bottom-0 left-0",
  };

  return (
    <motion.div
      className={cn("absolute", positions[position])}
      variants={cornerVariants}
      initial="idle"
      animate="pulse"
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        fill="none"
        style={{
          transform: `rotate(${rotations[position]}deg)`,
          filter: "drop-shadow(0 0 6px rgba(52, 211, 153, 0.5))",
        }}
      >
        <path
          d={`M ${stroke / 2} ${size} L ${stroke / 2} ${stroke / 2} L ${size} ${stroke / 2}`}
          stroke="#34d399"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </motion.div>
  );
}

// ── Component ──────────────────────────────────────────────────────

export function QRScannerModal({ isOpen, onClose, onScan }: QRScannerModalProps) {
  const [pasteValue, setPasteValue] = useState("");
  const [extractedAddress, setExtractedAddress] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // ── Extract address reactively ──
  useEffect(() => {
    if (!pasteValue.trim()) {
      setExtractedAddress(null);
      setValidationError(null);
      setHasSubmitted(false);
      return;
    }
    const addr = extractAddress(pasteValue);
    setExtractedAddress(addr);
    if (hasSubmitted && !addr) {
      setValidationError("No valid Ethereum address found");
    } else {
      setValidationError(null);
    }
  }, [pasteValue, hasSubmitted]);

  // ── Check camera permission on open ──
  useEffect(() => {
    if (!isOpen) return;
    setCameraError(false);
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => {
        // Got permission, stop the stream immediately (we just needed to check)
        stream.getTracks().forEach((t) => t.stop());
      }).catch(() => {
        setCameraError(true);
      });
    }
  }, [isOpen]);

  // ── Reset state when modal closes ──
  useEffect(() => {
    if (!isOpen) {
      const timer = setTimeout(() => {
        setPasteValue("");
        setExtractedAddress(null);
        setValidationError(null);
        setHasSubmitted(false);
        setCameraError(false);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // ── Focus input on open ──
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => inputRef.current?.focus(), 150);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // ── Escape key to close ──
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  // ── Handlers ──
  const handleSubmit = useCallback(() => {
    setHasSubmitted(true);
    if (!pasteValue.trim()) {
      setValidationError("Please paste an address or payment link");
      return;
    }
    const addr = extractAddress(pasteValue);
    if (!addr) {
      setValidationError("No valid Ethereum address found");
      return;
    }
    onScan(addr);
  }, [pasteValue, onScan]);

  const handlePasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setPasteValue(text);
      }
    } catch {
      // Clipboard API not available or permission denied; user can paste manually
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={{ duration: 0.2 }}
          aria-modal="true"
          role="dialog"
          aria-labelledby="qr-scanner-title"
        >
          {/* ── Backdrop ── */}
          <motion.div
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={handleBackdropClick}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />

          {/* ── Modal Card ── */}
          <motion.div
            ref={modalRef}
            tabIndex={-1}
            className={cn(
              "relative w-full max-w-md",
              "bg-[#0a0a0c] border border-white/[0.06] rounded-3xl p-8",
              "shadow-[0_0_80px_rgba(0,0,0,0.8)]",
              "focus:outline-none",
            )}
            variants={modalVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onAnimationComplete={() => modalRef.current?.focus()}
          >
            {/* ── Close Button ── */}
            <button
              onClick={onClose}
              className={cn(
                "absolute top-4 right-4 p-1.5 rounded-lg z-10",
                "text-neutral-600 hover:text-white hover:bg-white/[0.06]",
                "transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
              )}
              aria-label="Close scanner"
            >
              <X className="w-5 h-5" />
            </button>

            {/* ── Header ── */}
            <div className="text-center mb-6">
              <div
                className={cn(
                  "w-14 h-14 rounded-full mx-auto mb-4",
                  "bg-white/[0.04] border border-white/[0.08]",
                  "flex items-center justify-center",
                )}
              >
                <ScanLine className="w-7 h-7 text-accent" />
              </div>
              <h2
                id="qr-scanner-title"
                className="text-2xl font-semibold text-white"
              >
                Scan QR Code
              </h2>
              <p className="text-sm text-neutral-500 mt-2">
                Scan a payment QR or paste an address below
              </p>
            </div>

            {/* ── Viewfinder Area ── */}
            <div
              className={cn(
                "relative w-full aspect-square max-h-64 mx-auto mb-6",
                "rounded-2xl overflow-hidden",
                "bg-gradient-to-b from-white/[0.03] to-white/[0.01]",
                "border border-white/[0.06]",
              )}
            >
              {/* Dark inner surface */}
              <div className="absolute inset-0 bg-[#050507]" />

              {/* Subtle grid pattern */}
              <div
                className="absolute inset-0 opacity-[0.03]"
                style={{
                  backgroundImage:
                    "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px)," +
                    "linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
                  backgroundSize: "24px 24px",
                }}
              />

              {/* Corner brackets */}
              <div className="absolute inset-6">
                <ScanCorner position="top-left" />
                <ScanCorner position="top-right" />
                <ScanCorner position="bottom-left" />
                <ScanCorner position="bottom-right" />
              </div>

              {/* Scanning line */}
              <motion.div
                className="absolute left-8 right-8 h-px"
                style={{
                  background:
                    "linear-gradient(90deg, transparent, #34d399, transparent)",
                  boxShadow: "0 0 12px 2px rgba(52, 211, 153, 0.3)",
                }}
                initial={{ top: "20%" }}
                animate={{ top: ["20%", "80%", "20%"] }}
                transition={{
                  duration: 3,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />

              {/* Center camera icon / error */}
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                {cameraError ? (
                  <div className="text-center p-4">
                    <Camera className="w-12 h-12 text-neutral-600 mx-auto mb-3" />
                    <p className="text-sm text-white mb-1">Camera access denied</p>
                    <p className="text-xs text-neutral-500 max-w-[200px] mx-auto">
                      Please allow camera access in your browser settings, or paste an address below.
                    </p>
                  </div>
                ) : (
                  <>
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.2, type: "spring", stiffness: 200, damping: 20 }}
                    >
                      <Camera className="w-10 h-10 text-neutral-700" />
                    </motion.div>
                    <span className="text-xs text-neutral-600 font-medium">
                      Point camera at QR code
                    </span>
                  </>
                )}
              </div>

              {/* Vignette overlay */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background:
                    "radial-gradient(ellipse at center, transparent 40%, rgba(5,5,7,0.6) 100%)",
                }}
              />
            </div>

            {/* ── Divider ── */}
            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 h-px bg-white/[0.06]" />
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-600">
                Or paste payment link
              </span>
              <div className="flex-1 h-px bg-white/[0.06]" />
            </div>

            {/* ── Paste Input ── */}
            <div className="space-y-3" onKeyDown={handleKeyDown}>
              <Input
                ref={inputRef}
                label="Address or Payment Link"
                placeholder="0x... or https://..."
                value={pasteValue}
                onChange={(e) => {
                  setPasteValue(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                error={validationError ?? undefined}
                className="font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
                rightElement={
                  <button
                    type="button"
                    onClick={handlePasteFromClipboard}
                    className={cn(
                      "p-1 rounded-md",
                      "text-neutral-600 hover:text-accent",
                      "transition-colors duration-150",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                    )}
                    aria-label="Paste from clipboard"
                    title="Paste from clipboard"
                  >
                    <ClipboardPaste className="w-4 h-4" />
                  </button>
                }
              />

              {/* Address preview when detected */}
              <AnimatePresence>
                {extractedAddress && !validationError && (
                  <motion.div
                    initial={{ opacity: 0, y: -4, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: "auto" }}
                    exit={{ opacity: 0, y: -4, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div
                      className={cn(
                        "flex items-center gap-2 px-3 py-2.5",
                        "rounded-xl border border-emerald-500/20",
                        "bg-emerald-500/[0.06]",
                      )}
                    >
                      <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
                        <Check className="w-3 h-3 text-emerald-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-emerald-400/60 block">
                          Detected Address
                        </span>
                        <span className="text-xs font-mono text-emerald-400 truncate block">
                          {extractedAddress}
                        </span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ── Submit Button ── */}
            <div className="mt-6">
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={handleSubmit}
                disabled={!pasteValue.trim()}
                icon={<ScanLine className="w-4 h-4" />}
              >
                Use This Address
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
