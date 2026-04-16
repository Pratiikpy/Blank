import { useState, useCallback } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { decodeEventLog } from "viem";
import toast from "react-hot-toast";
import { useChain } from "@/providers/ChainProvider";
import { PaymentReceiptsAbi } from "@/lib/abis";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";

// ──────────────────────────────────────────────────────────────────
//  useQualificationProof — encrypted "income ≥ X" proofs
//
//  Two flows:
//   - createIncomeProof(threshold): user signs tx to record an ebool on
//     PaymentReceipts that proves their _totalReceived >= threshold.
//     Returns the proof id (sharable as /verify/:id).
//   - publishProof(proofId): anyone can fetch the off-chain TN proof and
//     submit it on-chain so getProof() returns the verdict publicly.
//     Used by the verifier page.
//
//  The actual income amount is never revealed — only the boolean answer.
// ──────────────────────────────────────────────────────────────────

export type ProofStep = "idle" | "creating" | "decrypting" | "publishing" | "success" | "error";

export interface ProofRecord {
  id: bigint;
  prover: `0x${string}`;
  threshold: bigint;
  blockNumber: bigint;
  timestamp: bigint;
  kind: string;
  isTrue: boolean;
  isReady: boolean;
}

export function useQualificationProof() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const { decryptForTx } = useCofheDecryptForTx();

  const [step, setStep] = useState<ProofStep>("idle");
  const [error, setError] = useState<string | null>(null);

  // Internal helper used by both income + balance proof flows. Calls the
  // given write fn, waits for the receipt, extracts the proofId.
  //
  // writeFn returns `{hash, receipt?}` — the optional receipt comes from
  // the relay's server-side tx.wait() via unifiedWriteAndWait, which
  // sidesteps flaky public-RPC polling. We fall back to publicClient's
  // waitForTransactionReceipt only when the relay didn't forward one.
  const _submitProof = useCallback(
    async (
      callDescription: string,
      writeFn: () => Promise<{
        hash: `0x${string}`;
        receipt?: { blockNumber: bigint; status: "success" | "reverted"; logs: Array<{ address: `0x${string}`; topics: `0x${string}`[]; data: `0x${string}` }> };
      }>,
    ): Promise<bigint | null> => {
      if (!address || !publicClient) {
        toast.error("Connect your wallet first");
        return null;
      }
      setStep("creating");
      setError(null);
      try {
        const result = await writeFn();
        const hash = result.hash;
        const receipt = result.receipt
          ? result.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") throw new Error("Proof creation reverted");

        let proofId: bigint | null = null;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: PaymentReceiptsAbi,
              data: log.data,
              topics: log.topics as unknown as [signature: `0x${string}`, ...args: `0x${string}`[]],
            });
            if (decoded.eventName === "ProofCreated") {
              proofId = (decoded.args as any).proofId as bigint;
              break;
            }
          } catch { /* not a PaymentReceipts log */ }
        }
        if (proofId === null) throw new Error("Proof id missing from receipt logs");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.PROOF_CREATED,
          contract_address: contracts.PaymentReceipts,
          note: `Proof #${proofId.toString()}: ${callDescription}`,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");

        setStep("success");
        toast.success(`Proof created — id ${proofId.toString()}`);
        return proofId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Proof creation failed";
        setStep("error");
        setError(msg);
        toast.error(msg);
        return null;
      }
    },
    [address, publicClient, contracts],
  );

  // Create a new "income ≥ threshold" proof on-chain. Returns proof id on success.
  const createIncomeProof = useCallback(
    async (thresholdUSDC: number): Promise<bigint | null> => {
      if (thresholdUSDC < 0) {
        toast.error("Threshold must be ≥ 0");
        return null;
      }
      const thresholdWei = BigInt(Math.round(thresholdUSDC * 1_000_000));
      return _submitProof(
        `income ≥ $${thresholdUSDC.toLocaleString()}`,
        () => unifiedWriteAndWait({
          address: contracts.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "proveIncomeAbove",
          args: [thresholdWei],
          gas: BigInt(5_000_000),
        }),
      );
    },
    [unifiedWriteAndWait, _submitProof, contracts],
  );

  // Create a new "balance in vault ≥ threshold" proof. Vault defaults to USDC vault.
  const createBalanceProof = useCallback(
    async (thresholdUSDC: number, vault?: `0x${string}`): Promise<bigint | null> => {
      if (thresholdUSDC < 0) {
        toast.error("Threshold must be ≥ 0");
        return null;
      }
      const vaultAddr = vault ?? contracts.FHERC20Vault_USDC;
      const thresholdWei = BigInt(Math.round(thresholdUSDC * 1_000_000));
      return _submitProof(
        `balance ≥ $${thresholdUSDC.toLocaleString()}`,
        () => unifiedWriteAndWait({
          address: contracts.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "proveBalanceAbove",
          args: [vaultAddr, thresholdWei],
          gas: BigInt(5_000_000),
        }),
      );
    },
    [unifiedWriteAndWait, _submitProof, contracts],
  );

  // Read the current state of a proof. Returns null if not found.
  const fetchProof = useCallback(
    async (proofId: bigint): Promise<ProofRecord | null> => {
      if (!publicClient) return null;
      try {
        const result = (await publicClient.readContract({
          address: contracts.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "getProof",
          args: [proofId],
        })) as [`0x${string}`, bigint, bigint, bigint, string, boolean, boolean];
        return {
          id: proofId,
          prover: result[0],
          threshold: result[1],
          blockNumber: result[2],
          timestamp: result[3],
          kind: result[4],
          isTrue: result[5],
          isReady: result[6],
        };
      } catch {
        return null;
      }
    },
    [publicClient, contracts],
  );

  // Anyone can call this — reads the ebool handle, fetches the off-chain
  // proof from the Threshold Network, then submits it on-chain so
  // getProof().isReady becomes true.
  const publishProof = useCallback(
    async (proofId: bigint): Promise<boolean> => {
      if (!address || !publicClient) {
        toast.error("Connect your wallet first");
        return false;
      }

      setStep("decrypting");
      setError(null);
      const toastId = toast.loading("Fetching decryption proof from Threshold Network...");
      try {
        const handle = (await publicClient.readContract({
          address: contracts.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "getProofHandle",
          args: [proofId],
        })) as bigint;
        if (!handle || handle === 0n) throw new Error("Proof handle missing");

        // Poll TN for proof (~10s typical)
        const TIMEOUT_MS = 60_000;
        const startedAt = Date.now();
        let proof: { decryptedValue: bigint | boolean; signature: `0x${string}` } | null = null;
        while (Date.now() - startedAt < TIMEOUT_MS) {
          proof = await decryptForTx(handle, "ebool");
          if (proof) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!proof) throw new Error("Decryption timed out — try again shortly");

        const plaintext =
          typeof proof.decryptedValue === "boolean"
            ? proof.decryptedValue
            : proof.decryptedValue !== 0n;

        setStep("publishing");
        toast.loading("Publishing verdict on-chain...", { id: toastId });
        const hash = await unifiedWrite({
          address: contracts.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "publishProof",
          args: [proofId, plaintext, proof.signature],
          gas: BigInt(5_000_000),
        });
        // Reorg-safe verdict: wait for 3 confirmations before treating the
        // proof as "published" so a shallow reorg can't flip a TRUE verdict.
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 3 });
        if (receipt.status === "reverted") throw new Error("Publish reverted");

        // Log the publication so the publisher's feed updates. Also notify
        // the original prover (if different) so they see the verdict.
        let proverAddr: string | null = null;
        try {
          const proofRec = (await publicClient.readContract({
            address: contracts.PaymentReceipts,
            abi: PaymentReceiptsAbi,
            functionName: "getProof",
            args: [proofId],
          })) as [`0x${string}`, bigint, bigint, bigint, string, boolean, boolean];
          proverAddr = proofRec[0];
        } catch {
          // non-fatal — at minimum the publisher still gets their own row
        }

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.PROOF_PUBLISHED,
          contract_address: contracts.PaymentReceipts,
          note: `Published proof #${proofId.toString()} — ${plaintext ? "TRUE" : "FALSE"}`,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        if (proverAddr && proverAddr.toLowerCase() !== address.toLowerCase()) {
          await insertActivity({
            tx_hash: `${hash}:prover`,
            user_from: address.toLowerCase(),
            user_to: proverAddr.toLowerCase(),
            activity_type: ACTIVITY_TYPES.PROOF_PUBLISHED,
            contract_address: contracts.PaymentReceipts,
            note: `Proof #${proofId.toString()} verdict published — ${plaintext ? "TRUE" : "FALSE"}`,
            token_address: contracts.TestUSDC,
            block_number: Number(receipt.blockNumber),
          });
        }

        broadcastAction("activity_added");
        // Balances unaffected by proof publish — skip invalidateBalanceQueries

        toast.success(plaintext ? "Verified — proof holds" : "Verified — proof is false", {
          id: toastId,
        });
        setStep("success");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Verify failed";
        setStep("error");
        setError(msg);
        toast.error(msg, { id: toastId });
        return false;
      }
    },
    [address, publicClient, decryptForTx, unifiedWrite, contracts],
  );

  // List proof ids for a given user (defaults to current account)
  const fetchProofsByUser = useCallback(
    async (user?: `0x${string}`): Promise<bigint[]> => {
      if (!publicClient) return [];
      const target = user ?? address;
      if (!target) return [];
      try {
        const ids = (await publicClient.readContract({
          address: contracts.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "getProofsByUser",
          args: [target],
        })) as bigint[];
        return ids;
      } catch {
        return [];
      }
    },
    [publicClient, address, contracts],
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
  }, []);

  return {
    step,
    error,
    createIncomeProof,
    createBalanceProof,
    fetchProof,
    publishProof,
    fetchProofsByUser,
    reset,
  };
}
