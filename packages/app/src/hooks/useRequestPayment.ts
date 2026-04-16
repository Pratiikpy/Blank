import { useState, useCallback } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { PaymentHubAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertPaymentRequest, updateRequestStatus, insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { extractEventId } from "@/lib/event-parser";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";

async function ensureVaultApproval(
  unifiedWriteAndWait: ReturnType<typeof useUnifiedWrite>["unifiedWriteAndWait"],
  vaultAddress: `0x${string}`,
  spenderAddress: `0x${string}`,
): Promise<{ hash: `0x${string}`; status?: "success" | "reverted" }> {
  const toastId = toast.loading("First time! Approving encrypted transfers...");
  try {
    const result = await unifiedWriteAndWait({
      address: vaultAddress,
      abi: FHERC20VaultAbi,
      functionName: "approvePlaintext",
      args: [spenderAddress, MAX_UINT64],
      gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
    });
    toast.success("Approval granted!", { id: toastId });
    return { hash: result.hash, status: result.receipt?.status };
  } catch (err) {
    toast.error("Approval failed", { id: toastId });
    throw err;
  }
}

export type RequestStep = "input" | "encrypting" | "sending" | "success" | "error";

export function useRequestPayment() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { connected } = useCofheConnection();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const [step, setStep] = useState<RequestStep>("input");
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<number | null>(null);

  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();

  // Semantics: `from` = the PAYER (person being asked to pay).
  // `address` (current user) = the REQUESTER who wants money.
  // Supabase stores: from_address = payer, to_address = requester.
  const createRequest = useCallback(
    async (from: string, amount: string, note: string) => {
      if (!address || !connected) return;
      if (step === "encrypting" || step === "sending") return; // Already submitting

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        if (!amount || amount.trim() === "") {
          toast.error("Enter an amount");
          return;
        }

        setStep("encrypting");
        const amountWei = parseUnits(amount, 6);
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(amountWei)]);

        setStep("sending");
        const createResult = await unifiedWriteAndWait({
          address: contracts.PaymentHub as `0x${string}`,
          abi: PaymentHubAbi,
          functionName: "createRequest",
          args: [
            from as `0x${string}`,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            // whose shape doesn't match wagmi's strict ABI-inferred arg types
            encAmount as unknown as EncryptedInput,
            note,
          ],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = createResult.hash;
        const createReceipt = createResult.receipt
          ? createResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (createReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract real request ID from event logs
        const requestId = extractEventId(createReceipt.logs, contracts.PaymentHub);

        // Write to Supabase for real-time notification
        await insertPaymentRequest({
          request_id: requestId,
          from_address: from.toLowerCase(),
          to_address: address.toLowerCase(),
          token_address: contracts.FHERC20Vault_USDC,
          note,
          status: "pending",
          tx_hash: hash,
        });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: from.toLowerCase(),
          activity_type: ACTIVITY_TYPES.REQUEST_CREATED,
          contract_address: contracts.PaymentHub,
          note,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(createReceipt.blockNumber),
        });

        // #89: createRequest previously skipped every sync signal, so the
        // payer's notifications hook, activity feed, and balance cache all
        // stayed stale until the next full reload. Match fulfillRequest.
        broadcastAction("activity_added");
        broadcastAction("balance_changed");
        invalidateBalanceQueries();

        setStep("success");
        toast.success("Payment request sent!");
      } catch (err) {
        setStep("error");
        setError(err instanceof Error ? err.message : "Failed to create request");
        toast.error("Request failed");
      }
    },
    [address, connected, step, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  const fulfillRequest = useCallback(
    async (reqId: number, amount: string, requesterAddress: string) => {
      if (!address || !connected) return;
      if (step === "encrypting" || step === "sending") return; // Already submitting

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        if (!amount || amount.trim() === "") {
          toast.error("Enter an amount");
          return;
        }

        // Ensure the PaymentHub contract is approved to transferFrom on the vault.
        // ensureVaultApproval now forwards the relay-side receipt; fall through
        // to waitForTransactionReceipt only if the relay didn't return one.
        if (!isVaultApproved(contracts.PaymentHub)) {
          const approval = await ensureVaultApproval(
            unifiedWriteAndWait,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            contracts.PaymentHub as `0x${string}`,
          );
          const approvalStatus = approval.status
            ?? (await publicClient.waitForTransactionReceipt({
              hash: approval.hash, confirmations: 1, timeout: 300_000,
            })).status;
          if (approvalStatus === "reverted") {
            throw new Error("Approval transaction reverted on-chain");
          }
          markVaultApproved(contracts.PaymentHub);
        }

        const amountWei = parseUnits(amount, 6);
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(amountWei)]);

        const fulfillResult = await unifiedWriteAndWait({
          address: contracts.PaymentHub as `0x${string}`,
          abi: PaymentHubAbi,
          functionName: "fulfillRequest",
          // Type assertion: cofhe SDK encrypted input (see above)
          args: [BigInt(reqId), encAmount as unknown as EncryptedInput],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = fulfillResult.hash;
        const fulfillReceipt = fulfillResult.receipt
          ? fulfillResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (fulfillReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Update Supabase status + notify requester
        await updateRequestStatus(String(reqId), "fulfilled");
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: requesterAddress.toLowerCase(),
          activity_type: ACTIVITY_TYPES.REQUEST_FULFILLED,
          contract_address: contracts.PaymentHub,
          note: "",
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(fulfillReceipt.blockNumber),
        });

        // Notify other tabs and invalidate cached balances
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStep("success");
        toast.success("Request fulfilled!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to fulfill request";
        // If this looks like an approval issue, clear the cache so next attempt re-approves
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.PaymentHub);
        }
        setStep("error");
        setError(msg);
        toast.error("Failed to fulfill request");
      }
    },
    [address, connected, step, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  const cancelRequest = useCallback(
    async (reqId: number) => {
      if (!address || !publicClient) return;
      if (step === "encrypting" || step === "sending") return; // Already submitting
      try {
        const cancelResult = await unifiedWriteAndWait({
          address: contracts.PaymentHub as `0x${string}`,
          abi: PaymentHubAbi,
          functionName: "cancelRequest",
          args: [BigInt(reqId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = cancelResult.hash;
        const cancelReceipt = cancelResult.receipt
          ? cancelResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (cancelReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        await updateRequestStatus(String(reqId), "cancelled");

        // #234: cancelRequest previously skipped broadcasts, so the requester's
        // own list (and other tabs) kept the cancelled row visible until reload.
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Request cancelled");
      } catch {
        toast.error("Failed to cancel");
      }
    },
    [address, step, unifiedWrite, publicClient, contracts]
  );

  const reset = useCallback(() => {
    setStep("input");
    setError(null);
    setRequestId(null);
  }, []);

  return { step, error, requestId, createRequest, fulfillRequest, cancelRequest, reset };
}
