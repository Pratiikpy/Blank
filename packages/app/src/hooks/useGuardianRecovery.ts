import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import { GuardianModuleAbi } from "@/lib/abis";

// Wave 5 Block 3 — guardian recovery hook.
//
// Wraps the GuardianModule contract calls:
//   - configure: addGuardian / removeGuardian / setThreshold
//   - request:   requestRecovery / approveRecovery / vetoRecovery
//   - resolve:   cancelRecovery / finalizeRecovery
//   - reads:     guardiansOf / thresholdOf / recoveryState
//
// Address-aware: when GuardianModule isn't deployed on the active
// chain, deploy.status is "not-deployed" and the consumers should
// render the operator banner.

export interface RecoveryState {
  newOwner: `0x${string}`;
  requestedAt: number;
  approvals: number;
  vetoed: boolean;
  finalized: boolean;
}

export interface GuardianDeployInfo {
  status: "live" | "not-deployed";
  address: `0x${string}` | null;
  reason: string | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function useGuardianRecovery() {
  const { effectiveAddress } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWriteAndWait } = useUnifiedWrite();

  const deploy: GuardianDeployInfo = useMemo(() => {
    const addr = contracts.GuardianModule;
    if (!addr || addr === ZERO) {
      return {
        status: "not-deployed",
        address: null,
        reason: "Guardian recovery not deployed on this chain. Operator must run pnpm hardhat deploy-guardian-module.",
      };
    }
    return { status: "live", address: addr, reason: null };
  }, [contracts.GuardianModule]);

  const [guardians, setGuardians] = useState<`0x${string}`[]>([]);
  const [threshold, setThresholdState] = useState<number>(0);
  const [activeRequest, setActiveRequest] = useState<RecoveryState | null>(null);
  const [windowSec, setWindowSec] = useState<number>(0);

  const refresh = useCallback(async (account?: `0x${string}`) => {
    const target = account ?? effectiveAddress;
    if (deploy.status !== "live" || !deploy.address || !publicClient || !target) {
      setGuardians([]);
      setThresholdState(0);
      setActiveRequest(null);
      return;
    }
    try {
      const [gs, th, st, win] = await Promise.all([
        publicClient.readContract({
          address: deploy.address, abi: GuardianModuleAbi,
          functionName: "guardiansOf", args: [target],
        }) as Promise<readonly `0x${string}`[]>,
        publicClient.readContract({
          address: deploy.address, abi: GuardianModuleAbi,
          functionName: "thresholdOf", args: [target],
        }) as Promise<number>,
        publicClient.readContract({
          address: deploy.address, abi: GuardianModuleAbi,
          functionName: "recoveryState", args: [target],
        }) as Promise<readonly [`0x${string}`, number, number, boolean, boolean]>,
        publicClient.readContract({
          address: deploy.address, abi: GuardianModuleAbi,
          functionName: "RECOVERY_WINDOW_SECONDS",
        }) as Promise<number>,
      ]);
      setGuardians([...gs]);
      setThresholdState(Number(th));
      setActiveRequest({
        newOwner: st[0], requestedAt: Number(st[1]), approvals: Number(st[2]),
        vetoed: st[3], finalized: st[4],
      });
      setWindowSec(Number(win));
    } catch (err) {
      console.warn("[useGuardianRecovery] refresh failed", err);
    }
  }, [deploy.status, deploy.address, publicClient, effectiveAddress]);

  useEffect(() => { refresh(); }, [refresh]);

  // Write helpers
  const call = useCallback(async (
    functionName: "addGuardian" | "removeGuardian" | "setThreshold" |
                  "requestRecovery" | "approveRecovery" | "vetoRecovery" |
                  "cancelRecovery" | "finalizeRecovery",
    args: any[],
  ) => {
    if (deploy.status !== "live" || !deploy.address) {
      toast.error("Guardian recovery not live on this chain yet.");
      return null;
    }
    try {
      const wr = await unifiedWriteAndWait({
        address: deploy.address,
        abi: GuardianModuleAbi,
        functionName,
        args,
        gas: BigInt(500_000),
      });
      await refresh();
      return wr.hash;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [deploy.status, deploy.address, unifiedWriteAndWait, refresh]);

  return {
    deploy,
    guardians,
    threshold,
    activeRequest,
    windowSec,
    refresh,
    addGuardian: (g: `0x${string}`) => call("addGuardian", [g]),
    removeGuardian: (g: `0x${string}`) => call("removeGuardian", [g]),
    setThreshold: (t: number) => call("setThreshold", [t]),
    requestRecovery: (acct: `0x${string}`, newOwner: `0x${string}`) => call("requestRecovery", [acct, newOwner]),
    approveRecovery: (acct: `0x${string}`) => call("approveRecovery", [acct]),
    vetoRecovery: (acct: `0x${string}`) => call("vetoRecovery", [acct]),
    cancelRecovery: () => call("cancelRecovery", []),
    finalizeRecovery: (acct: `0x${string}`) => call("finalizeRecovery", [acct]),
  };
}
