import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";
import { encodeAbiParameters, keccak256, type Hex } from "viem";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import { GuardianModuleAbi } from "@/lib/abis";

// Guardian recovery hook.
//
// Wraps the GuardianModule contract calls:
//   - configure: addGuardian / removeGuardian / setThreshold
//   - request:   requestRecovery(account, newOwnerX, newOwnerY) commits the
//                hash of the recovering user's NEW passkey; approve / veto
//   - resolve:   cancelRecovery (by the account) /
//                finalizeRecoveryAndRotate(account, X, Y) by an approving
//                guardian once the window has passed and the threshold met.
//                The key must match the committed hash; the account's owner
//                key then rotates to it.
//   - reads:     guardiansOf / thresholdOf / recoveryState / recoveryKeyHash /
//                vetoQuorum / effectiveRecoveryWindow / hasApproved / hasVetoed
//
// A veto needs vetoQuorum guardians (enough that the threshold can no longer
// be reached), not one. The window is at least 24 hours on-chain.

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

/** A recovering user's new passkey public key. */
export interface RecoveryKey {
  x: bigint;
  y: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const RECOVERY_KEY_PREFIX = "blank-recovery-key:";

/** keccak256(abi.encode(x, y)), the value GuardianModule commits. */
export function recoveryKeyHashOf(key: RecoveryKey): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [key.x, key.y]));
}

/** Shareable text form of a new passkey: blank-recovery-key:<x hex>:<y hex>. */
export function formatRecoveryKey(key: RecoveryKey): string {
  const h = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  return `${RECOVERY_KEY_PREFIX}${h(key.x)}:${h(key.y)}`;
}

/** Parse the shareable form, or a bare "<x>:<y>" pair. Null when malformed. */
export function parseRecoveryKey(text: string): RecoveryKey | null {
  const t = text.trim().replace(new RegExp(`^${RECOVERY_KEY_PREFIX}`), "");
  const m = /^(0x[0-9a-fA-F]{1,64}):(0x[0-9a-fA-F]{1,64})$/.exec(t);
  if (!m) return null;
  const x = BigInt(m[1]);
  const y = BigInt(m[2]);
  if (x === 0n && y === 0n) return null;
  return { x, y };
}

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
  const [committedKeyHash, setCommittedKeyHash] = useState<Hex | null>(null);
  const [vetoQuorum, setVetoQuorum] = useState<number>(0);
  const [myApproval, setMyApproval] = useState<{ approved: boolean; vetoed: boolean }>({ approved: false, vetoed: false });

  const refresh = useCallback(async (account?: `0x${string}`) => {
    const target = account ?? effectiveAddress;
    if (deploy.status !== "live" || !deploy.address || !publicClient || !target) {
      setGuardians([]);
      setThresholdState(0);
      setActiveRequest(null);
      setCommittedKeyHash(null);
      return;
    }
    const read = <T,>(functionName: string, args: readonly unknown[] = []) =>
      publicClient.readContract({
        address: deploy.address!, abi: GuardianModuleAbi,
        functionName: functionName as never, args: args as never,
      }) as Promise<T>;
    try {
      const [gs, th, st, win, keyHash, quorum] = await Promise.all([
        read<readonly `0x${string}`[]>("guardiansOf", [target]),
        read<number>("thresholdOf", [target]),
        read<readonly [`0x${string}`, number, number, boolean, boolean]>("recoveryState", [target]),
        read<number>("effectiveRecoveryWindow"),
        read<Hex>("recoveryKeyHash", [target]),
        read<bigint>("vetoQuorum", [target]),
      ]);
      setGuardians([...gs]);
      setThresholdState(Number(th));
      setActiveRequest({
        newOwner: st[0], requestedAt: Number(st[1]), approvals: Number(st[2]),
        vetoed: st[3], finalized: st[4],
      });
      setWindowSec(Number(win));
      setCommittedKeyHash(keyHash === ZERO_HASH ? null : keyHash);
      setVetoQuorum(Number(quorum));
      if (effectiveAddress) {
        const [approved, vetoed] = await Promise.all([
          read<boolean>("hasApproved", [target, effectiveAddress]),
          read<boolean>("hasVetoed", [target, effectiveAddress]),
        ]);
        setMyApproval({ approved, vetoed });
      } else {
        setMyApproval({ approved: false, vetoed: false });
      }
    } catch (err) {
      console.warn("[useGuardianRecovery] refresh failed", err);
    }
  }, [deploy.status, deploy.address, publicClient, effectiveAddress]);

  useEffect(() => { refresh(); }, [refresh]);

  const call = useCallback(async (
    functionName: "addGuardian" | "removeGuardian" | "setThreshold" |
                  "requestRecovery" | "approveRecovery" | "vetoRecovery" |
                  "cancelRecovery" | "finalizeRecoveryAndRotate",
    args: readonly unknown[],
    refreshFor?: `0x${string}`,
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
        args: args as never,
        gas: BigInt(500_000),
      });
      await refresh(refreshFor);
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
    committedKeyHash,
    vetoQuorum,
    myApproval,
    refresh,
    addGuardian: (g: `0x${string}`) => call("addGuardian", [g]),
    removeGuardian: (g: `0x${string}`) => call("removeGuardian", [g]),
    setThreshold: (t: number) => call("setThreshold", [t]),
    requestRecovery: (acct: `0x${string}`, key: RecoveryKey) =>
      call("requestRecovery", [acct, key.x, key.y], acct),
    approveRecovery: (acct: `0x${string}`) => call("approveRecovery", [acct], acct),
    vetoRecovery: (acct: `0x${string}`) => call("vetoRecovery", [acct], acct),
    cancelRecovery: () => call("cancelRecovery", []),
    /** Rotate the account's owner to `key`. Must match the committed hash. */
    finalizeRecovery: (acct: `0x${string}`, key: RecoveryKey) =>
      call("finalizeRecoveryAndRotate", [acct, key.x, key.y], acct),
  };
}
