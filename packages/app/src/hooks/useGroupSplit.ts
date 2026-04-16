import { useState, useCallback, useRef } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits, formatUnits, decodeEventLog, type Log } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import { useCofheDecryptForView } from "@/lib/cofhe-shim";
import toast from "react-hot-toast";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { GroupManagerAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertGroupExpense, insertGroupMembership, insertActivity } from "@/lib/supabase";
import { insertActivitiesFanout } from "@/lib/activity-fanout";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { extractEventId } from "@/lib/event-parser";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";

// Extract the encrypted `actual` handle from the DebtSettledEncrypted event log.
// Returns null if the event is absent (shouldn't happen post-fix, but fail-soft).
function extractEncryptedActualHandle(
  logs: Log[],
  contractAddress: string,
): bigint | null {
  const lcContract = contractAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== lcContract) continue;
    try {
      const decoded = decodeEventLog({
        abi: GroupManagerAbi,
        data: log.data,
        topics: log.topics,
        eventName: "DebtSettledEncrypted",
      });
      // encryptedActual is declared as `bytes32` (wire form of euint64 ctHash).
      // The SDK's decryptForView expects the ctHash as a bigint.
      const handle = (decoded.args as { encryptedActual: `0x${string}` }).encryptedActual;
      return BigInt(handle);
    } catch {
      // Wrong event type — skip
    }
  }
  return null;
}

async function ensureVaultApproval(
  unifiedWrite: ReturnType<typeof useUnifiedWrite>["unifiedWrite"],
  vaultAddress: `0x${string}`,
  spenderAddress: `0x${string}`,
) {
  const toastId = toast.loading("First time! Approving encrypted transfers...");
  try {
    await unifiedWrite({
      address: vaultAddress,
      abi: FHERC20VaultAbi,
      functionName: "approvePlaintext",
      args: [spenderAddress, MAX_UINT64],
      gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
    });
    toast.success("Approval granted!", { id: toastId });
  } catch (err) {
    toast.error("Approval failed", { id: toastId });
    throw err;
  }
}

export function useGroupSplit() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { connected } = useCofheConnection();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { encryptInputsAsync } = useCofheEncrypt();
  const { decryptForView } = useCofheDecryptForView();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();

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

        const writeResult = await unifiedWriteAndWait({
          address: contracts.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "createGroup",
          args: [name, members as `0x${string}`[]],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = writeResult.hash;
        const receipt =
          writeResult.receipt ??
          (await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }));
        if (receipt.status === "reverted") throw new Error("Transaction reverted");

        // Extract real group ID from event logs
        const groupId = extractEventId(receipt.logs, contracts.GroupManager);

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
    [address, connected, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
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
        if (!isVaultApproved(contracts.GroupManager)) {
          await ensureVaultApproval(
            unifiedWrite,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            contracts.GroupManager as `0x${string}`,
          );
          markVaultApproved(contracts.GroupManager);
        }

        // Validate all share amounts before encrypting
        for (const s of shares) {
          if (!s || s.trim() === "") {
            toast.error("All share amounts must be filled in");
            return;
          }
        }
        if (!totalAmount || totalAmount.trim() === "") {
          toast.error("Enter a total amount");
          return;
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
        const addResult = await unifiedWriteAndWait({
          address: contracts.GroupManager as `0x${string}`,
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
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = addResult.hash;
        const expenseReceipt = addResult.receipt
          ? addResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (expenseReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract real expense ID from event logs
        const expenseId = extractEventId(expenseReceipt.logs, contracts.GroupManager);

        // Sync to Supabase
        await insertGroupExpense({
          group_id: groupId,
          expense_id: expenseId,
          payer_address: address,
          description,
          member_count: members.length,
          tx_hash: hash,
        });

        // Create one activity per member so each gets a notification.
        // Parallel fanout (Promise.allSettled) so a single row failure doesn't
        // halt sync for the remaining members. Preserves the per-member
        // tx_hash suffix so Supabase upsert on tx_hash still works per-row.
        await insertActivitiesFanout(
          members.map((member) => ({
            tx_hash: `${hash}_${member.toLowerCase()}`,
            user_from: address.toLowerCase(),
            user_to: member.toLowerCase(),
            activity_type: ACTIVITY_TYPES.GROUP_EXPENSE,
            contract_address: contracts.GroupManager,
            note: description,
            token_address: contracts.FHERC20Vault_USDC,
            block_number: Number(expenseReceipt.blockNumber),
          })),
          { userToastOnFailure: true, context: "group-expense" },
        );

        // Notify other tabs and invalidate cached balances
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Expense added!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to add expense";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.GroupManager);
        }
        toast.error(msg);
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, connected, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
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

        if (!amount || amount.trim() === "") {
          toast.error("Enter an amount");
          return;
        }

        // Ensure the GroupManager contract is approved to transferFrom on the vault
        if (!isVaultApproved(contracts.GroupManager)) {
          await ensureVaultApproval(
            unifiedWrite,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            contracts.GroupManager as `0x${string}`,
          );
          markVaultApproved(contracts.GroupManager);
        }

        const amountWei = parseUnits(amount, 6);
        const [encAmount] = await encryptInputsAsync([
          Encryptable.uint64(amountWei),
        ]);

        const settleResult = await unifiedWriteAndWait({
          address: contracts.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "settleDebt",
          args: [
            BigInt(groupId),
            withAddress as `0x${string}`,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypted input (see above)
            encAmount as unknown as EncryptedInput,
          ],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = settleResult.hash;
        const settleReceipt = settleResult.receipt
          ? settleResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (settleReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: withAddress.toLowerCase(),
          activity_type: ACTIVITY_TYPES.DEBT_SETTLED,
          contract_address: contracts.GroupManager,
          note: `Settled debt in group ${groupId}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(settleReceipt.blockNumber),
        });

        // Notify other tabs and invalidate cached balances
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        // Decrypt the ACTUAL transferred amount from DebtSettledEncrypted event.
        // If it's less than requested, the vault didn't have enough — warn user
        // so their local display + expectations match on-chain debt.
        // On-chain debt accounting is ALREADY correct (uses actual, not requested).
        const actualHandle = extractEncryptedActualHandle(
          settleReceipt.logs as Log[],
          contracts.GroupManager,
        );
        if (actualHandle !== null) {
          const decrypted = await decryptForView(actualHandle, "uint64");
          if (typeof decrypted === "bigint") {
            if (decrypted === amountWei) {
              toast.success(`Debt settled in full ($${amount})`);
            } else if (decrypted < amountWei) {
              const actualStr = formatUnits(decrypted, 6);
              const shortfall = formatUnits(amountWei - decrypted, 6);
              toast.error(
                `Settled $${actualStr} (you tried to settle $${amount} — vault didn't have enough). Remaining unsettled: $${shortfall}`,
                { duration: 8000 },
              );
            } else {
              // decrypted > amountWei should be impossible (vault clamps downward)
              toast.success("Debt settled!");
            }
          } else {
            // Decrypt failed (SDK not ready, network, etc) — fall back to plain success.
            // On-chain accounting is still correct — user just won't see the partial warning.
            toast.success("Debt settled!");
          }
        } else {
          toast.success("Debt settled!");
        }

        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to settle debt";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.GroupManager);
        }
        toast.error(msg);
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, connected, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts, decryptForView]
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
        if (!votes || votes.trim() === "") {
          toast.error("Enter a vote amount");
          return;
        }

        const votesWei = parseUnits(votes, 6);
        const [encrypted] = await encryptInputsAsync([
          Encryptable.uint64(votesWei),
        ]);

        const voteResult = await unifiedWriteAndWait({
          address: contracts.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "voteOnExpense",
          // Type assertion: cofhe SDK encrypted input (see above)
          args: [BigInt(groupId), BigInt(expenseId), encrypted as unknown as EncryptedInput],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = voteResult.hash;
        const voteReceipt = voteResult.receipt
          ? voteResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (voteReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "group_vote",
          contract_address: contracts.GroupManager,
          note: `Voted on expense #${expenseId} in group #${groupId}`,
          token_address: contracts.FHERC20Vault_USDC,
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
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, encryptInputsAsync, contracts]
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
        const leaveResult = await unifiedWriteAndWait({
          address: contracts.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "leaveGroup",
          args: [BigInt(groupId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = leaveResult.hash;
        const receipt = leaveResult.receipt
          ? leaveResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "group_left",
          contract_address: contracts.GroupManager,
          note: `Left group #${groupId}`,
          token_address: contracts.FHERC20Vault_USDC,
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
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, contracts]
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
        const archiveResult = await unifiedWriteAndWait({
          address: contracts.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "archiveGroup",
          args: [BigInt(groupId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = archiveResult.hash;
        const receipt = archiveResult.receipt
          ? archiveResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "group_archived",
          contract_address: contracts.GroupManager,
          note: `Archived group #${groupId}`,
          token_address: contracts.FHERC20Vault_USDC,
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
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, contracts]
  );

  return { isProcessing, computeEqualSplit, createGroup, addExpense, settleDebt, voteOnExpense, leaveGroup, archiveGroup };
}
