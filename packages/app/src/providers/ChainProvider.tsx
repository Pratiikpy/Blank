import { createContext, useContext, useState, useCallback, useEffect } from "react";
import {
  CHAINS,
  CONTRACTS_BY_CHAIN,
  SUPPORTED_CHAIN_ID,
  type SupportedChainId,
  type ChainInfo,
  type ContractMap,
} from "@/lib/constants";
import { STORAGE_KEYS, setStoredString } from "@/lib/storage";
import { setSupabaseActiveChain } from "@/lib/supabase";

interface ChainContextValue {
  activeChainId: SupportedChainId;
  activeChain: ChainInfo;
  contracts: ContractMap;
  /**
   * Switch to a different chain. Currently still reloads the page because
   * many hooks import SUPPORTED_CHAIN_ID / CONTRACTS directly from
   * @/lib/constants (captured at module load). Once all hooks migrate to
   * useChain(), flip `RELOAD_ON_SWITCH` to false for reload-free switching.
   */
  setActiveChain: (id: SupportedChainId) => void;
  availableChains: ChainInfo[];
}

// Layer 4 complete — every runtime consumer of chain state (hooks, screens,
// cofhe-shim) reads via useChain() / _setActiveChainForShim. Chain switches
// now propagate via React re-render without a page reload.
const RELOAD_ON_SWITCH = false;

const ChainContext = createContext<ChainContextValue | null>(null);

export function useChain(): ChainContextValue {
  const ctx = useContext(ChainContext);
  if (!ctx) throw new Error("useChain must be used inside <ChainProvider>");
  return ctx;
}

export function ChainProvider({ children }: { children: React.ReactNode }) {
  const [activeChainId, setActiveChainIdState] = useState<SupportedChainId>(SUPPORTED_CHAIN_ID);

  const setActiveChain = useCallback((id: SupportedChainId) => {
    if (!(id in CHAINS)) return;
    setStoredString(STORAGE_KEYS.activeChainId(), String(id));
    setActiveChainIdState(id);
    if (RELOAD_ON_SWITCH && typeof window !== "undefined") {
      window.location.reload();
    }
  }, []);

  // Keep state synced with localStorage across tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEYS.activeChainId()) return;
      const parsed = Number(e.newValue);
      if (parsed in CHAINS) setActiveChainIdState(parsed as SupportedChainId);
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    }
  }, []);

  // Keep the module-level supabase chain ref in sync so insertActivity
  // calls made outside React (e.g. in async handlers) default to the
  // correct chain after a reload-free switch.
  useEffect(() => {
    setSupabaseActiveChain(activeChainId);
  }, [activeChainId]);

  const activeChain = CHAINS[activeChainId];
  const contracts = CONTRACTS_BY_CHAIN[activeChainId];
  const availableChains = Object.values(CHAINS);

  return (
    <ChainContext.Provider value={{ activeChainId, activeChain, contracts, setActiveChain, availableChains }}>
      {children}
    </ChainContext.Provider>
  );
}
