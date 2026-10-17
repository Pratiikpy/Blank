// Whether BlankPaymaster will sponsor one of the account's own settings
// calls. The paymaster sponsors a call into the sender only for:
//   upgradeToAndCall(impl, "")  impl in approvedImplementations
//   enableValidator(v)          v    in approvedValidators
//   setRecoveryModule(m)        m    in approvedRecoveryModules
// The sponsor route (/api/paymaster/sponsor) checks the same views before
// it signs. Screens use this to enable those actions for accounts with no
// ETH; when it is false they keep the self-paid path and its gas gate.

import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";
import { usePublicClient } from "wagmi";
import { useChain } from "@/providers/ChainProvider";
import { usePaymasterHealth } from "@/hooks/usePaymasterHealth";

export type SelfCallKind = "implementation" | "validator" | "recoveryModule";

const VIEW: Record<SelfCallKind, "approvedImplementations" | "approvedValidators" | "approvedRecoveryModules"> = {
  implementation: "approvedImplementations",
  validator: "approvedValidators",
  recoveryModule: "approvedRecoveryModules",
};

const PaymasterSelfCallAbi = [
  { type: "function", name: "approvedImplementations", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "approvedValidators", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "approvedRecoveryModules", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

/** true: sponsored. false: not sponsored (pay from the account). null: still loading. */
export function useSelfCallSponsorship(kind: SelfCallKind, address: Address | string | undefined | null): boolean | null {
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const health = usePaymasterHealth();
  const paymaster = contracts.BlankPaymaster as Address | undefined;
  const target = address && address !== ZERO ? (address as Address) : undefined;

  const query = useQuery({
    queryKey: ["paymaster-self-call", activeChainId, paymaster ?? "none", kind, target ?? "none"],
    enabled: !!publicClient && !!paymaster && !!target,
    queryFn: async (): Promise<boolean> => {
      try {
        return (await publicClient!.readContract({
          address: paymaster!,
          abi: PaymasterSelfCallAbi,
          functionName: VIEW[kind],
          args: [target!],
        })) as boolean;
      } catch {
        // A paymaster deployed before self-call approvals has no such view.
        return false;
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  if (!paymaster || !target) return false;
  if (health.status === "unavailable") return false;
  if (query.data === undefined || health.status === "unknown") return query.isError ? false : null;
  return query.data;
}
