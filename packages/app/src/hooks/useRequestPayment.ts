import { useState, useCallback } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { CONTRACTS, MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { PaymentHubAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertPaymentRequest, updateRequestStatus, insertActivity } from "@/lib/supabase";
import { extractEventId } from "@/lib/event-parser";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";

async function ensureVaultApproval(
  writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"],
  vaultAddress: `0x${string}`,
  spenderAddress: `0x${string}`,
): Promise<`0x${string}`> {
  const toastId = toast.loading("First time! Approving encrypted transfers...");
  try {
    const hash = await writeContractAsync({
      address: vaultAddress,
      abi: FHERC20VaultAbi,
      functionName: "approvePlaintext",
      args: [spenderAddress, MAX_UINT64],
    });
    toast.success("Approval granted!", { id: toastId });
    return hash;
  } catch (err) {
    toast.error("Approval failed", { id: toastId });
    throw err;
  }
}

export type RequestStep = "input" | "encrypting" | "sending" | "success" | "error";

export function useRequestPayment() {
  const { address } = useAccount();
  const { connected } = useCofheConnection();
  const publicClient = usePublicClient();
  const [step, setStep] = useState<RequestStep>("input");
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<number | null>(null);

  const { encryptInputsAsync } = useCofheEncrypt();
  const { writeContractAsync } = useWriteContract();

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
        const hash = await writeContractAsync({
          address: CONTRACTS.PaymentHub as `0x${string}`,
          abi: PaymentHubAbi,
          functionName: "createRequest",
          args: [
            from as `0x${string}`,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            // whose shape doesn't match wagmi's strict ABI-inferred arg types
            encAmount as unknown as EncryptedInput,
            note,
          ],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const createReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (createReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract real request ID from event logs
        const requestId = extractEventId(createReceipt.logs, CONTRACTS.PaymentHub);

        // Write to Supabase for real-time notification
        await insertPaymentRequest({
          request_id: requestId,
          from_address: from.toLowerCase(),
          to_address: address.toLowerCase(),
          token_address: CONTRACTS.FHERC20Vault_USDC,
          note,
          status: "pending",
          tx_hash: hash,
        });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: from.toLowerCase(),
          activity_type: "request_created",
          contract_address: CONTRACTS.PaymentHub,
          note,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          block_number: Number(createReceipt.blockNumber),
        });

        setStep("success");
        toast.success("Payment request sent!");
      } catch (err) {
        setStep("error");
        setError(err instanceof Error ? err.message : "Failed to create request");
        toast.error("Request failed");
      }
    },
    [address, connected, step, encryptInputsAsync, writeContractAsync, publicClient]
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

        // Ensure the PaymentHub contract is approved to transferFrom on the vault
        if (!isVaultApproved(CONTRACTS.PaymentHub)) {
          const approvalHash = await ensureVaultApproval(
            writeContractAsync,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            CONTRACTS.PaymentHub as `0x${string}`,
          );
          if (approvalHash) {
            const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash, confirmations: 1 });
            if (approvalReceipt.status === "reverted") {
              throw new Error("Approval transaction reverted on-chain");
            }
            markVaultApproved(CONTRACTS.PaymentHub);
          }
        }

        const amountWei = parseUnits(amount, 6);
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(amountWei)]);

        const hash = await writeContractAsync({
          address: CONTRACTS.PaymentHub as `0x${string}`,
          abi: PaymentHubAbi,
          functionName: "fulfillRequest",
          // Type assertion: cofhe SDK encrypted input (see above)
          args: [BigInt(reqId), encAmount as unknown as EncryptedInput],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const fulfillReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (fulfillReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Update Supabase status + notify requester
        await updateRequestStatus(String(reqId), "fulfilled");
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: requesterAddress.toLowerCase(),
          activity_type: "request_fulfilled",
          contract_address: CONTRACTS.PaymentHub,
          note: "",
          token_address: CONTRACTS.FHERC20Vault_USDC,
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
          clearVaultApproval(CONTRACTS.PaymentHub);
        }
        setStep("error");
        setError(msg);
        toast.error("Failed to fulfill request");
      }
    },
    [address, connected, step, encryptInputsAsync, writeContractAsync, publicClient]
  );

  const cancelRequest = useCallback(
    async (reqId: number) => {
      if (!address || !publicClient) return;
      if (step === "encrypting" || step === "sending") return; // Already submitting
      try {
        const hash = await writeContractAsync({
          address: CONTRACTS.PaymentHub as `0x${string}`,
          abi: PaymentHubAbi,
          functionName: "cancelRequest",
          args: [BigInt(reqId)],
        });
        const cancelReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (cancelReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        await updateRequestStatus(String(reqId), "cancelled");
        toast.success("Request cancelled");
      } catch {
        toast.error("Failed to cancel");
      }
    },
    [address, step, writeContractAsync, publicClient]
  );

  const reset = useCallback(() => {
    setStep("input");
    setError(null);
    setRequestId(null);
  }, []);

  return { step, error, requestId, createRequest, fulfillRequest, cancelRequest, reset };
}
