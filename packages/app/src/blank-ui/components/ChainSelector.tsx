import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  CHAINS,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  type SupportedChainId,
} from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";

const CHAIN_ORDER: SupportedChainId[] = [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID];

export function ChainSelector() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { activeChainId, setActiveChain } = useChain();
  // #323: picking a chain while disconnected is a silent no-op — the user
  // clicks, nothing happens because there's no wallet to signal. Disable
  // the button and explain why in its aria-label so screen readers help out.
  // Passkey smart accounts count as "connected" even though wagmi doesn't
  // know about them; gate on effectiveAddress, not wagmi's isConnected.
  const { effectiveAddress, isSmartAccount } = useEffectiveAddress();
  const isConnected = Boolean(effectiveAddress);

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

  const active = CHAINS[activeChainId];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { if (isConnected) setOpen((v) => !v); }}
        disabled={!isConnected}
        className={cn(
          "flex items-center gap-3 w-full px-4 py-2.5 rounded-full transition-colors",
          isConnected
            ? "hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
            : "opacity-40 cursor-not-allowed",
        )}
        style={{ background: "transparent", border: "none" }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          isConnected
            ? `Network: ${active.name}. Click to switch.`
            : `Network: ${active.name}. Connect a wallet to switch chains.`
        }
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
            const isActive = id === activeChainId;
            // Passkey wallets only exist on one chain — switching would
            // drop the user to Onboarding. Disable the other chain.
            const disabled = !isActive && isSmartAccount;
            return (
              <button
                key={id}
                role="option"
                aria-selected={isActive}
                disabled={disabled}
                onClick={() => {
                  if (!isActive && !disabled) setActiveChain(id);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-center justify-between gap-3 w-full px-4 py-3 text-left transition-colors",
                  disabled
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer",
                  isActive && "bg-black/[0.03] dark:bg-white/[0.03]",
                )}
                style={{ background: "transparent", border: "none" }}
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {chain.name}
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {disabled ? "Passkey wallet on other chain" : `Chain ID ${chain.id}`}
                  </span>
                </div>
                {isActive && <Check size={16} className="text-emerald-600" />}
              </button>
            );
          })}
          {isSmartAccount && (
            <div className="px-4 py-2 border-t border-black/5 dark:border-white/5 text-[11px] text-[var(--text-tertiary)]">
              Passkey wallets are chain-specific. Connect MetaMask to use other chains.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
