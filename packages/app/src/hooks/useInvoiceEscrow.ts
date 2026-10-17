import { useState, useCallback, useRef, useEffect } from "react";
import { usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt } from "@/lib/cofhe-shim";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { Encryptable } from "@/lib/cofhe-shim";
import toast from "react-hot-toast";
import { MAX_UINT64 } from "@/lib/constants";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import { BusinessHubAbi, FHERC20VaultAbi } from "@/lib/abis";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { insertActivity, updateInvoiceStatus } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import {
  INVOICE_STATUS,
  PAYMENT_MODE,
  chooseFinalizeAction,
  formatWait,
  pollDecryptBool,
  readInvoiceSettlement,
  secondsUntilOpenRelease,
} from "@/lib/invoice-settlement";

// Hook for the trustless invoice escrow flow added in PR-C steps 1+2.
//
// Two operations:
//   payEscrow(invoiceId, amount)        — encrypt the amount, ensure vault
//                                         allowance, call payInvoiceEscrow.
//                                         Funds sit in BusinessHub.
//   releaseEscrow(invoiceId)            — read the payment mode, decrypt
//                                         the validation handle via the
//                                         Threshold Network, then call the
//                                         finalize that mode accepts
//                                         (releaseInvoiceEscrow for escrow:
//                                         vendor on match, payer refund on
//                                         mismatch; the vendor may do it 7
//                                         days after funding).
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
        toast.error("Connection lost. Please refresh.");
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
        const [encAmount, encAmountProof] = await encryptInputsAsync([
          Encryptable.uint64(amountWei),
        ],
        contracts.BusinessHub as `0x${string}`);

        setStep("paying");
        const result = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "payInvoiceEscrow",
          args: [BigInt(invoiceId), encAmount, encAmountProof],
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

        toast.success("Payment funded. Finalize to release to vendor.");
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

  // ── releaseEscrow — settle a funded invoice with its mode's finalize ──
  //
  // Escrow mode: releaseInvoiceEscrow, by the client or by anyone (the
  // vendor in practice) 7 days after funding. Match pays the vendor,
  // mismatch refunds the payer. Direct mode (paid from Business Tools):
  // payInvoiceFinalize by the client. Legacy records route as described in
  // lib/invoice-settlement.ts.
  const releaseEscrow = useCallback(
    async (invoiceId: number): Promise<{ hash: string; matched: boolean; viaEscrow: boolean } | null> => {
      if (!address) {
        toast.error("Connect a wallet first");
        return null;
      }
      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return null;
      }
      if (step !== "idle") return null;

      const hub = contracts.BusinessHub as `0x${string}`;
      try {
        clearTimeout(resetTimer.current);
        setStep("decrypting");

        const inv = (await publicClient.readContract({
          address: hub,
          abi: BusinessHubAbi,
          functionName: "getInvoice",
          args: [BigInt(invoiceId)],
        })) as readonly [string, string, string, bigint, string, bigint, number];
        if (Number(inv[6]) !== INVOICE_STATUS.PaymentPending) {
          throw new Error("This invoice is not waiting to be finalized.");
        }
        const me = address.toLowerCase();
        const settlement = await readInvoiceSettlement(publicClient, hub, invoiceId);
        let isLegacyEscrow = false;
        if (settlement.mode === PAYMENT_MODE.Legacy) {
          try {
            await publicClient.simulateContract({
              account: address as `0x${string}`,
              address: hub,
              abi: BusinessHubAbi,
              functionName: "revalidateLegacyInvoiceEscrow",
              args: [BigInt(invoiceId)],
            });
            isLegacyEscrow = true;
          } catch {
            isLegacyEscrow = false;
          }
        }
        const block = await publicClient.getBlock();
        const now = Number(block.timestamp);
        const isClient = inv[1].toLowerCase() === me;
        const action = chooseFinalizeAction({
          mode: settlement.mode,
          paidAt: settlement.paidAt,
          nowSeconds: now,
          isClient,
          isVendor: inv[0].toLowerCase() === me,
          isLegacyEscrow,
        });
        if (action.kind === "blocked") throw new Error(action.reason);

        if (action.kind === "revalidateThenRelease") {
          setStep("finalizing");
          await unifiedWriteAndWait({
            address: hub,
            abi: BusinessHubAbi,
            functionName: "revalidateLegacyInvoiceEscrow",
            args: [BigInt(invoiceId)],
            gas: BigInt(3_000_000),
          });
          if (!isClient) {
            const after = await readInvoiceSettlement(publicClient, hub, invoiceId);
            const wait = secondsUntilOpenRelease(after.paidAt, now);
            if (wait > 0) throw new Error(`Payment check refreshed. Anyone can release it in ${formatWait(wait)}.`);
          }
          setStep("decrypting");
        }
        const viaEscrow = action.kind !== "payInvoiceFinalize";

        const handle = (await publicClient.readContract({
          address: hub,
          abi: BusinessHubAbi,
          functionName: "getInvoiceValidationHandle",
          args: [BigInt(invoiceId)],
        })) as bigint;
        if (!handle || handle === 0n) {
          throw new Error("Invoice not funded yet. Nothing to finalize.");
        }
        // Sepolia threshold network can take 90+ seconds under load.
        const { value: matched, signature } = await pollDecryptBool(decryptForTx, handle);

        setStep("finalizing");
        const submit = await unifiedWriteAndWait({
          address: hub,
          abi: BusinessHubAbi,
          functionName: viaEscrow ? "releaseInvoiceEscrow" : "payInvoiceFinalize",
          args: [BigInt(invoiceId), matched, signature],
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

        await updateInvoiceStatus(invoiceId, matched ? "paid" : viaEscrow ? "refunded" : "disputed");
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_FINALIZED,
          contract_address: contracts.BusinessHub,
          note: matched
            ? viaEscrow
              ? `Released escrow #${invoiceId} to vendor`
              : `Finalized invoice #${invoiceId}`
            : viaEscrow
              ? `Refunded escrow #${invoiceId} (amount mismatch)`
              : `Finalized invoice #${invoiceId} (disputed, amount mismatch)`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        if (matched) toast.success("Vendor paid.");
        else if (viaEscrow) toast.success("Amount did not match. The payment went back to the payer.");
        else toast.error("Amount did not match. The invoice is disputed and the vendor must refund it.");
        finishTransiently("success", 6000);
        return { hash, matched, viaEscrow };
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
