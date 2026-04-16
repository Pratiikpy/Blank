import { useState, useCallback } from "react";
import { useReadContract, usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { sepolia } from "viem/chains";
import { useCofheEncryptAndWriteContract } from "@cofhe/react";
import { InheritanceManagerAbi } from "@/lib/abis";
import { useChain } from "@/providers/ChainProvider";
import { insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
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
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const [isProcessing, setIsProcessing] = useState(false);

  // Atomic encrypt + write for finalizeClaim (encrypted InEuint64[] amounts)
  const { encryptAndWrite } = useCofheEncryptAndWriteContract();

  // Read current plan
  const { data: planData, refetch: refetchPlan } = useReadContract({
    address: contracts.InheritanceManager,
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
        const writeResult = await unifiedWriteAndWait({
          address: contracts.InheritanceManager,
          abi: InheritanceManagerAbi,
          functionName: "setHeir",
          args: [heirAddress as `0x${string}`, inactivitySeconds],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = writeResult.hash;
        console.log("[useInheritance.setHeir] write returned", { hash, hasReceipt: !!writeResult.receipt, status: writeResult.receipt?.status, blockNumber: writeResult.receipt?.blockNumber?.toString() });
        const setHeirReceipt =
          writeResult.receipt ??
          (await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }));
        if (setHeirReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        console.log("[useInheritance.setHeir] receipt OK, writing activity rows");

        // Owner's own row — so their feed + cross-tab state updates.
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INHERITANCE_HEIR_SET,
          contract_address: contracts.InheritanceManager,
          note: `Named ${heirAddress.slice(0, 6)}…${heirAddress.slice(-4)} as heir`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(setHeirReceipt.blockNumber),
        });

        // Heir's row — so the heir's realtime subscription picks this up
        // and they see "you were named as heir" in their activity feed.
        if (heirAddress.toLowerCase() !== address.toLowerCase()) {
          await insertActivity({
            tx_hash: `${hash}:heir`,
            user_from: address.toLowerCase(),
            user_to: heirAddress.toLowerCase(),
            activity_type: ACTIVITY_TYPES.INHERITANCE_HEIR_SET,
            contract_address: contracts.InheritanceManager,
            note: `You were named as heir`,
            token_address: contracts.FHERC20Vault_USDC,
            block_number: Number(setHeirReceipt.blockNumber),
          });
        }

        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Inheritance plan set!");
        await refetchPlan();
      } catch (err) {
        console.error("[useInheritance.setHeir] threw:", err instanceof Error ? err.message : String(err));
        toast.error(err instanceof Error ? err.message : "Failed to set heir");
      } finally {
        setIsProcessing(false);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, refetchPlan, contracts]
  );

  // Send heartbeat
  const heartbeat = useCallback(async () => {
    if (!address || !publicClient) return;
    setIsProcessing(true);
    try {
      const hash = await unifiedWrite({
        address: contracts.InheritanceManager,
        abi: InheritanceManagerAbi,
        functionName: "heartbeat",
        gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
      });
      const heartbeatReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (heartbeatReceipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      await insertActivity({
        tx_hash: hash,
        user_from: address.toLowerCase(),
        user_to: address.toLowerCase(),
        activity_type: ACTIVITY_TYPES.INHERITANCE_PULSE,
        contract_address: contracts.InheritanceManager,
        note: "Heartbeat — inheritance timer reset",
        token_address: contracts.FHERC20Vault_USDC,
        block_number: Number(heartbeatReceipt.blockNumber),
      });

      broadcastAction("activity_added");

      toast.success("Heartbeat sent!");
      await refetchPlan();
    } catch (err) {
      toast.error("Failed to send heartbeat");
    } finally {
      setIsProcessing(false);
    }
  }, [address, publicClient, unifiedWrite, refetchPlan, contracts]);

  // Remove heir
  const removeHeir = useCallback(async () => {
    if (!address || !publicClient) return;
    setIsProcessing(true);
    try {
      // Snapshot the former heir BEFORE the tx so we can notify them on success.
      const formerHeir = plan?.heir ?? null;

      const hash = await unifiedWrite({
        address: contracts.InheritanceManager,
        abi: InheritanceManagerAbi,
        functionName: "removeHeir",
        gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
      });
      const removeReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (removeReceipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      await insertActivity({
        tx_hash: hash,
        user_from: address.toLowerCase(),
        user_to: address.toLowerCase(),
        activity_type: ACTIVITY_TYPES.INHERITANCE_HEIR_REMOVED,
        contract_address: contracts.InheritanceManager,
        note: "Removed inheritance plan",
        token_address: contracts.FHERC20Vault_USDC,
        block_number: Number(removeReceipt.blockNumber),
      });

      if (
        formerHeir &&
        formerHeir !== "0x0000000000000000000000000000000000000000" &&
        formerHeir.toLowerCase() !== address.toLowerCase()
      ) {
        await insertActivity({
          tx_hash: `${hash}:heir`,
          user_from: address.toLowerCase(),
          user_to: formerHeir.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INHERITANCE_HEIR_REMOVED,
          contract_address: contracts.InheritanceManager,
          note: "You are no longer designated as heir",
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(removeReceipt.blockNumber),
        });
      }

      broadcastAction("activity_added");

      toast.success("Inheritance plan removed");
      await refetchPlan();
    } catch (err) {
      toast.error("Failed to remove heir");
    } finally {
      setIsProcessing(false);
    }
  }, [address, publicClient, unifiedWrite, refetchPlan, contracts, plan]);

  // Set vaults protected by the inheritance plan
  const setVaults = useCallback(
    async (vaultAddresses: string[]) => {
      if (!address || !publicClient) return;
      setIsProcessing(true);
      try {
        const hash = await unifiedWrite({
          address: contracts.InheritanceManager,
          abi: InheritanceManagerAbi,
          functionName: "setVaults",
          args: [vaultAddresses as `0x${string}`[]],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INHERITANCE_VAULTS_SET,
          contract_address: contracts.InheritanceManager,
          note: `Configured ${vaultAddresses.length} vault${vaultAddresses.length === 1 ? "" : "s"} for inheritance`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");

        toast.success("Vaults updated for inheritance plan!");
        await refetchPlan();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to set vaults");
      } finally {
        setIsProcessing(false);
      }
    },
    [address, publicClient, unifiedWrite, refetchPlan, contracts]
  );

  // Start claim (as heir)
  const startClaim = useCallback(
    async (ownerAddress: string) => {
      if (!address || !publicClient) return;
      setIsProcessing(true);
      try {
        const hash = await unifiedWrite({
          address: contracts.InheritanceManager,
          abi: InheritanceManagerAbi,
          functionName: "startClaim",
          args: [ownerAddress as `0x${string}`],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const claimReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (claimReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Heir's own feed row — so the caller sees "you started a claim".
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INHERITANCE_CLAIM_STARTED,
          contract_address: contracts.InheritanceManager,
          note: `Started inheritance claim on ${ownerAddress.slice(0, 6)}…${ownerAddress.slice(-4)}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(claimReceipt.blockNumber),
        });

        // Principal (owner) row — so the owner's realtime subscription fires.
        // Critical: this is how the owner sees "someone is trying to claim your
        // inheritance" and can send a heartbeat to cancel the claim window.
        if (ownerAddress.toLowerCase() !== address.toLowerCase()) {
          await insertActivity({
            tx_hash: `${hash}:owner`,
            user_from: address.toLowerCase(),
            user_to: ownerAddress.toLowerCase(),
            activity_type: ACTIVITY_TYPES.INHERITANCE_CLAIM_STARTED,
            contract_address: contracts.InheritanceManager,
            note: "Your heir started an inheritance claim — send a heartbeat to cancel",
            token_address: contracts.FHERC20Vault_USDC,
            block_number: Number(claimReceipt.blockNumber),
          });
        }

        broadcastAction("activity_added");

        toast.success("Claim started! Wait for the challenge period to finalize.");
        await refetchPlan();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to start claim");
      } finally {
        setIsProcessing(false);
      }
    },
    [address, publicClient, unifiedWrite, refetchPlan, contracts]
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
            address: contracts.InheritanceManager,
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

        // Heir's own feed row.
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INHERITANCE_CLAIM_FINALIZED,
          contract_address: contracts.InheritanceManager,
          note: `Finalized inheritance claim — funds transferred from ${ownerAddress.slice(0, 6)}…${ownerAddress.slice(-4)}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(finalizeReceipt.blockNumber),
        });

        // Principal (owner) row — so the owner's tab shows the finalization too.
        if (ownerAddress.toLowerCase() !== address.toLowerCase()) {
          await insertActivity({
            tx_hash: `${hash}:owner`,
            user_from: address.toLowerCase(),
            user_to: ownerAddress.toLowerCase(),
            activity_type: ACTIVITY_TYPES.INHERITANCE_CLAIM_FINALIZED,
            contract_address: contracts.InheritanceManager,
            note: "Inheritance claim finalized — funds transferred to heir",
            token_address: contracts.FHERC20Vault_USDC,
            block_number: Number(finalizeReceipt.blockNumber),
          });
        }

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Claim finalized! Funds transferred.");
        await refetchPlan();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to finalize claim");
      } finally {
        setIsProcessing(false);
      }
    },
    [address, publicClient, encryptAndWrite, refetchPlan, contracts]
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
