import { useState, useCallback, useRef, useEffect } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { BusinessHubAbi, FHERC20VaultAbi, TestUSDCAbi } from "@/lib/abis";
import { insertInvoice, insertEscrow, insertActivity, updateEscrowStatus, updateInvoiceStatus } from "@/lib/supabase";
import { insertActivitiesFanout } from "@/lib/activity-fanout";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { extractEventId } from "@/lib/event-parser";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";

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

type Step = "idle" | "encrypting" | "approving" | "sending" | "success" | "error";

export function useBusinessHub() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { connected } = useCofheConnection();
  const { contracts, activeChainId } = useChain();
  // usePublicClient() without chainId defaults to wagmi's first configured
  // chain (ETH Sepolia) for passkey-only users who don't have a wagmi-
  // connected EOA. That made read calls hit the wrong chain's contract and
  // return "0x" (no data). Pass activeChainId explicitly so reads go to
  // the same chain the user's passkey + activeChainId actually target.
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { encryptInputsAsync } = useCofheEncrypt();
  const { decryptForTx } = useCofheDecryptForTx();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const [step, setStep] = useState<Step>("idle");

  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Helper to set step with auto-reset
  function setStepWithReset(newStep: "success" | "error", delay: number) {
    clearTimeout(resetTimerRef.current);
    setStep(newStep);
    resetTimerRef.current = setTimeout(() => setStep("idle"), delay);
  }

  // Cleanup on unmount
  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  const createInvoice = useCallback(
    async (client: string, amount: string, description: string, dueDate: number) => {
      if (!address || !connected) {
        toast.error("Please connect your wallet");
        return;
      }
      if (step === "approving" || step === "encrypting" || step === "sending") return; // Already submitting

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        clearTimeout(resetTimerRef.current);
        setStep("approving");

        // Ensure the BusinessHub contract is approved to transferFrom on the vault
        if (!isVaultApproved(contracts.BusinessHub)) {
          await ensureVaultApproval(
            unifiedWrite,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            contracts.BusinessHub as `0x${string}`,
          );
          markVaultApproved(contracts.BusinessHub);
        }

        if (!amount || amount.trim() === "") {
          toast.error("Enter an amount");
          setStep("idle");
          return;
        }

        setStep("encrypting");
        const amountWei = parseUnits(amount, 6);
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(amountWei)]);

        setStep("sending");
        const writeResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "createInvoice",
          args: [
            client as `0x${string}`,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            // whose shape doesn't match wagmi's strict ABI-inferred arg types
            encAmount as unknown as EncryptedInput,
            description,
            BigInt(dueDate),
          ],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = writeResult.hash;

        const invoiceReceipt =
          writeResult.receipt ??
          (await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }));
        if (invoiceReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract real invoice ID from event logs
        const invoiceId = extractEventId(invoiceReceipt.logs, contracts.BusinessHub);

        await insertInvoice({
          invoice_id: invoiceId,
          vendor_address: address,
          client_address: client,
          description,
          due_date: new Date(dueDate * 1000).toISOString(),
          status: "pending",
          tx_hash: hash,
        });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: client.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_CREATED,
          contract_address: contracts.BusinessHub,
          note: description,
          token_address: contracts.FHERC20Vault_USDC,
          // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
          block_number: Number(invoiceReceipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStepWithReset("success", 6000);
        toast.success("Invoice sent!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invoice failed";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.BusinessHub);
        }
        setStepWithReset("error", 5000);
        toast.error(msg);
      }
    },
    [address, connected, step, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  const runPayroll = useCallback(
    async (employees: string[], amounts: string[]) => {
      if (!address || !connected) {
        toast.error("Please connect your wallet");
        return;
      }
      if (employees.length !== amounts.length || employees.length === 0) {
        toast.error("Invalid payroll data");
        return;
      }
      if (step === "approving" || step === "encrypting" || step === "sending") return; // Already submitting

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        clearTimeout(resetTimerRef.current);
        setStep("approving");

        // Ensure the BusinessHub contract is approved to transferFrom on the vault
        if (!isVaultApproved(contracts.BusinessHub)) {
          await ensureVaultApproval(
            unifiedWrite,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            contracts.BusinessHub as `0x${string}`,
          );
          markVaultApproved(contracts.BusinessHub);
        }

        // Validate all amounts before encrypting
        for (const a of amounts) {
          if (!a || a.trim() === "") {
            toast.error("All employee amounts must be filled in");
            setStep("idle");
            return;
          }
        }

        setStep("encrypting");
        const encSalaries = await encryptInputsAsync(
          amounts.map((a) => Encryptable.uint64(parseUnits(a, 6)))
        );

        setStep("sending");
        const payrollResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "runPayroll",
          args: [
            employees as `0x${string}`[],
            contracts.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            encSalaries as unknown as EncryptedInput[],
          ],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = payrollResult.hash;

        // Wait for on-chain confirmation before writing to Supabase
        const payrollReceipt = payrollResult.receipt
          ? payrollResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (payrollReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Create one activity per employee so each gets a notification.
        // Parallel fanout (Promise.allSettled) so a single row failure doesn't
        // halt sync for the remaining employees. Preserves the per-employee
        // tx_hash suffix so Supabase upsert on tx_hash still works per-row.
        await insertActivitiesFanout(
          employees.map((recipient) => ({
            tx_hash: `${hash}_${recipient.toLowerCase()}`,
            user_from: address.toLowerCase(),
            user_to: recipient.toLowerCase(),
            activity_type: ACTIVITY_TYPES.PAYROLL,
            contract_address: contracts.BusinessHub,
            note: `Payroll from ${address.slice(0, 6)}...`,
            token_address: contracts.TestUSDC,
            // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
            block_number: Number(payrollReceipt.blockNumber),
          })),
          { userToastOnFailure: true, context: "payroll" },
        );

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStepWithReset("success", 6000);
        toast.success(`Payroll sent to ${employees.length} employees!`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Payroll failed";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.BusinessHub);
        }
        setStepWithReset("error", 5000);
        toast.error(msg);
      }
    },
    [address, connected, step, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  const createEscrow = useCallback(
    async (beneficiary: string, amount: string, description: string, arbiter: string, deadline: number) => {
      if (!address || !connected) {
        toast.error("Please connect your wallet");
        return;
      }
      if (step === "approving" || step === "sending") return; // Already submitting

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        if (!amount || amount.trim() === "") {
          toast.error("Enter an amount");
          return;
        }

        clearTimeout(resetTimerRef.current);
        // Step 1: Approve BusinessHub to spend the underlying ERC20 (TestUSDC)
        // The contract calls underlying.transferFrom(msg.sender, address(this), plaintextAmount)
        setStep("approving");
        const escrowAmount = BigInt(parseUnits(amount, 6));

        const approvalToastId = toast.loading("Approving escrow deposit...");
        const approvalAaResult = await unifiedWriteAndWait({
          address: contracts.TestUSDC as `0x${string}`,
          abi: TestUSDCAbi,
          functionName: "approve",
          args: [contracts.BusinessHub as `0x${string}`, escrowAmount],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const approvalHash = approvalAaResult.hash;

        // Wait for approval to be mined before proceeding
        const approvalReceipt = approvalAaResult.receipt
          ? approvalAaResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash: approvalHash, confirmations: 1, timeout: 300_000 });
        if (approvalReceipt.status === "reverted") {
          throw new Error("Approval transaction reverted on-chain");
        }
        toast.success("Approved!", { id: approvalToastId });

        // Step 2: Create the escrow (now that BusinessHub can transferFrom our tokens)
        setStep("sending");
        const escrowToastId = toast.loading("Creating escrow...");
        const escrowAaResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "createEscrow",
          args: [
            beneficiary as `0x${string}`,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            escrowAmount,
            description,
            (arbiter || "0x0000000000000000000000000000000000000000") as `0x${string}`,
            BigInt(deadline),
          ],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = escrowAaResult.hash;

        // Wait for on-chain confirmation before writing to Supabase
        const escrowReceipt = escrowAaResult.receipt
          ? escrowAaResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (escrowReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract real escrow ID from event logs
        const escrowId = extractEventId(escrowReceipt.logs, contracts.BusinessHub);

        await insertEscrow({
          escrow_id: escrowId,
          depositor_address: address,
          beneficiary_address: beneficiary,
          arbiter_address: arbiter || "",
          description,
          plaintext_amount: parseFloat(amount),
          deadline: new Date(deadline * 1000).toISOString(),
          status: "active",
          tx_hash: hash,
        });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: beneficiary.toLowerCase(),
          activity_type: ACTIVITY_TYPES.ESCROW_CREATED,
          contract_address: contracts.BusinessHub,
          note: description,
          token_address: contracts.FHERC20Vault_USDC,
          // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
          block_number: Number(escrowReceipt.blockNumber),
        });

        // Arbiter discovery: Carol's app won't know Alice named her as arbiter
        // unless we insert an activity row with user_to = arbiter. Use a
        // suffixed tx_hash so the upsert-by-tx_hash doesn't collide with the
        // beneficiary row above. Skip if arbiter is unset, or matches
        // depositor/beneficiary (which would duplicate notifications).
        if (
          arbiter &&
          arbiter !== "0x0000000000000000000000000000000000000000" &&
          arbiter.toLowerCase() !== address.toLowerCase() &&
          arbiter.toLowerCase() !== beneficiary.toLowerCase()
        ) {
          await insertActivity({
            tx_hash: `${hash}:arbiter`,
            user_from: address.toLowerCase(),
            user_to: arbiter.toLowerCase(),
            activity_type: ACTIVITY_TYPES.ESCROW_ARBITER_NAMED,
            contract_address: contracts.BusinessHub,
            note: description,
            token_address: contracts.FHERC20Vault_USDC,
            block_number: Number(escrowReceipt.blockNumber),
          });
        }

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStepWithReset("success", 6000);
        toast.success("Escrow created!", { id: escrowToastId });
      } catch (err) {
        setStepWithReset("error", 5000);
        toast.error(err instanceof Error ? err.message : "Escrow failed");
      }
    },
    [address, connected, step, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  const finalizeInvoice = useCallback(
    async (invoiceId: number) => {
      console.log("[finalizeInvoice] entry", { invoiceId, step, hasAddress: !!address, hasPublicClient: !!publicClient });
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") {
        console.log("[finalizeInvoice] bail — step:", step);
        return;
      }

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        // v0.1.3 finalize flow:
        // 1. Read the validation handle (ebool) from the contract
        // 2. Fetch off-chain decryption + Threshold Network signature
        // 3. Submit (matchPlaintext, signature) to payInvoiceFinalize
        console.log("[finalizeInvoice] reading validation handle for invoice", invoiceId);
        const validationHandle = (await publicClient.readContract({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "getInvoiceValidationHandle",
          args: [BigInt(invoiceId)],
        })) as bigint;
        console.log("[finalizeInvoice] validationHandle =", validationHandle.toString());
        if (!validationHandle || validationHandle === 0n) {
          throw new Error("Invoice not paid yet — nothing to finalize");
        }

        // Poll Threshold Network for the decrypted result (~10s typical)
        const TIMEOUT_MS = 60_000;
        const startedAt = Date.now();
        let result: { decryptedValue: bigint | boolean; signature: `0x${string}` } | null = null;
        while (Date.now() - startedAt < TIMEOUT_MS) {
          result = await decryptForTx(validationHandle, "ebool");
          if (result) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!result) {
          throw new Error("Decryption timed out — try Finalize again in a moment");
        }
        const matchPlaintext =
          typeof result.decryptedValue === "boolean"
            ? result.decryptedValue
            : result.decryptedValue !== 0n;

        const finalizeAaResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "payInvoiceFinalize",
          args: [BigInt(invoiceId), matchPlaintext, result.signature],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = finalizeAaResult.hash;
        const finalizeReceipt = finalizeAaResult.receipt
          ? finalizeAaResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (finalizeReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_FINALIZED,
          contract_address: contracts.BusinessHub,
          note: matchPlaintext
            ? `Finalized invoice #${invoiceId}`
            : `Finalized invoice #${invoiceId} (refunded — amount mismatch)`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(finalizeReceipt.blockNumber),
        });

        await updateInvoiceStatus(invoiceId, matchPlaintext ? "paid" : "refunded");

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success(matchPlaintext ? "Invoice finalized!" : "Invoice refunded — amount mismatch");
        setStepWithReset("success", 6000);
      } catch (err) {
        console.error("[finalizeInvoice] ERROR:", err);
        toast.error(err instanceof Error ? err.message : "Failed to finalize");
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, step, decryptForTx, contracts]
  );

  const markDelivered = useCallback(
    async (escrowId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") return;

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        const deliveredResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "markDelivered",
          args: [BigInt(escrowId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = deliveredResult.hash;
        const receipt = deliveredResult.receipt
          ? deliveredResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.ESCROW_DELIVERED,
          contract_address: contracts.BusinessHub,
          note: `Marked escrow #${escrowId} as delivered`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");

        toast.success("Marked as delivered!");
        setStepWithReset("success", 6000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to mark delivered");
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, step, contracts],
  );

  const approveRelease = useCallback(
    async (escrowId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") return;

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        const approveAaResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "approveRelease",
          args: [BigInt(escrowId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = approveAaResult.hash;
        const receipt = approveAaResult.receipt
          ? approveAaResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await updateEscrowStatus(escrowId, "released");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.ESCROW_RELEASED,
          contract_address: contracts.BusinessHub,
          note: `Released escrow #${escrowId}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Escrow funds released!");
        setStepWithReset("success", 6000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to release escrow");
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, step, contracts],
  );

  const disputeEscrow = useCallback(
    async (escrowId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") return;

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        const disputeResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "disputeEscrow",
          args: [BigInt(escrowId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = disputeResult.hash;
        const receipt = disputeResult.receipt
          ? disputeResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await updateEscrowStatus(escrowId, "disputed");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.ESCROW_DISPUTED,
          contract_address: contracts.BusinessHub,
          note: `Disputed escrow #${escrowId}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");

        toast.success("Escrow disputed");
        setStepWithReset("success", 6000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to dispute escrow");
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, step, contracts],
  );

  const payInvoice = useCallback(
    async (invoiceId: number, amount: string) => {
      if (!address || !connected) {
        toast.error("Please connect your wallet");
        return;
      }
      if (step === "approving" || step === "encrypting" || step === "sending") return;

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        if (!amount || amount.trim() === "") {
          toast.error("Enter an amount");
          return;
        }

        clearTimeout(resetTimerRef.current);
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
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(amountWei)]);

        setStep("sending");
        // unifiedWriteAndWait forwards the relay-side receipt to skip the
        // public-RPC poll that hangs under testnet throttling.
        const payResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "payInvoice",
          args: [
            BigInt(invoiceId),
            encAmount as unknown as EncryptedInput,
          ],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = payResult.hash;
        const receipt = payResult.receipt
          ? payResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await updateInvoiceStatus(invoiceId, "payment_pending");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_PAYMENT,
          contract_address: contracts.BusinessHub,
          note: `Paid invoice #${invoiceId}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStepWithReset("success", 6000);
        toast.success("Invoice payment submitted!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Payment failed";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.BusinessHub);
        }
        setStepWithReset("error", 5000);
        toast.error(msg);
      }
    },
    [address, connected, step, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  const cancelInvoice = useCallback(
    async (invoiceId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") return;

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        const cancelResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "cancelInvoice",
          args: [BigInt(invoiceId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = cancelResult.hash;
        const receipt = cancelResult.receipt
          ? cancelResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await updateInvoiceStatus(invoiceId, "cancelled");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_CANCELLED,
          contract_address: contracts.BusinessHub,
          note: `Cancelled invoice #${invoiceId}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");

        toast.success("Invoice cancelled");
        setStepWithReset("success", 6000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to cancel invoice");
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, step, contracts]
  );

  const arbiterDecide = useCallback(
    async (escrowId: number, releaseToBeneficiary: boolean) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") return;

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        // Read the escrow up-front so we can notify BOTH depositor and beneficiary
        // in addition to the arbiter. Without this, the non-arbiter parties
        // won't see a realtime activity for the decision.
        let depositorAddr: string | null = null;
        let beneficiaryAddr: string | null = null;
        try {
          const escrowData = (await publicClient.readContract({
            address: contracts.BusinessHub as `0x${string}`,
            abi: BusinessHubAbi,
            functionName: "getEscrow",
            args: [BigInt(escrowId)],
          })) as readonly [string, string, string, string, bigint, string, bigint, number];
          depositorAddr = escrowData[0];
          beneficiaryAddr = escrowData[1];
        } catch {
          // Non-fatal — arbiter row still gets inserted below
        }

        const arbiterResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "arbiterDecide",
          args: [BigInt(escrowId), releaseToBeneficiary],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = arbiterResult.hash;
        const receipt = arbiterResult.receipt
          ? arbiterResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await updateEscrowStatus(escrowId, releaseToBeneficiary ? "released" : "expired");

        const note = `Arbiter ${releaseToBeneficiary ? "released" : "rejected"} escrow #${escrowId}`;

        // Arbiter's own row (keyed on base tx_hash)
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.ESCROW_ARBITER_DECIDED,
          contract_address: contracts.BusinessHub,
          note,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        // Depositor notification (skip if arbiter == depositor)
        if (
          depositorAddr &&
          depositorAddr.toLowerCase() !== address.toLowerCase()
        ) {
          await insertActivity({
            tx_hash: `${hash}:depositor`,
            user_from: address.toLowerCase(),
            user_to: depositorAddr.toLowerCase(),
            activity_type: ACTIVITY_TYPES.ESCROW_ARBITER_DECIDED,
            contract_address: contracts.BusinessHub,
            note,
            token_address: contracts.FHERC20Vault_USDC,
            block_number: Number(receipt.blockNumber),
          });
        }

        // Beneficiary notification (skip duplicates)
        if (
          beneficiaryAddr &&
          beneficiaryAddr.toLowerCase() !== address.toLowerCase() &&
          beneficiaryAddr.toLowerCase() !== (depositorAddr ?? "").toLowerCase()
        ) {
          await insertActivity({
            tx_hash: `${hash}:beneficiary`,
            user_from: address.toLowerCase(),
            user_to: beneficiaryAddr.toLowerCase(),
            activity_type: ACTIVITY_TYPES.ESCROW_ARBITER_DECIDED,
            contract_address: contracts.BusinessHub,
            note,
            token_address: contracts.FHERC20Vault_USDC,
            block_number: Number(receipt.blockNumber),
          });
        }

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success(releaseToBeneficiary ? "Funds released to beneficiary" : "Funds returned to depositor");
        setStepWithReset("success", 6000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Arbiter decision failed");
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, step, contracts]
  );

  const claimExpiredEscrow = useCallback(
    async (escrowId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") return;

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        const expireResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "claimExpiredEscrow",
          args: [BigInt(escrowId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = expireResult.hash;
        const receipt = expireResult.receipt
          ? expireResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await updateEscrowStatus(escrowId, "expired");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.ESCROW_EXPIRED_CLAIMED,
          contract_address: contracts.BusinessHub,
          note: `Claimed expired escrow #${escrowId}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Expired escrow funds reclaimed!");
        setStepWithReset("success", 6000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to claim expired escrow");
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, step, contracts]
  );

  const reset = useCallback(() => setStep("idle"), []);

  return { step, createInvoice, runPayroll, createEscrow, finalizeInvoice, markDelivered, approveRelease, disputeEscrow, payInvoice, cancelInvoice, arbiterDecide, claimExpiredEscrow, reset };
}
