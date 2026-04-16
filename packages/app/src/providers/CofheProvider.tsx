import { useEffect } from "react";
import { useChain } from "./ChainProvider";
import { _resetSdkForChainChange, _setActiveChainForShim } from "@/lib/cofhe-shim";

/**
 * Side-effect provider — no context value. Mounts once at app root.
 * When the user switches chains:
 *   1. Push the new chain id into the cofhe-shim's module-level state so
 *      the next `loadSdk()` picks the right SDK chain (sepolia vs baseSepolia).
 *   2. Blow away the CoFHE SDK singleton so the next encrypt/decrypt call
 *      re-initializes against the new chain's verifier + threshold network
 *      endpoints.
 *
 * Without this, encrypt calls after a chain switch would target the OLD
 * chain's TN, contracts would reject proofs as invalid circuits.
 */
export function CofheProvider({ children }: { children: React.ReactNode }) {
  const { activeChainId } = useChain();

  useEffect(() => {
    _setActiveChainForShim(activeChainId);
    _resetSdkForChainChange();
  }, [activeChainId]);

  return <>{children}</>;
}
