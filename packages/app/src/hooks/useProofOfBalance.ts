import { useState, useCallback } from "react";
import { usePublicClient } from "wagmi";
import { decodeEventLog } from "viem";
import toast from "react-hot-toast";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import { ProofOfBalanceAbi } from "@/lib/abis";
import { useCofheEncrypt, useCofheDecryptForTx, Encryptable } from "@/lib/cofhe-shim";
import { useFhePipeline } from "./useFhePipeline";
import { insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";

// ──────────────────────────────────────────────────────────────────
//  useProofOfBalance — Wave 5 Block 10
//
//  Prove "my balance ≥ threshold" without revealing the balance.
//  Contract: ProofOfBalance.sol on Eth + Base Sepolia.
//
//  Two flows:
//   - createProof(balanceUSDC, thresholdUSDC): encrypts the balance value
//     locally, submits createProof(InEuint64, uint64), returns proofId.
//     The encrypted balance is consumed by FHE.gte(balance, threshold) →
//     ebool. The plaintext balance never reaches the chain.
//   - revealProof(proofId): polls Threshold Network for the ebool's
//     decryption signature, then calls revealProof(id, plaintext, sig)
//     to publish the verdict on-chain. getProof().revealed flips to true.
//
//  v1 limitation (honest): the encrypted balance is supplied by the prover.
//  A future version reads vault.balanceOfHandle() directly so the prover
//  can't lie. For v1 the prover is trusted to encrypt their actual balance.
// ──────────────────────────────────────────────────────────────────

export type ProofOfBalanceStep =
  | "idle"
  | "encrypting"
  | "creating"
  | "decrypting"
  | "revealing"
  | "success"
  | "error";

export interface BalanceProofRecord {
  id: bigint;
  prover: `0x${string}`;
  thresholdMicroUSD: bigint;
  createdAt: bigint;
  revealed: boolean;
  revealedValue: boolean;
}

export function useProofOfBalance() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const { encryptInputsAsync } = useCofheEncrypt();
  const pipeline = useFhePipeline();
  const { decryptForTx } = useCofheDecryptForTx();

  const [step, setStep] = useState<ProofOfBalanceStep>("idle");
  const [error, setError] = useState<string | null>(null);

  const proofOfBalanceAddr = contracts.ProofOfBalance as `0x${string}`;

  const createProof = useCallback(
    async (balanceUSDC: number, thresholdUSDC: number): Promise<bigint | null> => {
      if (!address || !publicClient) {
        toast.error("Connect your wallet first");
        return null;
      }
      if (balanceUSDC < 0 || thresholdUSDC <= 0) {
        toast.error("Balance ≥ 0 and threshold > 0");
        return null;
      }
      if (proofOfBalanceAddr === "0x0000000000000000000000000000000000000000") {
        toast.error("ProofOfBalance not deployed on this chain");
        return null;
      }

      setStep("encrypting");
      setError(null);
      try {
        const balanceMicroUSD = BigInt(Math.round(balanceUSDC * 1_000_000));
        const thresholdMicroUSD = BigInt(Math.round(thresholdUSDC * 1_000_000));

        const [encBalance] = await encryptInputsAsync(
          [Encryptable.uint64(balanceMicroUSD)],
          pipeline.onEncryptStep,
        );

        setStep("creating");
        const result = await unifiedWriteAndWait({
          address: proofOfBalanceAddr,
          abi: ProofOfBalanceAbi,
          functionName: "createProof",
          args: [encBalance, thresholdMicroUSD],
          gas: BigInt(5_000_000),
        });

        const receipt = result.receipt
          ? result.receipt
          : await publicClient.waitForTransactionReceipt({ hash: result.hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") throw new Error("Proof creation reverted");

        let proofId: bigint | null = null;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: ProofOfBalanceAbi,
              data: log.data,
              topics: log.topics as unknown as [signature: `0x${string}`, ...args: `0x${string}`[]],
            });
            if (decoded.eventName === "ProofCreated") {
              proofId = (decoded.args as { proofId: bigint }).proofId;
              break;
            }
          } catch { /* not a ProofOfBalance log */ }
        }
        if (proofId === null) throw new Error("Proof id missing from receipt logs");

        await insertActivity({
          tx_hash: result.hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.PROOF_CREATED,
          contract_address: proofOfBalanceAddr,
          note: `Balance proof #${proofId.toString()}: ≥ $${thresholdUSDC.toLocaleString()}`,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });
        broadcastAction("activity_added");

        setStep("success");
        toast.success(`Balance proof created. ID ${proofId.toString()}`);
        return proofId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Proof creation failed";
        setStep("error");
        setError(msg);
        toast.error(msg);
        return null;
      }
    },
    [address, publicClient, contracts, encryptInputsAsync, pipeline, unifiedWriteAndWait, proofOfBalanceAddr],
  );

  const revealProof = useCallback(
    async (proofId: bigint): Promise<boolean> => {
      if (!address || !publicClient) {
        toast.error("Connect your wallet first");
        return false;
      }

      setStep("decrypting");
      setError(null);
      const toastId = toast.loading("Fetching decryption signature from Threshold Network...");
      try {
        // The proof contract publishes the ebool via FHE.allowPublic + the
        // ebool itself is stored in the proof struct as `met`. To get the
        // ctHash for TN we need to read the proof struct slot — but the
        // contract only exposes the bool result via getProof, not the
        // ctHash. So we call the proofs() public mapping getter which
        // returns the full struct including the ebool ctHash.
        const rawProof = (await publicClient.readContract({
          address: proofOfBalanceAddr,
          abi: [
            { type: "function", name: "proofs", inputs: [{ type: "uint256" }], outputs: [
              { name: "prover", type: "address" },
              { name: "thresholdMicroUSD", type: "uint64" },
              { name: "met", type: "uint256" },  // ebool ctHash
              { name: "createdAt", type: "uint64" },
              { name: "revealed", type: "bool" },
              { name: "revealedValue", type: "bool" },
            ], stateMutability: "view" },
          ],
          functionName: "proofs",
          args: [proofId],
        })) as readonly [`0x${string}`, bigint, bigint, bigint, boolean, boolean];

        const ebool = rawProof[2];
        if (!ebool || ebool === 0n) throw new Error("Proof handle missing");
        if (rawProof[4]) {
          toast.success("Already revealed", { id: toastId });
          setStep("success");
          return true;
        }

        const TIMEOUT_MS = 60_000;
        const startedAt = Date.now();
        let decrypted: { decryptedValue: bigint | boolean; signature: `0x${string}` } | null = null;
        while (Date.now() - startedAt < TIMEOUT_MS) {
          decrypted = await decryptForTx(ebool, "ebool");
          if (decrypted) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!decrypted) throw new Error("Decryption timed out — try again shortly");

        const plaintext =
          typeof decrypted.decryptedValue === "boolean"
            ? decrypted.decryptedValue
            : decrypted.decryptedValue !== 0n;

        setStep("revealing");
        toast.loading("Publishing verdict on-chain...", { id: toastId });
        const hash = await unifiedWrite({
          address: proofOfBalanceAddr,
          abi: ProofOfBalanceAbi,
          functionName: "revealProof",
          args: [proofId, plaintext, decrypted.signature],
          gas: BigInt(5_000_000),
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 3 });
        if (receipt.status === "reverted") throw new Error("Reveal reverted");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.PROOF_PUBLISHED,
          contract_address: proofOfBalanceAddr,
          note: `Balance proof #${proofId.toString()} revealed — ${plaintext ? "TRUE" : "FALSE"}`,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });
        broadcastAction("activity_added");

        toast.success(plaintext ? "Verified. Balance meets threshold." : "Verified. Balance below threshold.", { id: toastId });
        setStep("success");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Reveal failed";
        setStep("error");
        setError(msg);
        toast.error(msg, { id: toastId });
        return false;
      }
    },
    [address, publicClient, decryptForTx, unifiedWrite, contracts, proofOfBalanceAddr],
  );

  const fetchProof = useCallback(
    async (proofId: bigint): Promise<BalanceProofRecord | null> => {
      if (!publicClient) return null;
      try {
        const result = (await publicClient.readContract({
          address: proofOfBalanceAddr,
          abi: ProofOfBalanceAbi,
          functionName: "getProof",
          args: [proofId],
        })) as readonly [`0x${string}`, bigint, bigint, boolean, boolean];
        return {
          id: proofId,
          prover: result[0],
          thresholdMicroUSD: result[1],
          createdAt: result[2],
          revealed: result[3],
          revealedValue: result[4],
        };
      } catch {
        return null;
      }
    },
    [publicClient, proofOfBalanceAddr],
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
  }, []);

  return {
    step,
    error,
    createProof,
    revealProof,
    fetchProof,
    reset,
  };
}
