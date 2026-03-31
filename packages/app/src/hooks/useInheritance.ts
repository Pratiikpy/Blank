import { useState, useCallback } from "react";
import { useAccount, useWriteContract, useReadContract, usePublicClient } from "wagmi";
import { sepolia } from "viem/chains";
import { useCofheEncryptAndWriteContract } from "@cofhe/react";
import { InheritanceManagerAbi } from "@/lib/abis";
import { CONTRACTS } from "@/lib/constants";
import toast from "react-hot-toast";

const MAX_UINT64 = BigInt("18446744073709551615"); // type(uint64).max

interface InheritancePlan {
  heir: string;
  inactivityPeriod: number;
  lastHeartbeat: number;
  claimStartedAt: number;
  active: boolean;
  vaults: string[];
}

export function useInheritance() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [isProcessing, setIsProcessing] = useState(false);

  // Atomic encrypt + write for finalizeClaim (encrypted InEuint64[] amounts)
  const { encryptAndWrite } = useCofheEncryptAndWriteContract();

  // Read current plan
  const { data: planData, refetch: refetchPlan } = useReadContract({
    address: CONTRACTS.InheritanceManager,
    abi: InheritanceManagerAbi,
    functionName: "getPlan",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 60_000 },
  });

  // Type assertion: wagmi returns unknown for untyped ABIs; getPlan returns
  // a struct decoded as a tuple [address, uint256, uint256, uint256, bool, address[]]
  const planTuple = planData as readonly [string, bigint, bigint, bigint, boolean, readonly string[]] | undefined;
  const plan: InheritancePlan | null = planTuple
    ? {
        heir: planTuple[0],
        inactivityPeriod: Number(planTuple[1]),
        lastHeartbeat: Number(planTuple[2]),
        claimStartedAt: Number(planTuple[3]),
        active: planTuple[4],
        vaults: [...planTuple[5]],
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
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
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
        gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
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
        gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
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

  // Set vaults protected by the inheritance plan
  const setVaults = useCallback(
    async (vaultAddresses: string[]) => {
      if (!address || !publicClient) return;
      setIsProcessing(true);
      try {
        const hash = await writeContractAsync({
          address: CONTRACTS.InheritanceManager,
          abi: InheritanceManagerAbi,
          functionName: "setVaults",
          args: [vaultAddresses as `0x${string}`[]],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        toast.success("Vaults updated for inheritance plan!");
        await refetchPlan();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to set vaults");
      } finally {
        setIsProcessing(false);
      }
    },
    [address, publicClient, writeContractAsync, refetchPlan]
  );

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
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
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
  // Reads the owner's plan to get the vault list, encrypts type(uint64).max for each vault
  // (to drain the full balance), and calls finalizeClaim with the encrypted amounts.
  const finalizeClaim = useCallback(
    async (ownerAddress: string, vaultCount: number) => {
      if (!address || !publicClient) return;
      if (vaultCount === 0) {
        toast.error("No vaults configured in the owner's inheritance plan");
        return;
      }
      setIsProcessing(true);
      try {
        // Encrypt type(uint64).max for each vault — the vault's transferFrom uses
        // FHE.select so over-requesting is safe (transfers up to available balance).
        // The ABI's InEuint64[] internalType annotation tells @cofhe/react to
        // auto-encrypt these plaintext values.
        const maxAmounts = Array.from({ length: vaultCount }, () => MAX_UINT64);

        const hash = await encryptAndWrite({
          params: {
            address: CONTRACTS.InheritanceManager,
            abi: InheritanceManagerAbi,
            functionName: "finalizeClaim",
            chain: sepolia,
            account: address,
            gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
          },
          args: [
            ownerAddress as `0x${string}`,
            maxAmounts,
          ],
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
    [address, publicClient, encryptAndWrite, refetchPlan]
  );

  return {
    plan,
    isProcessing,
    setHeir,
    setVaults,
    heartbeat,
    removeHeir,
    startClaim,
    finalizeClaim,
    refetchPlan,
  };
}
