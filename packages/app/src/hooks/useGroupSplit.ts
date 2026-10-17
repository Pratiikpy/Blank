import { useState, useCallback, useRef } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits, formatUnits, decodeEventLog, type Log } from "viem";
import { useCofheEncrypt, useCofheConnection, ENCRYPTION_NOT_READY } from "@/lib/cofhe-shim";
import { Encryptable } from "@/lib/cofhe-shim";
import { useCofheDecryptForView } from "@/lib/cofhe-shim";
import toast from "react-hot-toast";
import { toastMappedError } from "@/lib/error-messages";
import { MAX_UINT64 } from "@/lib/constants";
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

/**
 * Split `total` (6-decimal token string) into `n` shares that sum to the
 * total exactly in base units. The contract applies an expense only when
 * the encrypted shares add up to the encrypted total, so a rounded split
 * (10 / 3 = 3.333333 x 3) would silently apply nothing. The remainder goes
 * one unit at a time to the first shares.
 */
export function splitEqually(total: string, n: number): string[] {
  if (n <= 0) return [];
  let units: bigint;
  try {
    units = parseUnits(total || "0", 6);
  } catch {
    return Array.from({ length: n }, () => "0");
  }
  const count = BigInt(n);
  const base = units / count;
  const rem = units % count;
  return Array.from({ length: n }, (_, i) => formatUnits(BigInt(i) < rem ? base + 1n : base, 6));
}

/** True when the shares add up to the total exactly in 6-decimal base units. */
export function sharesSumToTotal(shares: string[], total: string): boolean {
  try {
    const sum = shares.reduce((acc, s) => acc + parseUnits(s || "0", 6), 0n);
    return sum === parseUnits(total || "0", 6);
  } catch {
    return false;
  }
}

/** Map GroupManager revert strings to copy a user can act on. */
export function friendlyGroupError(raw: string): string {
  if (raw.includes("group archived")) return "This group is archived. It takes no new expenses or settlements.";
  if (raw.includes("wrong vault for group")) return "This group settles in a different token. Settle with the token the group already uses.";
  if (raw.includes("vault not allowed")) return "This token vault is not enabled for groups on this chain.";
  if (raw.includes("GroupManager: retired")) return "Expense voting was retired.";
  return raw;
}

function extractExpenseAppliedHandle(logs: Log[], contractAddress: string): bigint | null {
  const lcContract = contractAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== lcContract) continue;
    try {
      const decoded = decodeEventLog({
        abi: GroupManagerAbi,
        data: log.data,
        topics: log.topics,
        eventName: "ExpenseApplied",
      });
      return BigInt((decoded.args as { applied: bigint | `0x${string}` }).applied);
    } catch {
      // other event
    }
  }
  return null;
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
    (totalAmount: string, memberCount: number) => splitEqually(totalAmount, memberCount),
    []
  );

  // Create a new group on-chain + sync to Supabase
  const createGroup = useCallback(
    async (name: string, members: string[]) => {
      // No `connected` gate: this call carries no encrypted argument, so it
      // does not need the CoFHE client. Requiring it made the button a silent
      // no-op for anyone whose smart account is not deployed yet — which is
      // exactly the state a brand new recipient is in.
      if (!address) return;
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
        if (groupId === null) {
          throw new Error("Tx mined but groupId could not be read; check History tab.");
        }

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
        // The contract applies nothing unless the shares sum to the total.
        if (!sharesSumToTotal(shares, totalAmount)) {
          toast.error("Shares must add up to the total exactly.");
          return;
        }

        // addExpense verifies every share AND the total under ONE batch
        // signature, so they have to be encrypted together, shares first.
        const expenseBatch = await encryptInputsAsync(
          [
            ...shares.map((s) => Encryptable.uint64(parseUnits(s, 6))),
            Encryptable.uint64(parseUnits(totalAmount, 6)),
          ],
          contracts.GroupManager as `0x${string}`,
        );
        const encryptedShares = expenseBatch.slice(0, shares.length);
        const encryptedTotal = expenseBatch[shares.length];
        const expenseProof = expenseBatch[expenseBatch.length - 1];

        // Call GroupManager.addExpense() on-chain
        const addResult = await unifiedWriteAndWait({
          address: contracts.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "addExpense",
          args: [
            BigInt(groupId),
            members as `0x${string}`[],
            encryptedShares,
            encryptedTotal,
            expenseProof,
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
        if (expenseId === null) {
          throw new Error("Tx mined but expenseId could not be read; check History tab.");
        }

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

        // ExpenseApplied carries an encrypted flag only the payer can read:
        // true when the shares matched the total and debts moved.
        const appliedHandle = extractExpenseAppliedHandle(
          expenseReceipt.logs as Log[],
          contracts.GroupManager,
        );
        const applied = appliedHandle !== null ? await decryptForView(appliedHandle, "ebool") : null;
        if (applied === false) {
          toast.error("Expense recorded, but no debts changed: the encrypted shares did not add up to the total.", { duration: 8000 });
        } else if (applied === true) {
          toast.success("Expense added. Debts updated.");
        } else {
          toast.success("Expense added!");
        }
      } catch (err) {
        const msg = friendlyGroupError(err instanceof Error ? err.message : "Failed to add expense");
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

  // Settle a debt with another group member via encrypted vault transfer
  const settleDebt = useCallback(
    async (groupId: number, withAddress: string, amount: string) => {
      if (!address) return;
      if (!connected) { toast.error(ENCRYPTION_NOT_READY); return; }
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

        // A group settles in one vault, pinned on its first settlement.
        // The app settles in USDC; fail before encrypting if the group
        // was pinned to another vault.
        const pinned = (await publicClient.readContract({
          address: contracts.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "groupVault",
          args: [BigInt(groupId)],
        })) as `0x${string}`;
        if (
          pinned !== "0x0000000000000000000000000000000000000000" &&
          pinned.toLowerCase() !== contracts.FHERC20Vault_USDC.toLowerCase()
        ) {
          toast.error(friendlyGroupError("GroupManager: wrong vault for group"));
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
        const [encAmount, encAmountProof] = await encryptInputsAsync([
          Encryptable.uint64(amountWei),
        ],
        contracts.GroupManager as `0x${string}`);

        const settleResult = await unifiedWriteAndWait({
          address: contracts.GroupManager as `0x${string}`,
          abi: GroupManagerAbi,
          functionName: "settleDebt",
          args: [
            BigInt(groupId),
            withAddress as `0x${string}`,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypted input (see above)
            encAmount,
          encAmountProof,],
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
        const msg = friendlyGroupError(err instanceof Error ? err.message : "Failed to settle debt");
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
        toastMappedError(err);
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
        toastMappedError(err);
      } finally {
        submittingRef.current = false;
        setIsProcessing(false);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, contracts]
  );

  return { isProcessing, computeEqualSplit, createGroup, addExpense, settleDebt, leaveGroup, archiveGroup };
}
