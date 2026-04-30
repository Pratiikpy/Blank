import { useState, useCallback, useRef, useEffect } from "react";
import { usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt } from "@/lib/cofhe-shim";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { Encryptable } from "@/lib/cofhe-shim";
import toast from "react-hot-toast";
import { type EncryptedInput, MAX_UINT64 } from "@/lib/constants";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import { BusinessHubAbi, FHERC20VaultAbi } from "@/lib/abis";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { insertActivity, updateInvoiceStatus } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

// Hook for the trustless invoice escrow flow added in PR-C steps 1+2.
//
// Two operations:
//   payEscrow(invoiceId, amount)        — encrypt the amount, ensure vault
//                                         allowance, call payInvoiceEscrow.
//                                         Funds sit in BusinessHub.
//   releaseEscrow(invoiceId)            — read the on-chain validation
//                                         handle, decrypt off-chain via
//                                         cofhe Threshold Network, call
//                                         releaseInvoiceEscrow with the
//                                         signed plaintext. The contract
//                                         routes funds: vendor on match,
//                                         client refund on mismatch.
//
// Both ops:
//   - hold a single in-flight Step state (the existing useBusinessHub
//     pattern) so the UI can disable buttons / show progress copy
//   - report success/failure via toasts + return the tx hash
//   - sync to Supabase for activity feed (tx_hash + activity_type)
//
// This is the ONLY surface that should call payInvoiceEscrow /
// releaseInvoiceEscrow. The legacy `useBusinessHub.payInvoice` path stays
// for in-app invoice modal payments where there is no shared link.

export type InvoiceEscrowStep =
  | "idle"
  | "approving"
  | "encrypting"
  | "paying"
  | "decrypting"
  | "finalizing"
  | "success"
  | "error";

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
      gas: BigInt(5_000_000),
    });
    toast.success("Approval granted!", { id: toastId });
  } catch (err) {
    toast.error("Approval failed", { id: toastId });
    throw err;
  }
}

export function useInvoiceEscrow() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChainId, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { encryptInputsAsync } = useCofheEncrypt();
  const { decryptForTx } = useCofheDecryptForTx();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const [step, setStep] = useState<InvoiceEscrowStep>("idle");

  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const finishTransiently = useCallback(
    (next: "success" | "error", ms = 5000) => {
      clearTimeout(resetTimer.current);
      setStep(next);
      resetTimer.current = setTimeout(() => setStep("idle"), ms);
    },
    [],
  );

  // ── payEscrow — client funds the escrow with their encrypted payment ──
  const payEscrow = useCallback(
    async (invoiceId: number, amount: string): Promise<string | null> => {
      if (!address) {
        toast.error("Connect a wallet first");
        return null;
      }
      if (!publicClient) {
        toast.error("Connection lost — please refresh");
        return null;
      }
      if (step !== "idle") return null;
      if (!amount || amount.trim() === "") {
        toast.error("Enter an amount");
        return null;
      }

      try {
        clearTimeout(resetTimer.current);

        setStep("approving");
        if (!isVaultApproved(contracts.BusinessHub)) {
          await ensureVaultApproval(
            unifiedWrite,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            contracts.BusinessHub as `0x${string}`,
          );
          markVaultApproved(contracts.BusinessHub);
        }

        setStep("encrypting");
        const amountWei = parseUnits(amount, 6);
        const [encAmount] = await encryptInputsAsync([
          Encryptable.uint64(amountWei),
        ]);

        setStep("paying");
        const result = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "payInvoiceEscrow",
          args: [BigInt(invoiceId), encAmount as unknown as EncryptedInput],
          gas: BigInt(5_000_000), // FHE: precompile can't be estimated
        });
        const hash = result.hash;
        const receipt = result.receipt
          ? result.receipt
          : await publicClient.waitForTransactionReceipt({
              hash,
              confirmations: 1,
              timeout: 300_000,
            });
        if (receipt.status === "reverted") {
          throw new Error("Escrow funding reverted on-chain");
        }

        // PaymentPending — match check awaits releaseInvoiceEscrow.
        await updateInvoiceStatus(invoiceId, "payment_pending");
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_PAYMENT,
          contract_address: contracts.BusinessHub,
          note: `Funded escrow for invoice #${invoiceId}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Payment funded — finalize to release to vendor");
        finishTransiently("success");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Escrow funding failed";
        toast.error(msg);
        finishTransiently("error");
        return null;
      }
    },
    [
      address,
      publicClient,
      step,
      contracts,
      unifiedWrite,
      unifiedWriteAndWait,
      encryptInputsAsync,
      finishTransiently,
    ],
  );

  // ── releaseEscrow — finalize: vendor receives or client refunds ──
  const releaseEscrow = useCallback(
    async (invoiceId: number): Promise<{ hash: string; matched: boolean } | null> => {
      if (!address) {
        toast.error("Connect a wallet first");
        return null;
      }
      if (!publicClient) {
        toast.error("Connection lost — please refresh");
        return null;
      }
      if (step !== "idle") return null;

      try {
        clearTimeout(resetTimer.current);

        setStep("decrypting");
        // Read the validation ebool handle the contract stored at
        // payInvoiceEscrow time.
        const handle = (await publicClient.readContract({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "getInvoiceValidationHandle",
          args: [BigInt(invoiceId)],
        })) as bigint;
        if (!handle || handle === 0n) {
          throw new Error("Invoice not funded yet — nothing to finalize");
        }

        // Threshold-decrypt the validation flag. Identical pattern to
        // useBusinessHub.finalizeInvoice — poll until the network has the
        // result. 180s budget matches the legacy finalizeInvoice path —
        // Sepolia threshold network can take 90+ seconds under load and
        // 60s isn't enough to hit the happy path consistently.
        const TIMEOUT_MS = 180_000;
        const startedAt = Date.now();
        let result: { decryptedValue: bigint | boolean; signature: `0x${string}` } | null = null;
        while (Date.now() - startedAt < TIMEOUT_MS) {
          result = await decryptForTx(handle, "ebool");
          if (result) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!result) {
          throw new Error("Decryption timed out — try again in a moment");
        }
        const matched =
          typeof result.decryptedValue === "boolean"
            ? result.decryptedValue
            : result.decryptedValue !== 0n;

        setStep("finalizing");
        const submit = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "releaseInvoiceEscrow",
          args: [BigInt(invoiceId), matched, result.signature],
          gas: BigInt(5_000_000),
        });
        const hash = submit.hash;
        const receipt = submit.receipt
          ? submit.receipt
          : await publicClient.waitForTransactionReceipt({
              hash,
              confirmations: 1,
              timeout: 300_000,
            });
        if (receipt.status === "reverted") {
          throw new Error("Finalize reverted on-chain");
        }

        await updateInvoiceStatus(invoiceId, matched ? "paid" : "refunded");
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_FINALIZED,
          contract_address: contracts.BusinessHub,
          note: matched
            ? `Released escrow #${invoiceId} to vendor`
            : `Refunded escrow #${invoiceId} (amount mismatch)`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success(
          matched ? "Vendor paid — escrow released" : "Refunded — amount didn't match",
        );
        finishTransiently("success", 6000);
        return { hash, matched };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Finalize failed";
        toast.error(msg);
        finishTransiently("error");
        return null;
      }
    },
    [
      address,
      publicClient,
      step,
      contracts,
      unifiedWriteAndWait,
      decryptForTx,
      finishTransiently,
    ],
  );

  return {
    step,
    isPaying: step === "approving" || step === "encrypting" || step === "paying",
    isReleasing: step === "decrypting" || step === "finalizing",
    payEscrow,
    releaseEscrow,
  };
}
