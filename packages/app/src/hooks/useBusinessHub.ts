import { useState, useCallback, useRef, useEffect } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits, keccak256, stringToBytes } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@/lib/cofhe-shim";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { Encryptable } from "@/lib/cofhe-shim";
import toast from "react-hot-toast";
import { toastMappedError } from "@/lib/error-messages";
import { log } from "@/lib/log";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { BusinessHubAbi, FHERC20VaultAbi, TestUSDCAbi } from "@/lib/abis";
import { insertInvoice, insertEscrow, insertActivity, updateEscrowStatus, updateInvoiceStatus, setInvoicePdfCid } from "@/lib/supabase";
import { lookupName } from "@/lib/address-resolver";
import { renderAndPinInvoicePdf } from "@/lib/invoice-pdf";
import { truncateAddress } from "@/lib/address";
import { sendInvoiceEmail, buildInvoiceEmailSignableMessage } from "@/lib/email-client";
import { buildInvoiceLink } from "@/lib/invoice-links";
import { useEmailAuthSigner } from "./useEmailAuthSigner";
import { setEscrowAttachmentCid } from "@/lib/supabase";
import { pinFile } from "@/lib/ipfs";
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
  const { signEmailAuth } = useEmailAuthSigner();
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
    async (
      client: string,
      amount: string,
      description: string,
      dueDate: number,
      clientEmail?: string,
    ) => {
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
        if (invoiceId === null) {
          throw new Error("Tx mined but invoiceId could not be read; check History tab.");
        }

        await insertInvoice({
          invoice_id: invoiceId,
          vendor_address: address,
          client_address: client,
          description,
          due_date: new Date(dueDate * 1000).toISOString(),
          status: "pending",
          tx_hash: hash,
          client_email: clientEmail?.trim() || null,
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

        // Phase 1.1 + 1.3: render an invoice PDF, pin to IPFS, then fire an
        // email to the client (when an address is on file). Fire-and-forget
        // — the on-chain invoice and Supabase row are already saved; any
        // failure here only delays the email/PDF, which we can retry later.
        // Skipped silently when PINATA_JWT or Resend env vars are missing.
        const trimmedEmail = clientEmail?.trim();
        void (async () => {
          try {
            const [vendorName, clientName] = await Promise.all([
              lookupName(address as `0x${string}`),
              lookupName(client as `0x${string}`),
            ]);
            const issueDate = new Date().toISOString();
            const dueDateIso = new Date(dueDate * 1000).toISOString();
            const origin =
              typeof window !== "undefined" && window.location
                ? window.location.origin
                : (import.meta.env.VITE_PUBLIC_APP_URL ?? "https://blank.app");
            // PR-C step 4: link emails directly to the new escrow page so
            // clients land on the real flow (not a placeholder /pay route
            // that was never mounted). Amount stays out of the URL — it
            // lives encrypted on-chain.
            const payUrl = buildInvoiceLink(activeChainId, invoiceId, origin);
            const { cid } = await renderAndPinInvoicePdf({
              invoiceId,
              vendor: { name: vendorName ?? truncateAddress(address), address },
              client: { name: clientName ?? truncateAddress(client), address: client },
              issueDate,
              dueDate: dueDateIso,
              description,
              amount,
              payUrl,
            });
            await setInvoicePdfCid(invoiceId, cid);

            // Phase 3.5: anchor keccak256(cid) on-chain so a third party can
            // verify the off-chain Pinata file hasn't been swapped. Best
            // effort — guarded so a missed upgrade or wallet-prompt rejection
            // doesn't undo the rest of the invoice flow.
            try {
              const cidHash = keccak256(stringToBytes(cid));
              await unifiedWriteAndWait({
                address: contracts.BusinessHub as `0x${string}`,
                abi: BusinessHubAbi,
                functionName: "setInvoicePdfCidHash",
                args: [BigInt(invoiceId), cidHash],
                gas: BigInt(150_000),
              });
            } catch (anchorErr) {
              log.warn("useBusinessHub.invoice.cidAnchor.failed", anchorErr instanceof Error ? anchorErr : new Error(String(anchorErr)));
            }

            // Email-out (only when we have a client email AND Resend is wired).
            // Phase 7-followup: sign the canonical message so the server
            // can verify the call really came from the invoice's vendor.
            // If signing fails (user dismissed passphrase prompt etc.),
            // fall through unsigned — server's soft mode accepts those
            // until STRICT_EMAIL_AUTH=1 flips on in production.
            if (trimmedEmail) {
              const signedAt = Math.floor(Date.now() / 1000);
              const message = buildInvoiceEmailSignableMessage({
                invoiceId,
                recipient: trimmedEmail,
                signedAt,
                chainId: activeChainId,
              });
              let auth: Awaited<ReturnType<typeof signEmailAuth>> = null;
              try {
                auth = await signEmailAuth(message, signedAt);
              } catch (signErr) {
                log.warn("useBusinessHub.invoice.emailSigning.skipped", signErr instanceof Error ? signErr : new Error(String(signErr)));
              }
              const result = await sendInvoiceEmail({
                invoiceId,
                recipientEmail: trimmedEmail,
                amount,
                payUrl,
                vendorName: vendorName ?? truncateAddress(address),
                ...(auth ?? {}),
              });
              if (!result.ok) {
                log.warn("useBusinessHub.invoice.emailSend.failed", { error: String(result.error) });
              }
            }
          } catch (pdfErr) {
            // PDF / email is best-effort — invoice itself already succeeded.
            log.warn("useBusinessHub.invoice.pdfEmailPipeline.failed", pdfErr instanceof Error ? pdfErr : new Error(String(pdfErr)));
          }
        })();
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
          // FHE precompile gas can't be estimated by the EVM. runPayroll
          // does ~13 FHE ops per recipient (gte + and + select + sub +
          // add + allow x6) inside transferFromVerified, plus ZK input
          // verification on each encrypted salary. CoFHE precompiles are
          // ~200-400K gas each. Empirical: 3M base + 3M per recipient.
          // Without this an N≥2 batch hits buildUserOp's 2M default
          // callGasLimit and reverts with empty data; with too-high a
          // figure the bundler tx exceeds the RPC per-tx gas cap.
          gas: BigInt(3_000_000) + BigInt(employees.length) * BigInt(3_000_000),
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
    async (
      beneficiary: string,
      amount: string,
      description: string,
      arbiter: string,
      deadline: number,
      attachmentFile?: File | null,
    ) => {
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
        if (escrowId === null) {
          throw new Error("Tx mined but escrowId could not be read; check History tab.");
        }

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

        // Phase 3.4: optional IPFS attachment (project brief, contract, etc).
        // Fire-and-forget — escrow itself already succeeded; an attachment
        // upload failure only delays the file landing on the row, which can
        // be retried later. Skipped silently when PINATA_JWT is missing.
        if (attachmentFile) {
          void (async () => {
            try {
              const { cid } = await pinFile(attachmentFile, {
                name: `escrow-${escrowId}-${attachmentFile.name}`,
              });
              await setEscrowAttachmentCid(escrowId, cid);

              // Phase 3.5: anchor keccak256(cid) on-chain — same rationale
              // as the invoice flow above.
              try {
                const cidHash = keccak256(stringToBytes(cid));
                await unifiedWriteAndWait({
                  address: contracts.BusinessHub as `0x${string}`,
                  abi: BusinessHubAbi,
                  functionName: "setEscrowAttachmentCidHash",
                  args: [BigInt(escrowId), cidHash],
                  gas: BigInt(150_000),
                });
              } catch (anchorErr) {
                log.warn("useBusinessHub.escrow.cidAnchor.failed", anchorErr instanceof Error ? anchorErr : new Error(String(anchorErr)));
              }
            } catch (uploadErr) {
              log.warn("useBusinessHub.escrow.attachmentUpload.failed", uploadErr instanceof Error ? uploadErr : new Error(String(uploadErr)));
            }
          })();
        }
      } catch (err) {
        setStepWithReset("error", 5000);
        toastMappedError(err);
      }
    },
    [address, connected, step, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  const finalizeInvoice = useCallback(
    async (invoiceId: number) => {
      log.debug("useBusinessHub.finalizeInvoice.entry", { invoiceId, step, hasAddress: !!address, hasPublicClient: !!publicClient });
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step !== "idle") {
        log.debug("useBusinessHub.finalizeInvoice.bail", { step });
        return;
      }

      clearTimeout(resetTimerRef.current);
      setStep("sending");
      try {
        // v0.1.3 finalize flow:
        // 1. Read the validation handle (ebool) from the contract
        // 2. Fetch off-chain decryption + Threshold Network signature
        // 3. Submit (matchPlaintext, signature) to payInvoiceFinalize
        log.debug("useBusinessHub.finalizeInvoice.readingHandle", { invoiceId });
        const validationHandle = (await publicClient.readContract({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "getInvoiceValidationHandle",
          args: [BigInt(invoiceId)],
        })) as bigint;
        log.debug("useBusinessHub.finalizeInvoice.validationHandle", { handle: validationHandle.toString() });
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
        log.error("useBusinessHub.finalizeInvoice.error", err instanceof Error ? err : new Error(String(err)));
        toastMappedError(err);
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
        toastMappedError(err);
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
        toastMappedError(err);
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
        toastMappedError(err);
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

  /**
   * Phase 5.6 — pay an invoice using ANY ERC-20 (USDT, WETH, etc.) by routing
   * through Uniswap v3 SwapRouter02 to the invoice's underlying token (USDC).
   * Mirrors `payInvoice` for the FHE encrypted-match flow — caller still
   * provides `amount` (the invoice's USDC amount, off-chain decrypted) so
   * the encryption verification gate is identical. Subsequent
   * `payInvoiceFinalize` flips Paid/Disputed based on the FHE match result.
   *
   * Same-token short-circuit: if `payToken == FHERC20Vault_USDC.underlying()`
   * (i.e. payer is paying USDC for a USDC invoice), the contract skips the
   * Uniswap call entirely. We mirror that here by passing `payAmountInMax
   * == expectedUsdcOut` — the contract enforces equality.
   *
   * Privacy trade-off: during the swap window the amount is publicly visible
   * on Uniswap, AND the vendor receives plaintext USDC. Documented in the UI.
   */
  const payInvoiceWithSwap = useCallback(
    async (params: {
      invoiceId: number;
      /** Caller's pay-token address (USDT / WETH / etc.). */
      payToken: `0x${string}`;
      /** Upper bound on payToken to spend. Sized as
       *  `expectedUsdcOut * (current rate) * (1 + slippage)`. */
      payAmountInMax: bigint;
      /** Off-chain decrypted invoice amount in USDC (6 decimals). */
      amount: string;
      /** Uniswap v3 pool fee tier (3000 = 0.3% etc.). Ignored for same-token. */
      fee: number;
      /** SwapRouter02 address — caller passes UNISWAP_SWAP_ROUTER_02[chainId]. */
      swapRouter: `0x${string}`;
    }) => {
      if (!address || !connected) {
        toast.error("Please connect your wallet");
        return;
      }
      if (step === "approving" || step === "encrypting" || step === "sending") return;
      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }
      if (!params.amount || params.amount.trim() === "") {
        toast.error("Enter the invoice amount");
        return;
      }

      try {
        clearTimeout(resetTimerRef.current);
        setStep("approving");

        // Approve BusinessHub to pull payToken from the user. Unlike the
        // standard payInvoice which uses encrypted-vault approval, this path
        // pulls plaintext payToken directly because the swap is on a public
        // DEX. ERC-20 approve is exact (not max-uint64) — caller passes the
        // upper bound that already includes the slippage budget.
        const erc20Abi = [
          {
            type: "function",
            name: "approve",
            stateMutability: "nonpayable",
            inputs: [
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
          },
        ] as const;
        const approveTx = await unifiedWrite({
          address: params.payToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [contracts.BusinessHub as `0x${string}`, params.payAmountInMax],
          gas: BigInt(120_000),
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx, confirmations: 1 });

        setStep("encrypting");
        const expectedUsdcOut = parseUnits(params.amount, 6);
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(expectedUsdcOut)]);

        setStep("sending");
        const payResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "payInvoiceWithSwap",
          args: [
            BigInt(params.invoiceId),
            params.payToken,
            params.payAmountInMax,
            expectedUsdcOut,
            params.fee,
            params.swapRouter,
            encAmount as unknown as EncryptedInput,
          ],
          // Higher gas budget than payInvoice — adds the Uniswap swap call
          // plus an extra safeTransfer. 8M is conservative; FHE precompile
          // can't be estimated so we have to pre-set.
          gas: BigInt(8_000_000),
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

        await updateInvoiceStatus(params.invoiceId, "payment_pending");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_PAYMENT,
          contract_address: contracts.BusinessHub,
          note: `Paid invoice #${params.invoiceId} via swap`,
          token_address: params.payToken,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStepWithReset("success", 6000);
        toast.success("Invoice payment submitted via swap!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Payment failed";
        setStepWithReset("error", 5000);
        toast.error(msg);
      }
    },
    [address, connected, step, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  /**
   * Phase 5.7 — pay an invoice using a token Uniswap doesn't have a
   * pool for, via a backend-signed price quote. Caller fetches the
   * quote from /api/oracle/quote, then passes the entire quote tuple
   * + the signed bytes to this hook. Mirrors `payInvoiceWithSwap` in
   * lifecycle (approve + encrypt + send + payment-pending).
   */
  const payInvoiceWithOracleQuote = useCallback(
    async (params: {
      invoiceId: number;
      payToken: `0x${string}`;
      /** Exact amount the caller is spending in payToken (smallest unit). */
      payAmountIn: bigint;
      /** USDC base units (6 decimals) that the contract will deliver to vendor. */
      expectedUsdcOut: bigint;
      /** Quote rate × 1e6 — must match what the backend signed. */
      ratePpm: bigint;
      /** Unix seconds quote expiry. */
      expiresAt: number;
      /** 32-byte hex nonce from the backend. */
      nonce: `0x${string}`;
      /** ECDSA signature from the backend (EIP-191 prefixed digest). */
      signature: `0x${string}`;
      /** Off-chain decrypted invoice amount in USDC (mirrors `payInvoice.amount`). */
      amount: string;
    }) => {
      if (!address || !connected) {
        toast.error("Please connect your wallet");
        return;
      }
      if (step === "approving" || step === "encrypting" || step === "sending") return;
      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }
      if (!params.amount || params.amount.trim() === "") {
        toast.error("Enter the invoice amount");
        return;
      }

      try {
        clearTimeout(resetTimerRef.current);
        setStep("approving");

        // Approve BusinessHub to pull the EXACT payAmountIn — oracle
        // path is no-refund (the contract pulls and uses precisely the
        // signed amount; differential goes to the operator's payToken
        // float, which is recouped via withdrawAccumulated).
        const erc20Abi = [
          {
            type: "function",
            name: "approve",
            stateMutability: "nonpayable",
            inputs: [
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
          },
        ] as const;
        const approveTx = await unifiedWrite({
          address: params.payToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [contracts.BusinessHub as `0x${string}`, params.payAmountIn],
          gas: BigInt(120_000),
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx, confirmations: 1 });

        setStep("encrypting");
        const expectedUsdcOut = parseUnits(params.amount, 6);
        if (expectedUsdcOut !== params.expectedUsdcOut) {
          throw new Error(
            "amount mismatch — UI amount doesn't match the signed quote's expectedUsdcOut",
          );
        }
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(expectedUsdcOut)]);

        setStep("sending");
        const payResult = await unifiedWriteAndWait({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "payInvoiceWithOracleQuote",
          args: [
            BigInt(params.invoiceId),
            params.payToken,
            params.payAmountIn,
            params.expectedUsdcOut,
            params.ratePpm,
            BigInt(params.expiresAt),
            params.nonce,
            params.signature,
            encAmount as unknown as EncryptedInput,
          ],
          // Oracle path: ECDSA recover (~3k) + FHE encrypt (~3M) +
          // safeTransferFrom + safeTransfer + state writes. 8M is
          // conservative; the contract has no Uniswap dependency here
          // so most of the budget is the FHE precompile.
          gas: BigInt(8_000_000),
        });
        const hash = payResult.hash;
        const receipt = payResult.receipt
          ? payResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash,
              confirmations: 1,
              timeout: 300_000,
            });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        await updateInvoiceStatus(params.invoiceId, "payment_pending");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.INVOICE_PAYMENT,
          contract_address: contracts.BusinessHub,
          note: `Paid invoice #${params.invoiceId} via oracle-signed quote`,
          token_address: params.payToken,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStepWithReset("success", 6000);
        toast.success("Invoice payment submitted via oracle quote!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Payment failed";
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
        toastMappedError(err);
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
        toastMappedError(err);
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
        toastMappedError(err);
        setStepWithReset("error", 5000);
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, step, contracts]
  );

  const reset = useCallback(() => setStep("idle"), []);

  return { step, createInvoice, runPayroll, createEscrow, finalizeInvoice, markDelivered, approveRelease, disputeEscrow, payInvoice, payInvoiceWithSwap, payInvoiceWithOracleQuote, cancelInvoice, arbiterDecide, claimExpiredEscrow, reset };
}
