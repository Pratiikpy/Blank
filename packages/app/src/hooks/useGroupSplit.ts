import { useState, useCallback, useRef } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { CONTRACTS, MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { GroupManagerAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertGroupExpense, insertGroupMembership, insertActivity } from "@/lib/supabase";
import { extractEventId } from "@/lib/event-parser";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";

async function ensureVaultApproval(
  writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"],
  vaultAddress: `0x${string}`,
  spenderAddress: `0x${string}`,
) {
  const toastId = toast.loading("First time! Approving encrypted transfers...");
  try {
    await writeContractAsync({
      address: vaultAddress,
      abi: FHERC20VaultAbi,
      functionName: "approvePlaintext",
      args: [spenderAddress, MAX_UINT64],
    });
    toast.success("Approval granted!", { id: toastId });
  } catch (err) {
    toast.error("Approval failed", { id: toastId });
    throw err;
  }
}

export function useGroupSplit() {
  const { address } = useAccount();
  const { connected } = useCofheConnection();
  const publicClient = usePublicClient();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { writeContractAsync } = useWriteContract();

  const [isProcessing, setIsProcessing] = useState(false);
  const submittingRef = useRef(false);

  const computeEqualSplit = useCallback(
    (totalAmount: string, memberCount: number) => {
      const total = parseFloat(totalAmount);
      const perPerson = total / memberCount;
      return perPerson.toFixed(6);
    },
    []
  );

  // Create a new group on-chain + sync to Supabase
  const createGroup = useCallback(
    async (name: string, members: string[]) => {
      if (!address || !connected) return;
      if (submittingRef.current) return; // Prevent double-submit (ref-based)
      if (!publicClient) { toast.error("Connection lost"); return; }

      try {
        submittingRef.current = true;
        setIsProcessing(true);

        const hash = await writeContractAsync({
          address: CONTRACTS.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "createGroup",
          args: [name, members as `0x${string}`[]],
        });

        // Wait for on-chain confirmation
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") throw new Error("Transaction reverted");

        // Extract real group ID from event logs
        const groupId = extractEventId(receipt.logs, CONTRACTS.GroupManager);

        // Sync memberships to Supabase
        const allMembers = [address, ...members.filter((m) => m !== address)];
        for (const member of allMembers) {
          await insertGroupMembership({
            group_id: groupId,
            group_name: name,
            member_address: member,
            is_admin: member === address,
          });
        }

        toast.success("Group created!");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create group";
        toast.error(msg);
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, connected, writeContractAsync, publicClient]
  );

  // Add expense with pre-computed encrypted shares
  const addExpense = useCallback(
    async (
      groupId: number,
      totalAmount: string,
      members: string[],
      shares: string[],
      description: string
    ) => {
      if (!address || !connected || shares.length === 0) return;
      if (submittingRef.current) return; // Prevent double-submit (ref-based)

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        submittingRef.current = true;
        setIsProcessing(true);

        // Ensure the GroupManager contract is approved to transferFrom on the vault
        if (!isVaultApproved(CONTRACTS.GroupManager)) {
          await ensureVaultApproval(
            writeContractAsync,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            CONTRACTS.GroupManager as `0x${string}`,
          );
          markVaultApproved(CONTRACTS.GroupManager);
        }

        // Encrypt each person's share individually
        const encryptedShares = await encryptInputsAsync(
          shares.map((s) => Encryptable.uint64(parseUnits(s, 6)))
        );

        // Encrypt the total paid by payer
        const [encryptedTotal] = await encryptInputsAsync([
          Encryptable.uint64(parseUnits(totalAmount, 6)),
        ]);

        // Call GroupManager.addExpense() on-chain
        const hash = await writeContractAsync({
          address: CONTRACTS.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "addExpense",
          args: [
            BigInt(groupId),
            members as `0x${string}`[],
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            // whose shape doesn't match wagmi's strict ABI-inferred arg types
            encryptedShares as unknown as EncryptedInput[],
            encryptedTotal as unknown as EncryptedInput,
            description,
          ],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const expenseReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (expenseReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract real expense ID from event logs
        const expenseId = extractEventId(expenseReceipt.logs, CONTRACTS.GroupManager);

        // Sync to Supabase
        await insertGroupExpense({
          group_id: groupId,
          expense_id: expenseId,
          payer_address: address,
          description,
          member_count: members.length,
          tx_hash: hash,
        });

        // Create one activity per member so each gets a notification
        for (const member of members) {
          await insertActivity({
            tx_hash: `${hash}_${member.toLowerCase()}`,
            user_from: address.toLowerCase(),
            user_to: member.toLowerCase(),
            activity_type: "group_expense",
            contract_address: CONTRACTS.GroupManager,
            note: description,
            token_address: CONTRACTS.FHERC20Vault_USDC,
            block_number: Number(expenseReceipt.blockNumber),
          });
        }

        // Notify other tabs and invalidate cached balances
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Expense added!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to add expense";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(CONTRACTS.GroupManager);
        }
        toast.error(msg);
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, connected, encryptInputsAsync, writeContractAsync, publicClient]
  );

  // Settle a debt with another group member via encrypted vault transfer
  const settleDebt = useCallback(
    async (groupId: number, withAddress: string, amount: string) => {
      if (!address || !connected) return;
      if (submittingRef.current) return; // Prevent double-submit (ref-based)

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        submittingRef.current = true;
        setIsProcessing(true);

        // Ensure the GroupManager contract is approved to transferFrom on the vault
        if (!isVaultApproved(CONTRACTS.GroupManager)) {
          await ensureVaultApproval(
            writeContractAsync,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            CONTRACTS.GroupManager as `0x${string}`,
          );
          markVaultApproved(CONTRACTS.GroupManager);
        }

        const amountWei = parseUnits(amount, 6);
        const [encAmount] = await encryptInputsAsync([
          Encryptable.uint64(amountWei),
        ]);

        const hash = await writeContractAsync({
          address: CONTRACTS.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "settleDebt",
          args: [
            BigInt(groupId),
            withAddress as `0x${string}`,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypted input (see above)
            encAmount as unknown as EncryptedInput,
          ],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const settleReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (settleReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: withAddress.toLowerCase(),
          activity_type: "debt_settled",
          contract_address: CONTRACTS.GroupManager,
          note: `Settled debt in group ${groupId}`,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          block_number: Number(settleReceipt.blockNumber),
        });

        // Notify other tabs and invalidate cached balances
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Debt settled!");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to settle debt";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(CONTRACTS.GroupManager);
        }
        toast.error(msg);
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, connected, encryptInputsAsync, writeContractAsync, publicClient]
  );

  const voteOnExpense = useCallback(
    async (groupId: number, expenseId: number, votes: string) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (submittingRef.current) return;

      submittingRef.current = true;
      setIsProcessing(true);
      try {
        const votesWei = parseUnits(votes, 6);
        const [encrypted] = await encryptInputsAsync([
          Encryptable.uint64(votesWei),
        ]);

        const hash = await writeContractAsync({
          address: CONTRACTS.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "voteOnExpense",
          // Type assertion: cofhe SDK encrypted input (see above)
          args: [BigInt(groupId), BigInt(expenseId), encrypted as unknown as EncryptedInput],
        });

        const voteReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (voteReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "group_vote",
          contract_address: CONTRACTS.GroupManager,
          note: `Voted on expense #${expenseId} in group #${groupId}`,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          block_number: Number(voteReceipt.blockNumber),
        });

        toast.success("Vote submitted!");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Vote failed");
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, publicClient, writeContractAsync, encryptInputsAsync]
  );

  // Leave a group (removes self from membership)
  const leaveGroup = useCallback(
    async (groupId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (submittingRef.current) return;

      submittingRef.current = true;
      setIsProcessing(true);
      try {
        const hash = await writeContractAsync({
          address: CONTRACTS.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "leaveGroup",
          args: [BigInt(groupId)],
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "group_left",
          contract_address: CONTRACTS.GroupManager,
          note: `Left group #${groupId}`,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");
        toast.success("Left the group!");
        return hash;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to leave group");
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, publicClient, writeContractAsync]
  );

  // Archive a group (admin only, deactivates group)
  const archiveGroup = useCallback(
    async (groupId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (submittingRef.current) return;

      submittingRef.current = true;
      setIsProcessing(true);
      try {
        const hash = await writeContractAsync({
          address: CONTRACTS.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "archiveGroup",
          args: [BigInt(groupId)],
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "group_archived",
          contract_address: CONTRACTS.GroupManager,
          note: `Archived group #${groupId}`,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");
        toast.success("Group archived!");
        return hash;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to archive group");
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, publicClient, writeContractAsync]
  );

  return { isProcessing, computeEqualSplit, createGroup, addExpense, settleDebt, voteOnExpense, leaveGroup, archiveGroup };
}
