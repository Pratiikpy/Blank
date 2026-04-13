import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  CHAINS,
  SUPPORTED_CHAIN_ID,
  setActiveChainId,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  type SupportedChainId,
} from "@/lib/constants";

// Ordered list for the dropdown — Eth Sepolia is the primary chain with the
// full v0.1.3 feature set; Base Sepolia runs a shield/unshield smoke test only.
const CHAIN_ORDER: SupportedChainId[] = [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID];

export function ChainSelector() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = CHAINS[SUPPORTED_CHAIN_ID];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-3 w-full px-4 py-2.5 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        style={{ background: "transparent", border: "none", cursor: "pointer" }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Network: ${active.name}. Click to switch.`}
      >
        <Globe size={18} className="text-[var(--text-secondary)]" />
        <span className="text-sm text-[var(--text-secondary)] flex-1 text-left">
          {active.shortName}
        </span>
        <ChevronDown
          size={14}
          className={cn(
            "text-[var(--text-tertiary)] transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl bg-white dark:bg-[#1a1a1a] border border-black/10 dark:border-white/10 shadow-lg overflow-hidden z-50"
        >
          {CHAIN_ORDER.map((id) => {
            const chain = CHAINS[id];
            const isActive = id === SUPPORTED_CHAIN_ID;
            return (
              <button
                key={id}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  if (!isActive) setActiveChainId(id);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-center justify-between gap-3 w-full px-4 py-3 text-left transition-colors",
                  "hover:bg-black/5 dark:hover:bg-white/5",
                  isActive && "bg-black/[0.03] dark:bg-white/[0.03]",
                )}
                style={{ background: "transparent", border: "none", cursor: "pointer" }}
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {chain.name}
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    Chain ID {chain.id}
                  </span>
                </div>
                {isActive && <Check size={16} className="text-emerald-600" />}
              </button>
            );
          })}
          <div className="px-4 py-2 border-t border-black/5 dark:border-white/5 text-[11px] text-[var(--text-tertiary)]">
            Switching reloads the page.
          </div>
        </div>
      )}
    </div>
  );
}
