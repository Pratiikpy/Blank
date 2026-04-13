import { useState, useCallback } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { decodeEventLog } from "viem";
import toast from "react-hot-toast";
import { CONTRACTS } from "@/lib/constants";
import { PaymentReceiptsAbi } from "@/lib/abis";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { insertActivity } from "@/lib/supabase";

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
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { decryptForTx } = useCofheDecryptForTx();

  const [step, setStep] = useState<ProofStep>("idle");
  const [error, setError] = useState<string | null>(null);

  // Create a new "income ≥ threshold" proof on-chain. Returns proof id on success.
  const createIncomeProof = useCallback(
    async (thresholdUSDC: number): Promise<bigint | null> => {
      if (!address || !publicClient) {
        toast.error("Connect your wallet first");
        return null;
      }
      if (thresholdUSDC < 0) {
        toast.error("Threshold must be ≥ 0");
        return null;
      }

      setStep("creating");
      setError(null);
      try {
        // 6 decimals (TestUSDC) — convert to integer for uint64
        const thresholdWei = BigInt(Math.round(thresholdUSDC * 1_000_000));

        const hash = await writeContractAsync({
          address: CONTRACTS.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "proveIncomeAbove",
          args: [thresholdWei],
          gas: BigInt(5_000_000), // CoFHE: precompile breaks gas estimation
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") throw new Error("Proof creation reverted");

        // Extract proof id from ProofCreated event log
        let proofId: bigint | null = null;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: PaymentReceiptsAbi,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === "ProofCreated") {
              proofId = (decoded.args as any).proofId as bigint;
              break;
            }
          } catch {
            // log not from PaymentReceipts — skip
          }
        }
        if (proofId === null) throw new Error("Proof id missing from receipt logs");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "proof_created",
          contract_address: CONTRACTS.PaymentReceipts,
          note: `Proof #${proofId.toString()}: income ≥ $${thresholdUSDC.toLocaleString()}`,
          token_address: CONTRACTS.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

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
    [address, publicClient, writeContractAsync],
  );

  // Read the current state of a proof. Returns null if not found.
  const fetchProof = useCallback(
    async (proofId: bigint): Promise<ProofRecord | null> => {
      if (!publicClient) return null;
      try {
        const result = (await publicClient.readContract({
          address: CONTRACTS.PaymentReceipts,
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
    [publicClient],
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
          address: CONTRACTS.PaymentReceipts,
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
        const hash = await writeContractAsync({
          address: CONTRACTS.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "publishProof",
          args: [proofId, plaintext, proof.signature],
          gas: BigInt(5_000_000),
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") throw new Error("Publish reverted");

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
    [address, publicClient, decryptForTx, writeContractAsync],
  );

  // List proof ids for a given user (defaults to current account)
  const fetchProofsByUser = useCallback(
    async (user?: `0x${string}`): Promise<bigint[]> => {
      if (!publicClient) return [];
      const target = user ?? address;
      if (!target) return [];
      try {
        const ids = (await publicClient.readContract({
          address: CONTRACTS.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "getProofsByUser",
          args: [target],
        })) as bigint[];
        return ids;
      } catch {
        return [];
      }
    },
    [publicClient, address],
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
  }, []);

  return {
    step,
    error,
    createIncomeProof,
    fetchProof,
    publishProof,
    fetchProofsByUser,
    reset,
  };
}
