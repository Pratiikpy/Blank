import { useState, useCallback, useRef, useEffect } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { CONTRACTS, MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { BusinessHubAbi, FHERC20VaultAbi, TestUSDCAbi } from "@/lib/abis";
import { insertInvoice, insertEscrow, insertActivity } from "@/lib/supabase";
import { extractEventId } from "@/lib/event-parser";
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

type Step = "idle" | "encrypting" | "approving" | "sending" | "success" | "error";

export function useBusinessHub() {
  const { address } = useAccount();
  const { connected } = useCofheConnection();
  const publicClient = usePublicClient();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { writeContractAsync } = useWriteContract();
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
        if (!isVaultApproved(CONTRACTS.BusinessHub)) {
          await ensureVaultApproval(
            writeContractAsync,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            CONTRACTS.BusinessHub as `0x${string}`,
          );
          markVaultApproved(CONTRACTS.BusinessHub);
        }

        setStep("encrypting");
        const amountWei = parseUnits(amount, 6);
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(amountWei)]);

        setStep("sending");
        const hash = await writeContractAsync({
          address: CONTRACTS.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "createInvoice",
          args: [
            client as `0x${string}`,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            // whose shape doesn't match wagmi's strict ABI-inferred arg types
            encAmount as unknown as EncryptedInput,
            description,
            BigInt(dueDate),
          ],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const invoiceReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (invoiceReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract real invoice ID from event logs
        const invoiceId = extractEventId(invoiceReceipt.logs, CONTRACTS.BusinessHub);

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
          activity_type: "invoice_created",
          contract_address: CONTRACTS.BusinessHub,
          note: description,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          // Safe: Base Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
          block_number: Number(invoiceReceipt.blockNumber),
        });

        setStepWithReset("success", 3000);
        toast.success("Invoice sent!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invoice failed";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(CONTRACTS.BusinessHub);
        }
        setStepWithReset("error", 5000);
        toast.error(msg);
      }
    },
    [address, connected, step, encryptInputsAsync, writeContractAsync, publicClient]
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
        if (!isVaultApproved(CONTRACTS.BusinessHub)) {
          await ensureVaultApproval(
            writeContractAsync,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            CONTRACTS.BusinessHub as `0x${string}`,
          );
          markVaultApproved(CONTRACTS.BusinessHub);
        }

        setStep("encrypting");
        const encSalaries = await encryptInputsAsync(
          amounts.map((a) => Encryptable.uint64(parseUnits(a, 6)))
        );

        setStep("sending");
        const hash = await writeContractAsync({
          address: CONTRACTS.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "runPayroll",
          args: [
            employees as `0x${string}`[],
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            encSalaries as unknown as EncryptedInput[],
          ],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const payrollReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (payrollReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Create one activity per employee so each gets a notification
        for (const employee of employees) {
          await insertActivity({
            tx_hash: `${hash}_${employee.toLowerCase()}`,
            user_from: address.toLowerCase(),
            user_to: employee.toLowerCase(),
            activity_type: "payroll",
            contract_address: CONTRACTS.BusinessHub,
            note: `Paid ${employees.length} employees`,
            token_address: CONTRACTS.FHERC20Vault_USDC,
            // Safe: Base Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
            block_number: Number(payrollReceipt.blockNumber),
          });
        }

        setStepWithReset("success", 3000);
        toast.success(`Payroll sent to ${employees.length} employees!`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Payroll failed";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(CONTRACTS.BusinessHub);
        }
        setStepWithReset("error", 5000);
        toast.error(msg);
      }
    },
    [address, connected, step, encryptInputsAsync, writeContractAsync, publicClient]
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
        clearTimeout(resetTimerRef.current);
        // Step 1: Approve BusinessHub to spend the underlying ERC20 (TestUSDC)
        // The contract calls underlying.transferFrom(msg.sender, address(this), plaintextAmount)
        setStep("approving");
        const escrowAmount = BigInt(parseUnits(amount, 6));

        const approvalToastId = toast.loading("Approving escrow deposit...");
        const approvalHash = await writeContractAsync({
          address: CONTRACTS.TestUSDC as `0x${string}`,
          abi: TestUSDCAbi,
          functionName: "approve",
          args: [CONTRACTS.BusinessHub as `0x${string}`, escrowAmount],
        });

        // Wait for approval to be mined before proceeding
        const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash, confirmations: 1 });
        if (approvalReceipt.status === "reverted") {
          throw new Error("Approval transaction reverted on-chain");
        }
        toast.success("Approved!", { id: approvalToastId });

        // Step 2: Create the escrow (now that BusinessHub can transferFrom our tokens)
        setStep("sending");
        const escrowToastId = toast.loading("Creating escrow...");
        const hash = await writeContractAsync({
          address: CONTRACTS.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "createEscrow",
          args: [
            beneficiary as `0x${string}`,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            escrowAmount,
            description,
            (arbiter || "0x0000000000000000000000000000000000000000") as `0x${string}`,
            BigInt(deadline),
          ],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (escrowReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract real escrow ID from event logs
        const escrowId = extractEventId(escrowReceipt.logs, CONTRACTS.BusinessHub);

        await insertEscrow({
          escrow_id: escrowId,
          depositor_address: address,
          beneficiary_address: beneficiary,
          arbiter_address: arbiter || "",
          description,
          deadline: new Date(deadline * 1000).toISOString(),
          status: "active",
          tx_hash: hash,
        });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: beneficiary.toLowerCase(),
          activity_type: "escrow_created",
          contract_address: CONTRACTS.BusinessHub,
          note: description,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          // Safe: Base Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
          block_number: Number(escrowReceipt.blockNumber),
        });

        setStepWithReset("success", 3000);
        toast.success("Escrow created!", { id: escrowToastId });
      } catch (err) {
        setStepWithReset("error", 5000);
        toast.error(err instanceof Error ? err.message : "Escrow failed");
      }
    },
    [address, connected, step, writeContractAsync, publicClient]
  );

  const finalizeInvoice = useCallback(
    async (invoiceId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") return;

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        const hash = await writeContractAsync({
          address: CONTRACTS.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "payInvoiceFinalize",
          args: [BigInt(invoiceId)],
        });

        const finalizeReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (finalizeReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        toast.success("Invoice finalized!");
        setStepWithReset("success", 3000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to finalize");
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, writeContractAsync, step]
  );

  const reset = useCallback(() => setStep("idle"), []);

  return { step, createInvoice, runPayroll, createEscrow, finalizeInvoice, reset };
}
