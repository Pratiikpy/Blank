import { useState, useCallback } from "react";
import { useAccount, useWriteContract, useReadContract, usePublicClient } from "wagmi";
import { InheritanceManagerAbi } from "@/lib/abis";
import { CONTRACTS } from "@/lib/constants";
import toast from "react-hot-toast";

interface InheritancePlan {
  heir: string;
  inactivityPeriod: number;
  lastHeartbeat: number;
  claimStartedAt: number;
  active: boolean;
}

export function useInheritance() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [isProcessing, setIsProcessing] = useState(false);

  // Read current plan
  const { data: planData, refetch: refetchPlan } = useReadContract({
    address: CONTRACTS.InheritanceManager,
    abi: InheritanceManagerAbi,
    functionName: "getPlan",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Type assertion: wagmi returns unknown for untyped ABIs; getPlan returns
  // a struct decoded as a tuple [address, uint256, uint256, uint256, bool]
  const planTuple = planData as readonly [string, bigint, bigint, bigint, boolean] | undefined;
  const plan: InheritancePlan | null = planTuple
    ? {
        heir: planTuple[0],
        inactivityPeriod: Number(planTuple[1]),
        lastHeartbeat: Number(planTuple[2]),
        claimStartedAt: Number(planTuple[3]),
        active: planTuple[4],
      }
    : null;

  // Set heir
  const setHeir = useCallback(
    async (heirAddress: string, inactivityDays: number) => {
      if (!address || !publicClient) return;
      setIsProcessing(true);
      try {
        const inactivitySeconds = BigInt(inactivityDays * 86400);
        const hash = await writeContractAsync({
          address: CONTRACTS.InheritanceManager,
          abi: InheritanceManagerAbi,
          functionName: "setHeir",
          args: [heirAddress as `0x${string}`, inactivitySeconds],
        });
        const setHeirReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (setHeirReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        toast.success("Inheritance plan set!");
        await refetchPlan();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to set heir");
      } finally {
        setIsProcessing(false);
      }
    },
    [address, publicClient, writeContractAsync, refetchPlan]
  );

  // Send heartbeat
  const heartbeat = useCallback(async () => {
    if (!address || !publicClient) return;
    setIsProcessing(true);
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.InheritanceManager,
        abi: InheritanceManagerAbi,
        functionName: "heartbeat",
      });
      const heartbeatReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (heartbeatReceipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }
      toast.success("Heartbeat sent!");
      await refetchPlan();
    } catch (err) {
      toast.error("Failed to send heartbeat");
    } finally {
      setIsProcessing(false);
    }
  }, [address, publicClient, writeContractAsync, refetchPlan]);

  // Remove heir
  const removeHeir = useCallback(async () => {
    if (!address || !publicClient) return;
    setIsProcessing(true);
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.InheritanceManager,
        abi: InheritanceManagerAbi,
        functionName: "removeHeir",
      });
      const removeReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (removeReceipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }
      toast.success("Inheritance plan removed");
      await refetchPlan();
    } catch (err) {
      toast.error("Failed to remove heir");
    } finally {
      setIsProcessing(false);
    }
  }, [address, publicClient, writeContractAsync, refetchPlan]);

  // Start claim (as heir)
  const startClaim = useCallback(
    async (ownerAddress: string) => {
      if (!address || !publicClient) return;
      setIsProcessing(true);
      try {
        const hash = await writeContractAsync({
          address: CONTRACTS.InheritanceManager,
          abi: InheritanceManagerAbi,
          functionName: "startClaim",
          args: [ownerAddress as `0x${string}`],
        });
        const claimReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (claimReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        toast.success("Claim started! Wait for the challenge period to finalize.");
        await refetchPlan();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to start claim");
      } finally {
        setIsProcessing(false);
      }
    },
    [address, publicClient, writeContractAsync, refetchPlan]
  );

  // Finalize claim (as heir, after challenge period)
  const finalizeClaim = useCallback(
    async (ownerAddress: string) => {
      if (!address || !publicClient) return;
      setIsProcessing(true);
      try {
        const hash = await writeContractAsync({
          address: CONTRACTS.InheritanceManager,
          abi: InheritanceManagerAbi,
          functionName: "finalizeClaim",
          args: [ownerAddress as `0x${string}`],
        });
        const finalizeReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (finalizeReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        toast.success("Claim finalized! Funds transferred.");
        await refetchPlan();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to finalize claim");
      } finally {
        setIsProcessing(false);
      }
    },
    [address, publicClient, writeContractAsync, refetchPlan]
  );

  return {
    plan,
    isProcessing,
    setHeir,
    heartbeat,
    removeHeir,
    startClaim,
    finalizeClaim,
    refetchPlan,
  };
}
