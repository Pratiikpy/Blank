// What the smart account can spend on its own gas: its EntryPoint deposit
// plus plain ETH on the account (BaseAccount._payPrefund sends ETH when the
// deposit falls short). The security-v1 and gas-wallet implementations
// auto-deposit incoming ETH, so most of it shows up as deposit, which
// useBalance alone never sees.
//
// Account settings changes (upgrade, enableValidator, setRecoveryModule)
// are never sponsored, so their UI gates on this.

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";
import { useChain } from "@/providers/ChainProvider";
import { ENTRYPOINT_ABI, ENTRYPOINT_V08 } from "@/lib/userop";

/** Prefund for a self-paid settings change at the buildUserOp defaults:
 *  (2M verification + 600k call + 100k preVerification) x 1 gwei. */
export const SELF_PAID_SETTINGS_OP_WEI = 2_700_000n * 1_000_000_000n;

export interface AccountGasFunds {
  totalWei: bigint | null;
  depositWei: bigint | null;
  idleWei: bigint | null;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
}

export function useAccountGasFunds(address: Address | null | undefined): AccountGasFunds {
  const { activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const query = useQuery({
    queryKey: ["account-gas-funds", activeChainId, address ?? "none"],
    enabled: !!publicClient && !!address,
    queryFn: async () => {
      if (!publicClient || !address) throw new Error("no client");
      const [deposit, idle] = await Promise.all([
        publicClient.readContract({
          address: ENTRYPOINT_V08,
          abi: ENTRYPOINT_ABI,
          functionName: "balanceOf",
          args: [address],
        }) as Promise<bigint>,
        publicClient.getBalance({ address }),
      ]);
      return { deposit, idle };
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const depositWei = query.data?.deposit ?? null;
  const idleWei = query.data?.idle ?? null;
  return {
    depositWei,
    idleWei,
    totalWei: depositWei !== null && idleWei !== null ? depositWei + idleWei : null,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
