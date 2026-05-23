import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import { BlankHandlesAbi } from "@/lib/abis";

// Wave 5 Block 2 — @handle resolver hook.
//
// Resolves a `@handle` (or bare `handle`) to a smart-account address,
// reserves a fresh handle for the caller, and reverse-looks-up the
// active address. Treats address(0) BlankHandles deployment as
// "feature not live on this chain" with an honest error string for
// the screen to render.

export interface HandleRecord {
  handleHash: `0x${string}`;
  owner: `0x${string}`;
  emailDigest: `0x${string}`;
  ensRecord: `0x${string}`;
  createdAt: bigint;
  lastActivityAt: bigint;
}

export interface HandlesDeployInfo {
  status: "live" | "not-deployed";
  address: `0x${string}` | null;
  reason: string | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function stripPrefix(handle: string): string {
  return handle.replace(/^@/, "").trim();
}

export function useHandleResolver() {
  const { effectiveAddress } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWriteAndWait } = useUnifiedWrite();

  const deploy: HandlesDeployInfo = useMemo(() => {
    const addr = contracts.BlankHandles;
    if (!addr || addr === ZERO) {
      return {
        status: "not-deployed",
        address: null,
        reason: "Handles not deployed on this chain. Operator must run pnpm hardhat deploy-blank-handles.",
      };
    }
    return { status: "live", address: addr, reason: null };
  }, [contracts.BlankHandles]);

  const [myHandle, setMyHandle] = useState<string | null>(null);
  const [myHandleHash, setMyHandleHash] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);

  // Reverse lookup my address on mount + when chain/address changes.
  useEffect(() => {
    if (deploy.status !== "live" || !deploy.address || !publicClient || !effectiveAddress) {
      setMyHandle(null);
      setMyHandleHash(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const h = (await publicClient.readContract({
          address: deploy.address!,
          abi: BlankHandlesAbi,
          functionName: "reverseLookup",
          args: [effectiveAddress],
        })) as `0x${string}`;
        if (!cancelled) setMyHandleHash(h && h !== ("0x" + "00".repeat(32) as `0x${string}`) ? h : null);
      } catch (err) {
        console.warn("[useHandleResolver] reverseLookup failed", err);
      }
    })();
    return () => { cancelled = true; };
  }, [deploy.status, deploy.address, publicClient, effectiveAddress]);

  const lookup = useCallback(
    async (rawHandle: string): Promise<HandleRecord | null> => {
      if (deploy.status !== "live" || !deploy.address || !publicClient) return null;
      const handle = stripPrefix(rawHandle);
      if (!handle) return null;
      try {
        const out = (await publicClient.readContract({
          address: deploy.address,
          abi: BlankHandlesAbi,
          functionName: "lookup",
          args: [handle],
        })) as HandleRecord;
        if (!out.owner || out.owner === ZERO) return null;
        return out;
      } catch (err) {
        console.warn("[useHandleResolver] lookup failed", err);
        return null;
      }
    },
    [deploy.status, deploy.address, publicClient],
  );

  const isAvailable = useCallback(
    async (rawHandle: string): Promise<{ ok: boolean; reason?: string }> => {
      if (deploy.status !== "live" || !deploy.address || !publicClient) {
        return { ok: false, reason: deploy.reason ?? "not deployed" };
      }
      const handle = stripPrefix(rawHandle);
      if (!handle) return { ok: false, reason: "empty" };
      try {
        const out = (await publicClient.readContract({
          address: deploy.address,
          abi: BlankHandlesAbi,
          functionName: "isAvailable",
          args: [handle],
        })) as readonly [boolean, string];
        return { ok: out[0], reason: out[1] || undefined };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    [deploy.status, deploy.address, publicClient, deploy.reason],
  );

  const reserve = useCallback(
    async (rawHandle: string, emailDigest?: `0x${string}`) => {
      if (deploy.status !== "live" || !deploy.address) {
        toast.error("Handles not live on this chain yet.");
        return null;
      }
      const handle = stripPrefix(rawHandle);
      if (!handle) {
        toast.error("Handle cannot be empty.");
        return null;
      }
      setBusy(true);
      try {
        const wr = await unifiedWriteAndWait({
          address: deploy.address,
          abi: BlankHandlesAbi,
          functionName: "reserve",
          args: [handle, (emailDigest ?? ("0x" + "00".repeat(32))) as `0x${string}`],
          gas: BigInt(500_000),
        });
        toast.success(`Reserved @${handle}`);
        setMyHandle(handle);
        return wr.hash;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [deploy.status, deploy.address, unifiedWriteAndWait],
  );

  return {
    deploy,
    myHandle,
    myHandleHash,
    lookup,
    isAvailable,
    reserve,
    busy,
  };
}
