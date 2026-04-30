// Phase 4.1 — proxy implementation version detector.
//
// BlankAccountFactory's `accountImplementation` is `immutable`, so changing
// the implementation requires per-proxy UUPS upgrades. This hook reads the
// EIP-1967 _IMPLEMENTATION_SLOT from the user's proxy and compares against
// `contracts.BlankAccount_Impl_v041` (the canonical v041 impl with validator
// dispatch). Returns enough state for an UpgradeBanner to:
//
//   • Hide entirely when the user has no AA, when the new impl isn't
//     deployed on the chain, OR when the proxy is ALREADY on v041.
//   • Surface a "Upgrade your account" CTA otherwise.
//
// EIP-1967 implementation slot:
//   keccak256("eip1967.proxy.implementation") - 1
//   = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
// Stored as a `bytes32` whose low 20 bytes are the impl address.

import { useQuery } from "@tanstack/react-query";
import { type Address, getAddress, hexToBigInt, slice } from "viem";
import { usePublicClient } from "wagmi";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";

const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

export type AccountVersionStatus =
  | "unknown" // hook hasn't loaded yet
  | "no-account" // user has no AA proxy on this chain
  | "no-canonical" // BlankAccount_Impl_v041 not deployed on this chain
  | "not-deployed" // proxy address has no code yet (counterfactual)
  | "current" // proxy points at canonical v041 impl
  | "needs-upgrade"; // proxy points at OLD impl — UpgradeBanner shows

export interface AccountVersion {
  status: AccountVersionStatus;
  /** The implementation address actually stored in the user's proxy. */
  currentImpl: Address | null;
  /** The canonical v041 impl address from constants. address(0) when the
   *  operator hasn't run the upgrade-deploy task on this chain yet. */
  canonicalImpl: Address;
  /** True while the public-RPC slot read is in flight. */
  isLoading: boolean;
  /** Last fetch error. Surfaced for debugging; UI typically tolerates
   *  failures by falling back to "unknown" status. */
  error: string | null;
}

export function useAccountVersion(): AccountVersion {
  const { effectiveAddress, isSmartAccount } = useEffectiveAddress();
  const { activeChainId, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const canonicalImpl = (contracts.BlankAccount_Impl_v041 ?? ZERO_ADDR) as Address;
  const canonicalDeployed = canonicalImpl !== ZERO_ADDR;

  const query = useQuery({
    queryKey: [
      "blank-account-impl",
      activeChainId,
      effectiveAddress ?? "none",
      isSmartAccount ? "aa" : "eoa",
      canonicalImpl,
    ],
    enabled:
      isSmartAccount && !!effectiveAddress && !!publicClient && canonicalDeployed,
    queryFn: async (): Promise<{
      status: AccountVersionStatus;
      currentImpl: Address | null;
    }> => {
      if (!publicClient || !effectiveAddress) {
        return { status: "unknown", currentImpl: null };
      }
      // Counterfactual proxies have no code yet — getCode returns "0x".
      const code = await publicClient.getCode({ address: effectiveAddress as Address });
      if (!code || code === "0x") {
        // No proxy deployed yet → no impl stored. After first UserOp
        // deploys the proxy via factory it'll point at the OLD impl
        // baked into the factory's immutable. We surface "not-deployed"
        // so the UpgradeBanner can hold off until then.
        return { status: "not-deployed", currentImpl: null };
      }
      const raw = await publicClient.getStorageAt({
        address: effectiveAddress as Address,
        slot: EIP1967_IMPL_SLOT,
      });
      if (!raw) {
        return { status: "unknown", currentImpl: null };
      }
      const lowBytes = slice(raw, 12); // 32-byte slot → low 20 bytes = address
      if (hexToBigInt(lowBytes) === 0n) {
        return { status: "unknown", currentImpl: null };
      }
      const impl = getAddress(lowBytes);
      if (impl.toLowerCase() === canonicalImpl.toLowerCase()) {
        return { status: "current", currentImpl: impl };
      }
      return { status: "needs-upgrade", currentImpl: impl };
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  // Derive status from outer constraints if the query never enabled.
  let status: AccountVersionStatus;
  if (!isSmartAccount || !effectiveAddress) {
    status = "no-account";
  } else if (!canonicalDeployed) {
    status = "no-canonical";
  } else if (query.isLoading) {
    status = "unknown";
  } else if (query.data) {
    status = query.data.status;
  } else {
    status = "unknown";
  }

  return {
    status,
    currentImpl: query.data?.currentImpl ?? null,
    canonicalImpl,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
  };
}
